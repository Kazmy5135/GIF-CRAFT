import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveAllowedMcpAssetUrl } from "./mcp.js";
import { ProviderRequestError } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const OUTPUT_SIZE = 480;

export interface SequenceMediaCapability {
  available: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  reason?: string;
}

export interface SequenceVideoProbe {
  codec: "h264";
  width: number;
  height: number;
  durationSeconds: number;
  size: number;
  sourceFrameRate?: string;
}

export interface ExtractedSequenceFrame {
  id: string;
  jobId: string;
  providerIndex: number;
  sequenceIndex: number;
  resourceRef: string;
  mimeType: "image/png";
  width: number;
  height: number;
  size: number;
  providerTimestamp: number;
  createdAt: string;
}

export interface NormalizedSequenceMedia {
  frames: ExtractedSequenceFrame[];
  probe: SequenceVideoProbe;
}

export type SequenceCommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

function mediaToolPaths(): { ffmpegPath: string; ffprobePath: string } {
  return {
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH?.trim() || "ffprobe",
  };
}

export function detectSequenceMediaCapability(): SequenceMediaCapability {
  const paths = mediaToolPaths();
  for (const [label, executable] of [
    ["ffmpeg", paths.ffmpegPath],
    ["ffprobe", paths.ffprobePath],
  ] as const) {
    const result = spawnSync(executable, ["-version"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 3_000,
    });
    if (result.error || result.status !== 0) {
      return {
        ...paths,
        available: false,
        reason: `${label} is unavailable. Configure ${label === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"} or PATH.`,
      };
    }
  }
  return { ...paths, available: true };
}

async function defaultCommandRunner(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

export async function downloadAllowedMcpMp4(
  remoteUrl: string,
  destination: string,
  fetcher: typeof fetch = fetch,
  options: { maxBytes?: number } = {},
): Promise<number> {
  const maxBytes = Math.min(options.maxBytes || MAX_VIDEO_BYTES, MAX_VIDEO_BYTES);
  let currentUrl = resolveAllowedMcpAssetUrl(remoteUrl);
  if (!currentUrl) throw new ProviderRequestError("Sequence video URL is outside the allowlist.");

  let response: Response | undefined;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    response = await fetcher(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if (!isRedirect(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirectCount === MAX_REDIRECTS) {
      throw new ProviderRequestError("Sequence video redirected too many times.");
    }
    const nextUrl = resolveAllowedMcpAssetUrl(new URL(location, currentUrl).href);
    if (!nextUrl) {
      throw new ProviderRequestError("Sequence video redirected outside the allowlist.");
    }
    currentUrl = nextUrl;
  }

  if (!response?.ok) throw new ProviderRequestError("Sequence video could not be downloaded.");
  if (!resolveAllowedMcpAssetUrl(response.url || currentUrl)) {
    throw new ProviderRequestError("Sequence video response URL is outside the allowlist.");
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mimeType !== "video/mp4") {
    throw new ProviderRequestError("Sequence provider returned a non-MP4 resource.");
  }
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxBytes) {
    throw new ProviderRequestError("Sequence video exceeds the 64 MB limit.");
  }
  if (!response.body) throw new ProviderRequestError("Sequence video response has no body.");

  const reader = response.body.getReader();
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(destination, "w");
  } catch {
    await reader.cancel("sequence video destination could not be opened").catch(() => undefined);
    throw new ProviderRequestError("Sequence video could not be written to temporary storage.", {
      kind: "invalid_result",
      retryable: false,
    });
  }
  let totalBytes = 0;
  let signatureBytes = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("sequence video size limit exceeded").catch(() => undefined);
        throw new ProviderRequestError("Sequence video is empty or exceeds the 64 MB limit.");
      }
      if (signatureBytes.length < 12) {
        signatureBytes = Buffer.concat([
          signatureBytes,
          Buffer.from(value.subarray(0, 12 - signatureBytes.length)),
        ]);
      }
      await file.write(value);
    }
    const hasMp4Signature =
      signatureBytes.length >= 12 && signatureBytes.subarray(4, 8).toString("ascii") === "ftyp";
    if (totalBytes === 0 || !hasMp4Signature) {
      throw new ProviderRequestError("Sequence resource is not a valid MP4 file.");
    }
    return totalBytes;
  } catch (error) {
    await reader.cancel("sequence video download aborted").catch(() => undefined);
    await file.close().catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await file.close().catch(() => undefined);
  }
}

interface RawProbePayload {
  streams?: Array<{
    codec_name?: string;
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    duration?: string;
  }>;
  format?: { duration?: string; size?: string };
}

