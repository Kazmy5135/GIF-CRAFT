import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFfmpegFrameArguments,
  detectSequenceMediaCapability,
  downloadAllowedMcpMp4,
  normalizeSequenceVideo,
  parseSequenceVideoProbe,
  type SequenceCommandRunner,
} from "./sequenceMedia";

const execFileAsync = promisify(execFile);

const previousServerUrl = process.env.MCP_SERVER_URL;

afterEach(() => {
  if (previousServerUrl === undefined) delete process.env.MCP_SERVER_URL;
  else process.env.MCP_SERVER_URL = previousServerUrl;
  delete process.env.MCP_ASSET_HOSTS;
});

describe("sequence video normalization", () => {
  it("validates a square four-second H.264 probe", () => {
    expect(
      parseSequenceVideoProbe(
        JSON.stringify({
          streams: [
            {
              codec_name: "h264",
              codec_type: "video",
              width: 480,
              height: 480,
              avg_frame_rate: "24/1",
            },
          ],
          format: { duration: "4.000000", size: "4096" },
        }),
        4096,
      ),
    ).toMatchObject({
      codec: "h264",
      width: 480,
      height: 480,
      durationSeconds: 4,
      sourceFrameRate: "24/1",
    });
  });

  it("rejects a non-H.264 or non-square provider result", () => {
    expect(() =>
      parseSequenceVideoProbe(
        JSON.stringify({
          streams: [{ codec_name: "vp9", codec_type: "video", width: 480, height: 480 }],
          format: { duration: "4", size: "100" },
        }),
        100,
      ),
    ).toThrow(/H\.264/);
    expect(() =>
      parseSequenceVideoProbe(
        JSON.stringify({
          streams: [{ codec_name: "h264", codec_type: "video", width: 640, height: 480 }],
          format: { duration: "4", size: "100" },
        }),
        100,
      ),
    ).toThrow(/square canvas/);
  });

  it("builds a video-only command with a strict frame cap", () => {
    const args = buildFfmpegFrameArguments("input.mp4", "frame-%03d.png", 12, 4);
    expect(args).toContain("-an");
    expect(args).toContain("12");
    expect(args.join(" ")).toContain("fps=12/4.000000");
    expect(args.join(" ")).toContain("round=near:start_time=0");
    expect(args.join(" ")).not.toContain("trim=");
    expect(args.join(" ")).toContain("scale=480:480");
  });

  it("returns stable ordered PNG frames through injected media tools", async () => {
    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]);
    const fetcher = async () =>
      new Response(mp4, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": String(mp4.length) },
      });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const commandRunner: SequenceCommandRunner = async (command, args) => {
      if (command === "ffprobe-test") {
        return {
          stdout: JSON.stringify({
            streams: [
              {
                codec_name: "h264",
                codec_type: "video",
                width: 480,
                height: 480,
                avg_frame_rate: "24/1",
              },
            ],
            format: { duration: "4", size: String(mp4.length) },
          }),
          stderr: "",
        };
      }
      const pattern = args.at(-1) as string;
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          writeFile(pattern.replace("%03d", String(index + 1).padStart(3, "0")), png),
        ),
      );
      return { stdout: "", stderr: "" };
    };

    const result = await normalizeSequenceVideo(
      "https://canvas.example.test/assets/result.mp4",
      8,
      "job-1",
      {
        fetcher: fetcher as typeof fetch,
        commandRunner,
        capability: {
          available: true,
          ffmpegPath: "ffmpeg-test",
          ffprobePath: "ffprobe-test",
        },
      },
    );
    expect(result.frames).toHaveLength(8);
    expect(result.frames[0]).toMatchObject({
      id: "job-1:frame:0",
      providerIndex: 0,
      sequenceIndex: 0,
      mimeType: "image/png",
      width: 480,
      height: 480,
    });
    expect(result.frames[0].providerTimestamp).toBe(0);
    expect(result.frames[7].providerTimestamp).toBe(3.5);
  });

  it("extracts exactly 8 and 12 frames from a real 4.096-second 24fps H.264 video", async () => {
    const capability = detectSequenceMediaCapability();
    expect(capability.available, capability.reason).toBe(true);
    if (!capability.available) return;

    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    const directory = await mkdtemp(path.join(tmpdir(), "sequence-real-ffmpeg-test-"));
    const videoOnlyPath = path.join(directory, "video-only.mp4");
    const audioOnlyPath = path.join(directory, "audio-only.m4a");
    const fixturePath = path.join(directory, "provider-4.096.mp4");
    try {
      await execFileAsync(
        capability.ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=480x480:rate=24",
          "-frames:v",
          "97",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-y",
          videoOnlyPath,
        ],
        { timeout: 120_000, windowsHide: true },
      );
      await execFileAsync(
        capability.ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=48000:cl=stereo",
          "-t",
          "4.096",
          "-c:a",
          "aac",
          "-y",
          audioOnlyPath,
        ],
        { timeout: 120_000, windowsHide: true },
      );
      await execFileAsync(
        capability.ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          videoOnlyPath,
          "-i",
          audioOnlyPath,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c",
          "copy",
          "-y",
          fixturePath,
        ],
        { timeout: 120_000, windowsHide: true },
      );

      const fixture = await readFile(fixturePath);
      const fetcher = (async () =>
        new Response(fixture, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-length": String(fixture.length),
          },
        })) as typeof fetch;

      for (const frameCount of [8, 12] as const) {
        const result = await normalizeSequenceVideo(
          "https://canvas.example.test/assets/provider-4.096.mp4",
          frameCount,
          `real-ffmpeg-${frameCount}`,
          { capability, fetcher },
        );
        expect(result.probe).toMatchObject({
          codec: "h264",
          durationSeconds: 4.096,
          sourceFrameRate: "24/1",
        });
        expect(result.frames).toHaveLength(frameCount);
        expect(result.frames[0].providerTimestamp).toBe(0);
        expect(result.frames.at(-1)?.providerTimestamp).toBeCloseTo(
          (4.096 * (frameCount - 1)) / frameCount,
          6,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("follows only allowlisted redirects and rejects a non-MP4 MIME", async () => {
    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    const directory = await mkdtemp(path.join(tmpdir(), "sequence-download-test-"));
    const destination = path.join(directory, "video.mp4");
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]);
    let calls = 0;
    const redirectFetcher = async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 302, headers: { location: "/assets/final.mp4" } })
        : new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } });
    };
    try {
      await expect(
        downloadAllowedMcpMp4(
          "https://canvas.example.test/assets/start.mp4",
          destination,
          redirectFetcher as typeof fetch,
        ),
      ).resolves.toBe(mp4.length);
      expect(calls).toBe(2);
      await expect(
        downloadAllowedMcpMp4(
          "https://canvas.example.test/assets/not-video.mp4",
          destination,
          (async () =>
            new Response(mp4, {
              status: 200,
              headers: { "content-type": "image/png" },
            })) as typeof fetch,
        ),
      ).rejects.toThrow(/non-MP4/i);
      await expect(
        downloadAllowedMcpMp4(
          "https://canvas.example.test/assets/start.mp4",
          destination,
          (async () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://evil.example/result.mp4" },
            })) as typeof fetch,
        ),
      ).rejects.toThrow(/outside the allowlist/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels a streaming download immediately after the byte limit", async () => {
    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    const directory = await mkdtemp(path.join(tmpdir(), "sequence-stream-test-"));
    const destination = path.join(directory, "video.mp4");
    let cancelled = false;
    const firstChunk = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(4)]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstChunk);
        controller.enqueue(Buffer.alloc(12));
      },
      cancel() {
        cancelled = true;
      },
    });
    try {
      await expect(
        downloadAllowedMcpMp4(
          "https://canvas.example.test/assets/result.mp4",
          destination,
          (async () =>
            new Response(stream, {
              status: 200,
              headers: { "content-type": "video/mp4" },
            })) as typeof fetch,
          { maxBytes: 16 },
        ),
      ).rejects.toThrow(/exceeds the 64 MB limit/i);
      expect(cancelled).toBe(true);
      await expect(access(destination)).rejects.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes its temporary directory after probe failure", async () => {
    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]);
    let capturedVideoPath = "";
    await expect(
      normalizeSequenceVideo(
        "https://canvas.example.test/assets/result.mp4",
        8,
        "job-cleanup",
        {
          fetcher: (async () =>
            new Response(mp4, {
              status: 200,
              headers: { "content-type": "video/mp4" },
            })) as typeof fetch,
          capability: {
            available: true,
            ffmpegPath: "ffmpeg-test",
            ffprobePath: "ffprobe-test",
          },
          commandRunner: async (_command, args) => {
            capturedVideoPath = args.at(-1) as string;
            return { stdout: "not-json", stderr: "" };
          },
        },
      ),
    ).rejects.toThrow(/invalid JSON/i);
    expect(capturedVideoPath).not.toBe("");
    await expect(access(path.dirname(capturedVideoPath))).rejects.toBeDefined();
  });

  it("cancels the response reader when opening the destination fails", async () => {
    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    const directory = await mkdtemp(path.join(tmpdir(), "sequence-write-fail-test-"));
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]));
      },
      cancel() {
        cancelled = true;
      },
    });
    try {
      await expect(
        downloadAllowedMcpMp4(
          "https://canvas.example.test/assets/result.mp4",
          directory,
          (async () =>
            new Response(stream, {
              status: 200,
              headers: { "content-type": "video/mp4" },
            })) as typeof fetch,
        ),
      ).rejects.toThrow(/temporary storage/i);
      expect(cancelled).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
