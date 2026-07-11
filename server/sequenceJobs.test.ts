import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  SequenceGenerationRequest,
  SequenceGenerationResult,
} from "../src/core/sequenceGeneration";
import { ProviderRequestError } from "./providers/types";
import {
  SequenceJobConflictError,
  SequenceJobRateLimitError,
  SequenceJobService,
  fingerprintSequenceRequest,
} from "./sequenceJobs";

function request(overrides: Partial<SequenceGenerationRequest> = {}): SequenceGenerationRequest {
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
    presetId: "character.idle.v1",
    presetVersion: 1,
    promptSnapshot: {
      layerRefs: [{ id: "game.sequence.common.v1", version: 1 }],
      userDescription: "breathe",
      compiledText: "idle loop",
    },
    requestedParameters: {
      frameCount: 8,
      frameRate: 8,
      loopMode: "loop",
      canvas: { mode: "source", aspectRatio: "1:1", width: 480, height: 480 },
      anchor: "bottom_center_feet_baseline",
      randomSeed: null,
    },
    effectiveParameters: {
      frameCount: 8,
      frameRate: 8,
      loopMode: "loop",
      canvas: { mode: "source", aspectRatio: "1:1", width: 480, height: 480 },
      anchor: "bottom_center_feet_baseline",
      randomSeed: null,
    },
    parameterMappings: [],
    providerExtensions: {
      proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    ...overrides,
  };
}

function successfulResult(jobId: string): SequenceGenerationResult {
  const frames = Array.from({ length: 8 }, (_, sequenceIndex) => ({
    id: `${jobId}:frame:${sequenceIndex}`,
    jobId,
    providerIndex: sequenceIndex,
    sequenceIndex,
    resourceRef: "data:image/png;base64,AA==",
    mimeType: "image/png",
    width: 480,
    height: 480,
    size: 1,
    readable: true,
    createdAt: "2026-07-11T12:00:01.000Z",
  }));
  return {
    jobId,
    frames,
    integrity: {
      status: "complete",
      expectedFrameCount: 8,
      actualFrameCount: 8,
      issues: [],
      validatedAt: "2026-07-11T12:00:01.000Z",
    },
  };
}

