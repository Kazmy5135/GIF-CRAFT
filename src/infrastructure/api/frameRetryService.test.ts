import { describe, expect, it, vi } from "vitest";
import type {
  Frame,
  GenerationJob,
  SequenceGenerationRequest,
  SequenceGenerationResult,
  SequenceJobReceipt,
  SequenceJobSnapshot,
} from "../../core/sequenceGeneration";
import { createFrameRetryService, type FullSequenceFrameRetryInput } from "./frameRetryService";
import { SequenceApiError } from "./sequenceApi";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const now = "2026-07-13T01:00:00.000Z";

function request(): SequenceGenerationRequest {
  return {
    draftId: "parent-draft",
    clientRequestId: "parent-client-request",
    provider: "gorilla_seedance",
    source: {
      id: "source-1",
      confirmedAt: "2026-07-12T01:00:00.000Z",
      contentSnapshotId: "sha256:source",
      resourceRef: "source-image:source-1",
      mimeType: "image/png",
      width: 512,
      height: 512,
      size: 8,
    },
    presetId: "character.idle.v1",
    presetVersion: 1,
    promptSnapshot: {
      layerRefs: [{ id: "game.sequence.common.v1", version: 1 }],
      userDescription: "idle",
      compiledText: "immutable compiled prompt",
    },
    requestedParameters: {
      frameCount: 2,
      frameRate: 8,
      loopMode: "loop",
      canvas: { mode: "source", aspectRatio: "1:1", width: 512, height: 512 },
      anchor: "bottom_center_feet_baseline",
      randomSeed: null,
    },
    effectiveParameters: {
      frameCount: 2,
      frameRate: 8,
      loopMode: "loop",
      canvas: { mode: "source", aspectRatio: "1:1", width: 512, height: 512 },
      anchor: "bottom_center_feet_baseline",
      randomSeed: null,
    },
    parameterMappings: [],
    providerExtensions: {
      model: "fast",
      proxyInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  };
}

function parentJob(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "parent-job",
    clientRequestId: "parent-client-request",
    provider: "gorilla_seedance",
    request: request(),
    status: "completed",
    progress: 1,
    timestamps: {
      createdAt: "2026-07-12T01:00:00.000Z",
      updatedAt: "2026-07-12T01:02:00.000Z",
      completedAt: "2026-07-12T01:02:00.000Z",
    },
    retryCount: 0,
    frameIds: ["parent-frame-0", "parent-frame-1"],
    resultIntegrity: {
      status: "complete",
      expectedFrameCount: 2,
      actualFrameCount: 2,
      issues: [],
      validatedAt: "2026-07-12T01:02:00.000Z",
    },
    ...overrides,
  };
}

function frame(index: number, overrides: Partial<Frame> = {}): Frame {
  return {
    id: `child-frame-${index}`,
    jobId: "child-job",
    providerIndex: index,
    sequenceIndex: index,
    resourceRef: PNG_DATA_URL,
    mimeType: "image/png",
    width: 512,
    height: 512,
    size: 8,
    readable: true,
    createdAt: now,
    ...overrides,
  };
}

function receipt(overrides: Partial<SequenceJobReceipt> = {}): SequenceJobReceipt {
  return {
    jobId: "child-job",
    externalJobRef: "local:child-job",
    provider: "gorilla_seedance",
    proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "submitting",
    submittedAt: now,
    ...overrides,
  };
}

function snapshot(status: SequenceJobSnapshot["status"] = "completed", overrides: Partial<SequenceJobSnapshot> = {}): SequenceJobSnapshot {
  return {
    jobId: "child-job",
    externalJobRef: "local:child-job",
    provider: "gorilla_seedance",
    proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status,
    progress: status === "completed" ? 1 : null,
    updatedAt: now,
    ...overrides,
  };
}

function result(frames: readonly Frame[] = [frame(0), frame(1)], overrides: Partial<SequenceGenerationResult> = {}): SequenceGenerationResult {
  return {
    jobId: "child-job",
    frames,
    integrity: {
      status: "complete",
      expectedFrameCount: 2,
      actualFrameCount: 2,
      issues: [],
      validatedAt: now,
    },
    ...overrides,
  };
}

