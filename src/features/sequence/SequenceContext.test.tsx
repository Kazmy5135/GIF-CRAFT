import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Frame,
  GenerationJob,
  SequenceGenerationRequest,
  SequenceGenerationResult,
} from "../../core/sequenceGeneration";
import type { SourceImageAsset } from "../../core/sourceImage";
import {
  SequenceProvider,
  useSequenceGeneration,
  type SequenceDependencies,
} from "./SequenceContext";
import { SequenceApiError } from "../../infrastructure/api/sequenceApi";

afterEach(() => cleanup());

const source: SourceImageAsset = {
  id: "source-old",
  jobId: "source-job",
  provider: "local",
  model: "local",
  mode: "local_upload",
  createdAt: "2026-07-11T10:00:00.000Z",
  confirmedAt: "2026-07-11T10:01:00.000Z",
  contentSnapshotId: `sha256:${"a".repeat(64)}`,
  dataUrl: "data:image/png;base64,AA==",
  mimeType: "image/png",
  width: 512,
  height: 512,
  size: 1,
  availability: "available",
  promptSnapshot: { userPrompt: "", basePrompt: "", negativePrompt: "", compiledPrompt: "", templateVersion: 1 },
  effectiveParameters: { aspectRatio: "1:1", quality: "standard", providerSize: "512x512" },
};