async function flushJob(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SequenceJobService", () => {
  it("uses a stable canonical request fingerprint", () => {
    const original = request();
    const reordered = { ...original, source: { ...original.source } };
    expect(fingerprintSequenceRequest(original)).toBe(fingerprintSequenceRequest(reordered));
  });

  it("returns one receipt for an idempotent client request", async () => {
    const execute = vi.fn(async (_request, _sourceImageDataUrl, context) =>
      successfulResult(context.jobId),
    );
    const service = new SequenceJobService(execute);
    const first = service.create(request(), "data:image/png;base64,AA==");
    const second = service.create(request(), "data:image/png;base64,AA==");
    expect(second).toEqual(first);
    expect(first.proxyInstanceId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await flushJob();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot(first.jobId)).toMatchObject({
      status: "completed",
      proxyInstanceId: first.proxyInstanceId,
    });
    expect(service.getResult(first.jobId)?.jobId).toBe(first.jobId);
  });

  it("allows the same active client ID but rate-limits a different active task", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const service = new SequenceJobService(async (_request, _bytes, context) => {
      await gate;
      return successfulResult(context.jobId);
    });
    const firstRequest = request();
    const receipt = service.create(firstRequest, "data:image/png;base64,AA==");
    expect(service.create(firstRequest, "data:image/png;base64,AA==")).toEqual(receipt);
    expect(() =>
      service.create(
        request({ clientRequestId: randomUUID(), draftId: "draft-other" }),
        "data:image/png;base64,AA==",
      ),
    ).toThrow(SequenceJobRateLimitError);
    finish();
    await flushJob();
  });

  it("rejects reuse of a client ID for different parameters", () => {
    const service = new SequenceJobService(async (_request, _sourceImageDataUrl, context) =>
      successfulResult(context.jobId),
    );
    service.create(request(), "data:image/png;base64,AA==");
    expect(() =>
      service.create(
        request({
          promptSnapshot: {
            ...request().promptSnapshot,
            compiledText: "different prompt",
          },
        }),
        "data:image/png;base64,AA==",
      ),
    ).toThrow(SequenceJobConflictError);
  });

  it("preserves timeout as status_unknown instead of failed", async () => {
    const service = new SequenceJobService(async () => {
      throw new ProviderRequestError("timed out", true);
    });
    const receipt = service.create(request(), "data:image/png;base64,AA==");
    await flushJob();
    expect(service.getSnapshot(receipt.jobId)).toMatchObject({
      status: "status_unknown",
      stage: "reconciliation_required",
      error: { code: "timeout_unknown", retryable: false, recoveryAction: "reconcile" },
    });
  });

  it("retains idempotency tombstones after more than 50 terminal jobs are evicted", async () => {
    const execute = vi.fn(async (_request, _bytes, context) => successfulResult(context.jobId));
    const service = new SequenceJobService(execute);
    const requests = Array.from({ length: 51 }, (_, index) =>
      request({ draftId: `draft-${index}`, clientRequestId: randomUUID() }),
    );
    const firstReceipt = service.create(requests[0], "data:image/png;base64,AA==");
    for (const item of requests.slice(1)) {
      await flushJob();
      service.create(item, "data:image/png;base64,AA==");
    }
    await flushJob();
    const repeated = service.create(requests[0], "data:image/png;base64,AA==");
    expect(repeated).toEqual(firstReceipt);
    expect(execute).toHaveBeenCalledTimes(51);
  });

  it("rejects regressive stages and invalid completion payloads", async () => {
    const regressive = new SequenceJobService(async (_request, _bytes, context) => {
      context.update("processing", "video_normalization");
      context.update("generating", "regression");
      return successfulResult(context.jobId);
    });
    const regressiveReceipt = regressive.create(request(), "data:image/png;base64,AA==");
    await flushJob();
    expect(regressive.getSnapshot(regressiveReceipt.jobId)).toMatchObject({
      status: "failed",
      error: { code: "invalid_result", retryable: false, recoveryAction: "none" },
    });

    const invalidCompletion = new SequenceJobService(async () => successfulResult("wrong-job"));
    const invalidReceipt = invalidCompletion.create(request(), "data:image/png;base64,AA==");
    await flushJob();
    expect(invalidCompletion.getSnapshot(invalidReceipt.jobId)).toMatchObject({
      status: "failed",
      error: { code: "invalid_result", retryable: false },
    });
  });

  it.each(["duplicate-id", "job-mismatch"] as const)(
    "rejects executor frames with %s",
    async (variant) => {
      const service = new SequenceJobService(async (_request, _bytes, context) => {
        const valid = successfulResult(context.jobId);
        const frames = valid.frames.map((frame) => ({ ...frame }));
        if (variant === "duplicate-id") frames[1] = { ...frames[1], id: frames[0].id };
        else frames[1] = { ...frames[1], jobId: "different-job" };
        return { ...valid, frames };
      });
      const receipt = service.create(request(), "data:image/png;base64,AA==");
      await flushJob();
      expect(service.getSnapshot(receipt.jobId)).toMatchObject({
        status: "failed",
        error: { code: "invalid_result", retryable: false },
      });
    },
  );

  it("evicts cached results by byte budget and TTL without storing source bytes", async () => {
    let now = 0;
    const execute = vi.fn(async (_request, _bytes, context) => successfulResult(context.jobId));
    const service = new SequenceJobService({
      execute,
      nowMs: () => now,
      resultCacheBytes: 8,
      resultTtlMs: 30 * 60_000,
    });
    const firstRequest = request();
    const first = service.create(firstRequest, "data:image/png;base64,AA==");
    await flushJob();
    now += 1;
    const second = service.create(
      request({ clientRequestId: randomUUID(), draftId: "draft-second" }),
      "data:image/png;base64,AQ==",
    );
    await flushJob();
    expect(service.getResult(first.jobId)).toBeUndefined();
    expect(service.getResult(second.jobId)).toBeDefined();
    now += 30 * 60_000 + 1;
    expect(service.getResult(second.jobId)).toBeUndefined();
    expect(JSON.stringify(service.getSnapshot(second.jobId))).not.toContain("base64");
  });

  it("bounds tombstones by count and TTL", async () => {
    let now = 0;
    const service = new SequenceJobService({
      execute: async (_request, _bytes, context) => successfulResult(context.jobId),
      nowMs: () => now,
      tombstoneLimit: 2,
      tombstoneTtlMs: 100,
    });
    const firstRequest = request();
    const first = service.create(firstRequest, "data:image/png;base64,AA==");
    await flushJob();
    for (let index = 0; index < 2; index += 1) {
      now += 1;
      service.create(
        request({ clientRequestId: randomUUID(), draftId: `bounded-${index}` }),
        "data:image/png;base64,AA==",
      );
      await flushJob();
    }
    const afterCountEviction = service.create(firstRequest, "data:image/png;base64,AA==");
    expect(afterCountEviction.jobId).not.toBe(first.jobId);
    await flushJob();
    now += 101;
    const afterTtl = service.create(firstRequest, "data:image/png;base64,AA==");
    expect(afterTtl.jobId).not.toBe(afterCountEviction.jobId);
  });

  it.each([
    ["authentication", "authentication_failed", false],
    ["rate_limit", "rate_limited", true],
    ["partial_result", "partial_result", false],
  ] as const)("maps %s provider errors", async (kind, code, retryable) => {
    const service = new SequenceJobService(async () => {
      throw new ProviderRequestError(kind, { kind, retryable });
    });
    const receipt = service.create(request(), "data:image/png;base64,AA==");
    await flushJob();
    expect(service.getSnapshot(receipt.jobId)).toMatchObject({
      status: "failed",
      error: { code, retryable },
    });
  });
});
