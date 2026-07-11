import { afterEach, describe, expect, it, vi } from "vitest";
import type { SequenceGenerationRequest } from "../../src/core/sequenceGeneration";
import {
  executeGorillaSequence,
  getSequenceProviderCapabilities,
} from "./sequence";

const previousMcpUrl = process.env.MCP_SERVER_URL;
const previousMcpToken = process.env.MCP_AUTH_TOKEN;

afterEach(() => {
  if (previousMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
  else process.env.MCP_SERVER_URL = previousMcpUrl;
  if (previousMcpToken === undefined) delete process.env.MCP_AUTH_TOKEN;
  else process.env.MCP_AUTH_TOKEN = previousMcpToken;
  vi.restoreAllMocks();
});

function request(): SequenceGenerationRequest {
  return {
    draftId: "draft-1",
    clientRequestId: "1e4afad2-0ea2-4cf7-97de-8e3b6bf0884d",
    provider: "gorilla_seedance",
    source: {
      id: "source-1",
      confirmedAt: "2026-07-11T12:00:00.000Z",
      contentSnapshotId: "sha256:6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      resourceRef: "source-image:source-1",
      mimeType: "image/png",
      width: 480,
      height: 480,
      size: 1,
    },
    presetId: "character.attack.v1",
    presetVersion: 1,
    promptSnapshot: {
      layerRefs: [],
      userDescription: "attack",
      compiledText: "attack once",
    },
    requestedParameters: {
      frameCount: 8,
      frameRate: 12,
      loopMode: "once",
      canvas: { mode: "source", aspectRatio: "1:1", width: 480, height: 480 },
      anchor: "bottom_center_feet_baseline",
      randomSeed: null,
    },
    effectiveParameters: {
      frameCount: 8,
      frameRate: 12,
      loopMode: "once",
      canvas: { mode: "source", aspectRatio: "1:1", width: 480, height: 480 },
      anchor: "bottom_center_feet_baseline",
      randomSeed: null,
    },
    parameterMappings: [],
    providerExtensions: {
      model: "standard",
      proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  };
}

describe("Gorilla sequence provider", () => {
  it("reports unavailable when ffmpeg capability is missing", () => {
    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    process.env.MCP_AUTH_TOKEN = "configured-for-test";
    expect(
      getSequenceProviderCapabilities({
        available: false,
        ffmpegPath: "missing-ffmpeg",
        ffprobePath: "missing-ffprobe",
        reason: "ffmpeg is unavailable",
      }),
    ).toMatchObject({
      configured: false,
      supportsCancellation: false,
      supportsAsyncQuery: false,
      supportsLocalJobQuery: true,
      outputShape: "video",
      canNormalizeLosslessly: false,
      unavailabilityReason: "ffmpeg is unavailable",
    });
  });

  it("uploads transient bytes, generates video, and returns a complete ordered frame set", async () => {
    const generateVideo = vi.fn(async () => ({
      model: "bytedance/doubao-seedance-2-0",
      remoteUrl: "https://canvas.example.test/assets/result.mp4",
    }));
    const frames = Array.from({ length: 8 }, (_, sequenceIndex) => ({
      id: `job-1:frame:${sequenceIndex}`,
      jobId: "job-1",
      providerIndex: sequenceIndex,
      sequenceIndex,
      resourceRef: "data:image/png;base64,AA==",
      mimeType: "image/png" as const,
      width: 480,
      height: 480,
      size: 1,
      providerTimestamp: sequenceIndex / 2,
      createdAt: "2026-07-11T12:00:01.000Z",
    }));
    const normalizeVideo = vi.fn(async () => ({
      frames,
      probe: {
        codec: "h264" as const,
        width: 480,
        height: 480,
        durationSeconds: 4,
        size: 1024,
      },
    }));
    const update = vi.fn();
    const result = await executeGorillaSequence(
      request(),
      "data:image/png;base64,AA==",
      { jobId: "job-1", update },
      { generateVideo, normalizeVideo },
    );
    expect(generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "attack once",
        model: "standard",
        loop: false,
        referenceImage: expect.objectContaining({ data: "AA==", size: 1 }),
      }),
    );
    expect(normalizeVideo).toHaveBeenCalledWith(
      "https://canvas.example.test/assets/result.mp4",
      8,
      "job-1",
    );
    expect(update.mock.calls).toEqual([
      ["generating", "provider_generation"],
      ["processing", "video_normalization"],
    ]);
    expect(result.integrity.status).toBe("complete");
    expect(result.frames).toHaveLength(8);
  });

  it("rejects effective parameters that conceal provider mapping", async () => {
    const invalid = request();
    const generateVideo = vi.fn();
    await expect(
      executeGorillaSequence(
        {
          ...invalid,
          effectiveParameters: {
            ...invalid.effectiveParameters,
            canvas: { mode: "source", aspectRatio: "1:1", width: 1024, height: 1024 },
          },
        },
        "data:image/png;base64,AA==",
        { jobId: "job-1", update: vi.fn() },
        { generateVideo },
      ),
    ).rejects.toThrow(/provider capabilities/i);
    expect(generateVideo).not.toHaveBeenCalled();
  });
});