function generationRequest(): SequenceGenerationRequest {
  return {
    draftId: "draft-1",
    clientRequestId: "11111111-1111-4111-8111-111111111111",
    provider: "gorilla_seedance",
    source: {
      id: source.id,
      confirmedAt: source.confirmedAt!,
      contentSnapshotId: source.contentSnapshotId!,
      resourceRef: `source-image:${source.id}`,
      mimeType: source.mimeType,
      width: source.width!,
      height: source.height!,
      size: source.size!,
    },
    presetId: "character.idle.v1",
    presetVersion: 1,
    promptSnapshot: {
      layerRefs: [
        { id: "game.sequence.common.v1", version: 1 },
        { id: "game.sequence.character.v1", version: 1 },
        { id: "game.sequence.character.idle.v1", version: 1 },
        { id: "game.sequence.negative.v1", version: 1 },
      ],
      userDescription: "idle",
      compiledText: "idle",
    },
    requestedParameters: {
      frameCount: 8,
      frameRate: 8,
      loopMode: "loop",
      canvas: { mode: "source", aspectRatio: "1:1", width: 512, height: 512 },
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
    parameterMappings: [
      { field: "canvas.width", requested: 512, effective: 480, reason: "provider" },
      { field: "canvas.height", requested: 512, effective: 480, reason: "provider" },
    ],
    providerExtensions: { proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  };
}

function generationJob(status: GenerationJob["status"], overrides: Partial<GenerationJob> = {}): GenerationJob {
  const request = generationRequest();
  return {
    id: request.draftId,
    clientRequestId: request.clientRequestId,
    provider: request.provider,
    request,
    status,
    progress: null,
    stage: status,
    timestamps: { createdAt: "2026-07-11T10:02:00.000Z", updatedAt: "2026-07-11T10:03:00.000Z" },
    retryCount: 0,
    frameIds: [],
    resultIntegrity: { status: "pending", expectedFrameCount: 8, actualFrameCount: 0, issues: [] },
    ...overrides,
  };
}

function frame(index: number): Frame {
  return {
    id: `server-job:frame:${index}`,
    jobId: "server-job",
    providerIndex: index,
    sequenceIndex: index,
    resourceRef: `data:image/png;base64,frame-${index}`,
    mimeType: "image/png",
    width: 480,
    height: 480,
    size: 1,
    readable: true,
    createdAt: "2026-07-11T10:04:00.000Z",
  };
}

function completedResult(): SequenceGenerationResult {
  const frames = Array.from({ length: 8 }, (_, index) => frame(index));
  return {
    jobId: "server-job",
    frames,
    integrity: { status: "complete", expectedFrameCount: 8, actualFrameCount: 8, issues: [] },
  };
}

function dependencyFixture(overrides: Partial<SequenceDependencies> = {}) {
  const saved: GenerationJob[] = [];
  const dependencies = {
    fetchProviders: vi.fn().mockResolvedValue([{
      provider: "gorilla_seedance",
      proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      configured: true,
      model: "seedance",
      supportsImageToSequence: true,
      supportsAsyncQuery: false,
      supportsLocalJobQuery: true,
      supportsCancellation: false,
      supportsRandomSeed: false,
      supportsRealProgress: false,
      inputMimeTypes: ["image/png"], frameCounts: [8, 12], frameRates: [8, 12],
      aspectRatios: ["1:1"], providerDurationSeconds: [4], providerResolutions: ["480p"],
      outputMimeTypes: ["video/mp4"], outputShape: "video", canNormalizeLosslessly: false,
    }]),
    submitJob: vi.fn().mockResolvedValue({
      jobId: "server-job",
      externalJobRef: "local:server-job",
      provider: "gorilla_seedance",
      proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "submitting",
      submittedAt: "2026-07-11T10:03:00.000Z",
    }),
    fetchJob: vi.fn().mockResolvedValue({
      jobId: "server-job",
      externalJobRef: "local:server-job",
      provider: "gorilla_seedance",
      proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "generating",
      progress: null,
      stage: "provider_generation",
      updatedAt: "2026-07-11T10:04:00.000Z",
    }),
    fetchResult: vi.fn().mockResolvedValue(completedResult()),
    listJobs: vi.fn().mockResolvedValue([]),
    listFrames: vi.fn().mockResolvedValue([]),
    saveJob: vi.fn(async (record: { job: GenerationJob }) => { saved.push(record.job); }),
    saveCompletedResult: vi.fn().mockResolvedValue(undefined),
    checkCapacity: vi.fn().mockResolvedValue({ allowed: true, requiredBytes: 8, hardLimitBytes: 1_000 }),
    cleanupStorage: vi.fn().mockResolvedValue({ deletedJobIds: [], purgedJobIds: [], deletedFrameIds: [], bytesBefore: 0, bytesAfter: 0 }),
    getSourceImage: vi.fn().mockResolvedValue(source),
    now: vi.fn(() => "2026-07-11T10:02:00.000Z"),
    createId: vi.fn().mockReturnValueOnce("draft-2").mockReturnValueOnce("22222222-2222-4222-8222-222222222222"),
    pollIntervalMs: 100_000,
    maxPollingWindowMs: 15 * 60_000,
    hiddenPollMultiplier: 4,
    random: () => 0.5,
    materializeFrame: vi.fn(async (item: Frame) => ({
      frame: { ...item, resourceRef: `frame-resource:${item.id}` },
      blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
    })),
    ...overrides,
  } as unknown as SequenceDependencies;
  return { dependencies, saved };
}

function Harness() {
  const context = useSequenceGeneration();
  return (
    <div>
      <span data-testid="status">{context.currentJob?.status ?? "none"}</span>
      <span data-testid="stage">{context.currentJob?.stage ?? "none"}</span>
      <span data-testid="frames">{context.frames.length}</span>
      <span data-testid="storage-status">{context.resultStorageStatus ?? "none"}</span>
      <span role="alert">{context.error}</span>
      <button type="button" onClick={() => { void context.submit(generationRequest(), source.dataUrl).catch(() => undefined); void context.submit(generationRequest(), source.dataUrl).catch(() => undefined); }}>submit twice</button>
      <button type="button" onClick={() => void context.reconcile()}>reconcile</button>
      <button type="button" onClick={() => { void context.reconcile(); void context.reconcile(); }}>reconcile twice</button>
      <button type="button" onClick={() => void context.retryFailed()}>retry</button>
      <button type="button" onClick={() => void context.abandonTracking()}>abandon</button>
    </div>
  );
}

function renderContext(dependencies: SequenceDependencies) {
  return render(<SequenceProvider dependencies={dependencies}><Harness /></SequenceProvider>);
}

describe("SequenceContext reliability", () => {
  it("persists submitting input before POST and suppresses an active double submit", async () => {
    let resolveReceipt!: (value: unknown) => void;
    const receipt = new Promise((resolve) => { resolveReceipt = resolve; });
    const { dependencies, saved } = dependencyFixture({ submitJob: vi.fn(() => receipt) as never });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("none"));

    fireEvent.click(screen.getByRole("button", { name: "submit twice" }));
    await waitFor(() => expect(dependencies.submitJob).toHaveBeenCalledTimes(1));
    expect(saved[0]).toMatchObject({ status: "submitting", clientRequestId: generationRequest().clientRequestId });
    expect(saved[0].externalJobRef).toBeUndefined();

    resolveReceipt({
      jobId: "server-job",
      externalJobRef: "local:server-job",
      provider: "gorilla_seedance",
      proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "submitting",
      submittedAt: "2026-07-11T10:03:00.000Z",
    });
    await waitFor(() => expect(saved.at(-1)?.recovery?.queryCursor).toBe("server-job"));
  });

  it("keeps the same client id after a lost receipt and reconciles idempotently", async () => {
    const submitJob = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValueOnce({
        jobId: "server-job",
        externalJobRef: "local:server-job",
        provider: "gorilla_seedance",
        proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "submitting",
        submittedAt: "2026-07-11T10:03:00.000Z",
      });
    const { dependencies, saved } = dependencyFixture({ submitJob });
    renderContext(dependencies);
    fireEvent.click(screen.getByRole("button", { name: "submit twice" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("status_unknown"));
    expect(saved.at(-1)?.request.clientRequestId).toBe(generationRequest().clientRequestId);

    fireEvent.click(screen.getByRole("button", { name: "reconcile" }));
    await waitFor(() => expect(submitJob).toHaveBeenCalledTimes(2));
    expect(submitJob.mock.calls[1][0].clientRequestId).toBe(generationRequest().clientRequestId);
    expect(submitJob.mock.calls[1][1]).toBe(source.dataUrl);
  });

  it("restores an active task after refresh and continues querying", async () => {
    const restored = generationJob("submitting", { recovery: { canQuery: true, queryCursor: "server-job" } });
    const { dependencies } = dependencyFixture({
      listJobs: vi.fn().mockResolvedValue([{ job: restored }]),
      pollIntervalMs: 1,
    });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("generating"));
    expect(dependencies.fetchJob).toHaveBeenCalledWith("server-job");
  });

  it("retries a failed parent with its historical source bytes after current source changes", async () => {
    const parent = generationJob("failed", {
      lastError: { code: "request_failed", message: "failed", retryable: true, recoveryAction: "retry" },
    });
    const { dependencies } = dependencyFixture({ listJobs: vi.fn().mockResolvedValue([{ job: parent }]) });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("failed"));
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(dependencies.submitJob).toHaveBeenCalledTimes(1));
    expect(dependencies.getSourceImage).toHaveBeenCalledWith("source-old");
    expect(vi.mocked(dependencies.submitJob).mock.calls[0][1]).toBe(source.dataUrl);
  });

  it("materializes result blobs and persists only a complete local handoff", async () => {
    const restored = generationJob("processing", { recovery: { canQuery: true, queryCursor: "server-job" } });
    const { dependencies } = dependencyFixture({
      listJobs: vi.fn().mockResolvedValue([{ job: restored }]),
      fetchJob: vi.fn().mockResolvedValue({
        jobId: "server-job", externalJobRef: "local:server-job", provider: "gorilla_seedance", proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "completed", progress: null, updatedAt: "2026-07-11T10:05:00.000Z",
      }),
    });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("processing"));
    fireEvent.click(screen.getByRole("button", { name: "reconcile" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("completed"));
    expect(screen.getByTestId("stage")).toHaveTextContent("completed");
    expect(dependencies.materializeFrame).toHaveBeenCalledTimes(8);
    expect(dependencies.saveCompletedResult).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("frames")).toHaveTextContent("8");
  });

  it("keeps completed provider metadata recoverable when local quota blocks frame storage", async () => {
    const restored = generationJob("processing", { recovery: { canQuery: true, queryCursor: "server-job" } });
    const { dependencies } = dependencyFixture({
      listJobs: vi.fn().mockResolvedValue([{ job: restored }]),
      fetchJob: vi.fn().mockResolvedValue({
        jobId: "server-job", externalJobRef: "local:server-job", provider: "gorilla_seedance", proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "completed", progress: null, updatedAt: "2026-07-11T10:05:00.000Z",
      }),
      checkCapacity: vi.fn().mockResolvedValue({ allowed: false, reason: "managed_budget_exceeded", requiredBytes: 8, hardLimitBytes: 1 }),
    });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("processing"));
    fireEvent.click(screen.getByRole("button", { name: "reconcile" }));
    await waitFor(() => expect(screen.getByTestId("stage")).toHaveTextContent("storage_failed"));
    expect(dependencies.saveCompletedResult).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("本地空间不足");
  });

  it("restores purged result metadata without exposing frame handoff resources", async () => {
    const completed = generationJob("completed", {
      frameIds: ["frame-0"],
      resultIntegrity: { status: "complete", expectedFrameCount: 1, actualFrameCount: 1, issues: [] },
    });
    const { dependencies } = dependencyFixture({
      listJobs: vi.fn().mockResolvedValue([{ job: completed, resultStorageStatus: "purged" }]),
    });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("storage-status")).toHaveTextContent("purged"));
    expect(screen.getByTestId("frames")).toHaveTextContent("0");
    expect(dependencies.listFrames).not.toHaveBeenCalled();
  });

  it("revalidates restored completed frames and blocks a damaged handoff", async () => {
    const completed = generationJob("completed", {
      frameIds: ["frame-0"],
      resultIntegrity: { status: "complete", expectedFrameCount: 8, actualFrameCount: 8, issues: [] },
    });
    const damagedFrame = { ...frame(0), id: "frame-0", jobId: completed.id, resourceRef: "frame-resource:frame-0" };
    const { dependencies } = dependencyFixture({
      listJobs: vi.fn().mockResolvedValue([{ job: completed, resultStorageStatus: "available" }]),
      listFrames: vi.fn().mockResolvedValue([{
        id: damagedFrame.id, jobId: completed.id, sequenceIndex: 0,
        createdAt: damagedFrame.createdAt, frame: damagedFrame,
        blob: new Blob([new Uint8Array([1, 2])], { type: "image/png" }), size: 2,
      }]),
    });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("storage-status")).toHaveTextContent("invalid"));
    expect(screen.getByTestId("frames")).toHaveTextContent("0");
    expect(screen.getByRole("alert")).toHaveTextContent("已损坏或不完整");
  });

  it("never resubmits a no-cursor task after the proxy instance changes", async () => {
    const restored = generationJob("status_unknown");
    const { dependencies } = dependencyFixture({
      listJobs: vi.fn().mockResolvedValue([{ job: restored }]),
      fetchProviders: vi.fn().mockResolvedValue([{
        ...(await dependencyFixture().dependencies.fetchProviders())[0],
        proxyInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }]),
    });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("status_unknown"));
    fireEvent.click(screen.getByRole("button", { name: "reconcile" }));
    await waitFor(() => expect(screen.getByTestId("stage")).toHaveTextContent("proxy_instance_changed"));
    expect(dependencies.submitJob).not.toHaveBeenCalled();
  });

  it("serializes reconciliation and discards a late response after tracking is abandoned", async () => {
    let resolveSnapshot!: (value: unknown) => void;
    const fetchJob = vi.fn(() => new Promise((resolve) => { resolveSnapshot = resolve; }));
    const restored = generationJob("status_unknown", { recovery: { canQuery: true, queryCursor: "server-job" } });
    const { dependencies } = dependencyFixture({ listJobs: vi.fn().mockResolvedValue([{ job: restored }]), fetchJob: fetchJob as never });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("status_unknown"));
    fireEvent.click(screen.getByRole("button", { name: "reconcile twice" }));
    await waitFor(() => expect(fetchJob).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "abandon" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("abandoned"));
    resolveSnapshot({
      jobId: "server-job", externalJobRef: "local:server-job", provider: "gorilla_seedance",
      proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "generating", progress: null, updatedAt: "2026-07-11T10:05:00.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("status")).toHaveTextContent("abandoned");
    fireEvent.click(screen.getByRole("button", { name: "submit twice" }));
    await waitFor(() => expect(dependencies.submitJob).toHaveBeenCalledTimes(1));
  });

  it("keeps polling after a transient query error", async () => {
    const restored = generationJob("submitting", { recovery: { canQuery: true, queryCursor: "server-job" } });
    const fetchJob = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue({
        jobId: "server-job", externalJobRef: "local:server-job", provider: "gorilla_seedance",
        proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "generating", progress: null, stage: "provider_generation", updatedAt: "2026-07-11T10:05:00.000Z",
      });
    const { dependencies } = dependencyFixture({
      listJobs: vi.fn().mockResolvedValue([{ job: restored }]), fetchJob, pollIntervalMs: 1,
    });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("generating"));
    expect(fetchJob.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts a failed snapshot with partial_result and exposes its retry policy", async () => {
    const restored = generationJob("generating", { recovery: { canQuery: true, queryCursor: "server-job" } });
    const { dependencies } = dependencyFixture({
      listJobs: vi.fn().mockResolvedValue([{ job: restored }]),
      fetchJob: vi.fn().mockResolvedValue({
        jobId: "server-job",
        externalJobRef: "local:server-job",
        provider: "gorilla_seedance",
        proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "failed",
        progress: null,
        updatedAt: "2026-07-12T00:00:00.000Z",
        error: {
          code: "partial_result",
          message: "只生成了部分帧。",
          retryable: true,
          recoveryAction: "retry",
        },
      }),
    });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("generating"));
    fireEvent.click(screen.getByRole("button", { name: "reconcile" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("failed"));
    expect(screen.getByRole("alert")).toHaveTextContent("只生成了部分帧");
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(dependencies.submitJob).toHaveBeenCalledTimes(1));
  });

  it("does not misclassify a remote unknown result as a local storage failure", async () => {
    const restored = generationJob("processing", { recovery: { canQuery: true, queryCursor: "server-job" } });
    const { dependencies } = dependencyFixture({
      listJobs: vi.fn().mockResolvedValue([{ job: restored }]),
      fetchJob: vi.fn().mockResolvedValue({
        jobId: "server-job", externalJobRef: "local:server-job", provider: "gorilla_seedance",
        proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "completed", progress: null, updatedAt: "2026-07-11T10:05:00.000Z",
      }),
      fetchResult: vi.fn().mockRejectedValue(new SequenceApiError("missing", "status_unknown", 404, false, "reconcile")),
    });
    renderContext(dependencies);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("processing"));
    fireEvent.click(screen.getByRole("button", { name: "reconcile" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("status_unknown"));
    expect(screen.getByTestId("stage")).toHaveTextContent("result_status_unknown");
  });
});