function retryInput(overrides: Partial<FullSequenceFrameRetryInput> = {}): FullSequenceFrameRetryInput {
  return {
    attemptId: "attempt-1",
    draftId: "persisted-child-draft",
    clientRequestId: "persisted-child-client-request",
    parentJob: parentJob(),
    targetSequenceIndex: 1,
    sourceImageDataUrl: PNG_DATA_URL,
    capabilities: {
      provider: "gorilla_seedance",
      frameRetryMode: "full_sequence_fallback",
      proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    onReceipt: vi.fn(async () => undefined),
    ...overrides,
  };
}

function dependencyFixture(overrides: Record<string, unknown> = {}) {
  const dependencies = {
    now: vi.fn(() => now),
    submitJob: vi.fn(async () => receipt()),
    fetchJob: vi.fn(async () => snapshot()),
    fetchResult: vi.fn(async () => result()),
    sleep: vi.fn(async () => undefined),
    pollIntervalMs: 1,
    maxPollAttempts: 3,
    ...overrides,
  };
  return { dependencies };
}

describe("full-sequence frame retry fallback", () => {
  it("clones the immutable parent request, polls the child, selects the original index and safely materializes the candidate", async () => {
    const { dependencies } = dependencyFixture({
      fetchJob: vi.fn()
        .mockResolvedValueOnce(snapshot("processing"))
        .mockResolvedValueOnce(snapshot("completed")),
    });
    const service = createFrameRetryService(dependencies);
    const input = retryInput();
    const originalRequest = structuredClone(input.parentJob.request);

    const retry = await service.retry(input);

    expect(input.parentJob.request).toEqual(originalRequest);
    expect(dependencies.submitJob).toHaveBeenCalledTimes(1);
    const submitted = (dependencies.submitJob as unknown as {
      mock: { calls: [SequenceGenerationRequest, string][] };
    }).mock.calls[0]?.[0];
    expect(submitted).toBeDefined();
    if (!submitted) throw new Error("submit fixture was not called");
    expect(submitted).toMatchObject({
      draftId: "persisted-child-draft",
      clientRequestId: "persisted-child-client-request",
      provider: "gorilla_seedance",
      promptSnapshot: { compiledText: "immutable compiled prompt" },
      effectiveParameters: { frameCount: 2, frameRate: 8 },
      providerExtensions: {
        model: "fast",
        proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    expect(submitted).not.toBe(input.parentJob.request);
    expect(submitted.source).not.toBe(input.parentJob.request.source);
    expect(input.parentJob.request.providerExtensions.proxyInstanceId).toBe(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    expect(dependencies.sleep).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({
      attemptId: "attempt-1",
      executionMode: "full_sequence_fallback",
      childJobId: "child-job",
      candidateFrame: {
        id: "child-frame-1",
        sequenceIndex: 1,
        resourceRef: "workspace-frame-resource:child-job:child-frame-1",
      },
    });
    expect(retry.candidateBlob).toBeInstanceOf(Blob);
    expect(retry.candidateBlob.type).toBe("image/png");
    expect(retry.candidateBlob.size).toBe(8);
  });

  it("shares one in-flight submission for the same attempt and returns the memoized candidate", async () => {
    const { dependencies } = dependencyFixture();
    const service = createFrameRetryService(dependencies);
    const input = retryInput();

    const [first, second] = await Promise.all([service.retry(input), service.retry(input)]);
    const third = await service.retry(input);

    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(dependencies.submitJob).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchResult).toHaveBeenCalledTimes(1);
  });

  it("persists the submit receipt before the first query", async () => {
    const events: string[] = [];
    const onReceipt = vi.fn(async (value) => {
      events.push(`receipt:${value.childJobId}`);
    });
    const { dependencies } = dependencyFixture({
      submitJob: vi.fn(async () => {
        events.push("submit");
        return receipt();
      }),
      fetchJob: vi.fn(async () => {
        events.push("query");
        return snapshot("completed");
      }),
    });
    const service = createFrameRetryService(dependencies);

    await service.retry(retryInput({ onReceipt }));

    expect(events).toEqual(["submit", "receipt:child-job", "query"]);
    expect(onReceipt).toHaveBeenCalledWith({
      childJobId: "child-job",
      externalJobRef: "local:child-job",
      submittedAt: now,
    });
  });

  it("stops before every query when receipt persistence fails", async () => {
    const onReceipt = vi.fn().mockRejectedValue(new Error("IndexedDB failed"));
    const { dependencies } = dependencyFixture();
    const service = createFrameRetryService(dependencies);
    const input = retryInput({ onReceipt });

    await expect(service.retry(input)).rejects.toMatchObject({
      code: "status_unknown",
      childJobId: "child-job",
      recoveryAction: "reconcile",
    });
    await expect(service.retry(input)).rejects.toMatchObject({ code: "status_unknown" });

    expect(dependencies.submitJob).toHaveBeenCalledTimes(1);
    expect(onReceipt).toHaveBeenCalledTimes(2);
    expect(dependencies.fetchJob).not.toHaveBeenCalled();
    expect(dependencies.fetchResult).not.toHaveBeenCalled();
  });

  it("never resubmits status_unknown and can later reconcile the existing child job", async () => {
    const fetchJob = vi.fn()
      .mockResolvedValueOnce(snapshot("status_unknown"))
      .mockResolvedValueOnce(snapshot("completed"));
    const { dependencies } = dependencyFixture({ fetchJob });
    const service = createFrameRetryService(dependencies);
    const input = retryInput();

    await expect(service.retry(input)).rejects.toMatchObject({
      code: "status_unknown",
      recoveryAction: "reconcile",
      childJobId: "child-job",
    });
    await expect(service.retry(input)).resolves.toMatchObject({ childJobId: "child-job" });
    expect(dependencies.submitJob).toHaveBeenCalledTimes(1);
    expect(fetchJob).toHaveBeenCalledTimes(2);
  });

  it("restores a persisted unknown attempt after refresh by querying only the existing child job", async () => {
    const firstFetchJob = vi.fn().mockResolvedValue(snapshot("status_unknown"));
    const firstFixture = dependencyFixture({ fetchJob: firstFetchJob });
    const firstService = createFrameRetryService(firstFixture.dependencies);
    const input = retryInput();

    await expect(firstService.retry(input)).rejects.toMatchObject({
      code: "status_unknown",
      childJobId: "child-job",
    });
    expect(firstFixture.dependencies.submitJob).toHaveBeenCalledTimes(1);

    // Simulate a page refresh: a fresh service has no in-memory idempotency entry.
    const restoredSubmit = vi.fn(async () => {
      throw new Error("reconcile must never submit");
    });
    const restoredFixture = dependencyFixture({
      submitJob: restoredSubmit,
      fetchJob: vi.fn().mockResolvedValue(snapshot("completed")),
    });
    const restoredService = createFrameRetryService(restoredFixture.dependencies);
    const restored = await restoredService.reconcile({
      attemptId: input.attemptId,
      parentJob: input.parentJob,
      targetSequenceIndex: input.targetSequenceIndex,
      capabilities: input.capabilities,
      childJobId: "child-job",
    });

    expect(restored).toMatchObject({
      attemptId: "attempt-1",
      childJobId: "child-job",
      executionMode: "full_sequence_fallback",
      candidateFrame: { sequenceIndex: 1 },
    });
    expect(restored).not.toHaveProperty("childRequest");
    expect(restoredSubmit).not.toHaveBeenCalled();
  });

  it("uses the current proxy identity when reconciling a historical parent task", async () => {
    const currentProxy = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const historicalProxy = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const validFixture = dependencyFixture({
      submitJob: vi.fn(async () => {
        throw new Error("reconcile must not submit");
      }),
      fetchJob: vi.fn().mockResolvedValue(snapshot("completed", { proxyInstanceId: currentProxy })),
    });
    const validService = createFrameRetryService(validFixture.dependencies);
    const input = retryInput();

    await expect(validService.reconcile({
      attemptId: input.attemptId,
      parentJob: input.parentJob,
      targetSequenceIndex: input.targetSequenceIndex,
      capabilities: input.capabilities,
      childJobId: "child-job",
    })).resolves.toMatchObject({ childJobId: "child-job" });
    expect(input.parentJob.request.providerExtensions.proxyInstanceId).toBe(historicalProxy);

    const staleFixture = dependencyFixture({
      fetchJob: vi.fn().mockResolvedValue(snapshot("completed", { proxyInstanceId: historicalProxy })),
    });
    const staleService = createFrameRetryService(staleFixture.dependencies);
    await expect(staleService.reconcile({
      attemptId: input.attemptId,
      parentJob: input.parentJob,
      targetSequenceIndex: input.targetSequenceIndex,
      capabilities: input.capabilities,
      childJobId: "child-job",
    })).rejects.toMatchObject({ code: "status_unknown", childJobId: "child-job" });
    expect(staleFixture.dependencies.fetchResult).not.toHaveBeenCalled();
  });

  it("memoizes an ambiguous submit with no child ID instead of creating a second remote task", async () => {
    const submitJob = vi.fn().mockRejectedValue(
      new SequenceApiError("truncated response", "status_unknown", undefined, false, "reconcile"),
    );
    const { dependencies } = dependencyFixture({ submitJob });
    const service = createFrameRetryService(dependencies);
    const input = retryInput();

    await expect(service.retry(input)).rejects.toMatchObject({ code: "status_unknown", childJobId: undefined });
    await expect(service.retry(input)).rejects.toMatchObject({ code: "status_unknown", childJobId: undefined });
    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchJob).not.toHaveBeenCalled();
  });

  it("keeps definitive child failure terminal for the same idempotency key", async () => {
    const fetchJob = vi.fn().mockResolvedValue(snapshot("failed", {
      error: { code: "rate_limited", message: "quota", retryable: true, recoveryAction: "retry" },
    }));
    const { dependencies } = dependencyFixture({ fetchJob });
    const service = createFrameRetryService(dependencies);
    const input = retryInput();

    await expect(service.retry(input)).rejects.toMatchObject({
      code: "child_job_failed",
      recoveryAction: "retry",
      childJobId: "child-job",
    });
    await expect(service.retry(input)).rejects.toMatchObject({ code: "child_job_failed" });
    expect(dependencies.submitJob).toHaveBeenCalledTimes(1);
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong result job", result(undefined, { jobId: "other-child" }), "invalid_result"],
    ["wrong original index", result([frame(0), frame(1, { sequenceIndex: 2 })]), "invalid_result"],
    ["incomplete remote integrity", result(undefined, { integrity: { status: "incomplete", expectedFrameCount: 2, actualFrameCount: 1, issues: [] } }), "invalid_result"],
    ["contradictory remote integrity", result(undefined, { integrity: { status: "complete", expectedFrameCount: 2, actualFrameCount: 2, issues: [{ code: "invalid_resource", message: "bad" }] } }), "invalid_result"],
    ["bad data resource", result([frame(0), frame(1, { resourceRef: "data:image/png;base64,AAAAAAAAAAA=" })]), "invalid_candidate_resource"],
  ] as const)("rejects %s without exposing an unusable candidate", async (_label, remoteResult, code) => {
    const { dependencies } = dependencyFixture({ fetchResult: vi.fn().mockResolvedValue(remoteResult) });
    const service = createFrameRetryService(dependencies);

    await expect(service.retry(retryInput())).rejects.toMatchObject({ code, childJobId: "child-job" });
  });

  it("rejects unsupported capability, invalid parent/target/source and reused attempt IDs before another submit", async () => {
    const { dependencies } = dependencyFixture();
    const service = createFrameRetryService(dependencies);

    await expect(service.retry(retryInput({ capabilities: { provider: "gorilla_seedance", frameRetryMode: "unsupported", proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }))).rejects.toMatchObject({ code: "capability_unsupported" });
    await expect(service.retry(retryInput({ attemptId: "bad-parent", parentJob: parentJob({ status: "failed" }) }))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.retry(retryInput({ attemptId: "bad-index", targetSequenceIndex: 2 }))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.retry(retryInput({ attemptId: "bad-source", sourceImageDataUrl: "data:text/plain;base64,SGk=" }))).rejects.toMatchObject({ code: "invalid_candidate_resource" });

    const input = retryInput();
    await service.retry(input);
    await expect(service.retry({ ...input, targetSequenceIndex: 0 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.retry({ ...input, clientRequestId: "different-client" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.retry({ ...input, capabilities: { ...input.capabilities, proxyInstanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } })).rejects.toMatchObject({ code: "invalid_request" });
    expect(dependencies.submitJob).toHaveBeenCalledTimes(1);
  });
});