export function parseSequenceVideoProbe(raw: string, downloadedSize: number): SequenceVideoProbe {
  let payload: RawProbePayload;
  try {
    payload = JSON.parse(raw) as RawProbePayload;
  } catch {
    throw new ProviderRequestError("ffprobe returned invalid JSON.");
  }
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  if (!video || video.codec_name !== "h264") {
    throw new ProviderRequestError("Sequence video must contain an H.264 video stream.");
  }
  const width = Number(video.width);
  const height = Number(video.height);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 64 ||
    height < 64 ||
    width > 2_048 ||
    height > 2_048 ||
    width !== height
  ) {
    throw new ProviderRequestError("Sequence video must use a supported square canvas.");
  }
  const durationSeconds = Number(payload.format?.duration || video.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 3.5 || durationSeconds > 4.5) {
    throw new ProviderRequestError("Sequence video duration is outside the expected 4-second range.");
  }
  const reportedSize = Number(payload.format?.size || downloadedSize);
  const size = Math.max(downloadedSize, Number.isFinite(reportedSize) ? reportedSize : 0);
  if (size <= 0 || size > MAX_VIDEO_BYTES) {
    throw new ProviderRequestError("Sequence video size is invalid or exceeds the limit.");
  }
  return {
    codec: "h264",
    width,
    height,
    durationSeconds,
    size,
    sourceFrameRate: video.avg_frame_rate || undefined,
  };
}

export function buildFfprobeArguments(videoPath: string): string[] {
  return [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=codec_name,codec_type,width,height,avg_frame_rate,duration",
    "-of",
    "json",
    videoPath,
  ];
}

export function buildFfmpegFrameArguments(
  videoPath: string,
  outputPattern: string,
  frameCount: 8 | 12,
  durationSeconds: number,
): string[] {
  const samplingRate = `${frameCount}/${durationSeconds.toFixed(6)}`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `fps=${samplingRate}:round=near:start_time=0,scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:flags=lanczos`,
    "-frames:v",
    String(frameCount),
    "-compression_level",
    "6",
    "-y",
    outputPattern,
  ];
}

function isPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  );
}

export async function normalizeSequenceVideo(
  remoteUrl: string,
  frameCount: 8 | 12,
  jobId: string,
  dependencies: {
    commandRunner?: SequenceCommandRunner;
    fetcher?: typeof fetch;
    capability?: SequenceMediaCapability;
  } = {},
): Promise<NormalizedSequenceMedia> {
  const capability = dependencies.capability || detectSequenceMediaCapability();
  if (!capability.available) {
    throw new ProviderRequestError(capability.reason || "ffmpeg/ffprobe is unavailable.");
  }
  const commandRunner = dependencies.commandRunner || defaultCommandRunner;
  const workDirectory = await mkdtemp(path.join(tmpdir(), "gif-craft-sequence-"));
  const videoPath = path.join(workDirectory, "provider.mp4");
  const outputPattern = path.join(workDirectory, "frame-%03d.png");

  try {
    const downloadedSize = await downloadAllowedMcpMp4(
      remoteUrl,
      videoPath,
      dependencies.fetcher,
    );
    const probeResult = await commandRunner(
      capability.ffprobePath,
      buildFfprobeArguments(videoPath),
    );
    const probe = parseSequenceVideoProbe(probeResult.stdout, downloadedSize);
    await commandRunner(
      capability.ffmpegPath,
      buildFfmpegFrameArguments(videoPath, outputPattern, frameCount, probe.durationSeconds),
    );

    const frameNames = (await readdir(workDirectory))
      .filter((name) => /^frame-\d{3}\.png$/.test(name))
      .sort();
    if (frameNames.length !== frameCount) {
      throw new ProviderRequestError(
        `ffmpeg returned ${frameNames.length} frames; ${frameCount} were required.`,
        { kind: "partial_result", retryable: false },
      );
    }

    const createdAt = new Date().toISOString();
    let totalFrameBytes = 0;
    const frames: ExtractedSequenceFrame[] = [];
    for (const [sequenceIndex, frameName] of frameNames.entries()) {
      const bytes = await readFile(path.join(workDirectory, frameName));
      if (!isPng(bytes) || bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) {
        throw new ProviderRequestError("ffmpeg returned an invalid or oversized PNG frame.");
      }
      totalFrameBytes += bytes.length;
      if (totalFrameBytes > MAX_TOTAL_FRAME_BYTES) {
        throw new ProviderRequestError("Extracted sequence frames exceed the 64 MB limit.");
      }
      frames.push({
        id: `${jobId}:frame:${sequenceIndex}`,
        jobId,
        providerIndex: sequenceIndex,
        sequenceIndex,
        resourceRef: `data:image/png;base64,${bytes.toString("base64")}`,
        mimeType: "image/png",
        width: OUTPUT_SIZE,
        height: OUTPUT_SIZE,
        size: bytes.length,
        // The fps filter samples on a zero-based grid. This timestamp records
        // that target point on the provider timeline, not the source frame's
        // potentially quantized presentation timestamp.
        providerTimestamp: (probe.durationSeconds * sequenceIndex) / frameCount,
        createdAt,
      });
    }
    return { frames, probe };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}
