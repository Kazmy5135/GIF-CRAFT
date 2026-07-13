import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFrameWorkspace,
  setFrameWorkspaceFrameRate,
  setFrameDecision,
  type FrameRetryAttempt,
  registerFrameRetryAttempt,
  transitionWorkspaceRetryAttempt,
  type FrameWorkspace,
} from "../../core/frameWorkspace";
import {
  createFrameWorkspaceHandoff,
  type Frame,
  type GenerationJob,
  type SequenceGenerationRequest,
} from "../../core/sequenceGeneration";
import { FrameRetryServiceError } from "../../infrastructure/api/frameRetryService";
import { frameWorkspaceStorageRecord } from "../../infrastructure/storage/frameWorkspaceRepository";
import type { StoredFrameResource, StoredGenerationJob } from "../../infrastructure/storage/sequenceJobRepository";
import { createDefaultWorkspaceAdapter } from "./defaultWorkspaceAdapter";
import type { WorkspaceView } from "./workspaceAdapter";

const mocks = vi.hoisted(() => ({
  fetchProviders: vi.fn(),
  retry: vi.fn(),
  reconcile: vi.fn(),
  getGenerationJob: vi.fn(),
  listGenerationJobs: vi.fn(),
  listFrameResources: vi.fn(),
  getWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  listCandidates: vi.fn(),
  saveCandidate: vi.fn(),
  adoptCandidate: vi.fn(),
  saveSnapshot: vi.fn(),
  getSource: vi.fn(),
}));

vi.mock("../../infrastructure/api/sequenceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/api/sequenceApi")>()),
  fetchSequenceProviders: mocks.fetchProviders,
}));

vi.mock("../../infrastructure/api/frameRetryService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/api/frameRetryService")>()),
  createFrameRetryService: () => ({ retry: mocks.retry, reconcile: mocks.reconcile, forget: vi.fn() }),
}));

vi.mock("../../infrastructure/storage/sequenceJobRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/storage/sequenceJobRepository")>()),
  getGenerationJob: mocks.getGenerationJob,
  listGenerationJobs: mocks.listGenerationJobs,
  listFrameResources: mocks.listFrameResources,
}));

vi.mock("../../infrastructure/storage/frameWorkspaceRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/storage/frameWorkspaceRepository")>()),
  getFrameWorkspaceByJobId: mocks.getWorkspace,
  createFrameWorkspace: mocks.createWorkspace,
  saveFrameWorkspace: mocks.saveWorkspace,
  listWorkspaceFrameResources: mocks.listCandidates,
  saveWorkspaceFrameResource: mocks.saveCandidate,
  adoptWorkspaceFrameResource: mocks.adoptCandidate,
  saveFrameWorkspaceSnapshot: mocks.saveSnapshot,
}));

vi.mock("../../infrastructure/storage/sourceImageRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/storage/sourceImageRepository")>()),
  getSourceImage: mocks.getSource,
}));

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const now = "2026-07-13T01:00:00.000Z";

function request(): SequenceGenerationRequest {
  return {
    draftId: "job-1",
    clientRequestId: "parent-client",
    provider: "gorilla_seedance",
    source: { id: "source-1", confirmedAt: now, contentSnapshotId: "sha256:source", resourceRef: "source-image:source-1", mimeType: "image/png", width: 64, height: 64, size: 8 },
    presetId: "character.idle.v1",
    presetVersion: 1,
    promptSnapshot: { layerRefs: [{ id: "game.sequence.common.v1", version: 1 }], userDescription: "idle", compiledText: "compiled" },
    requestedParameters: { frameCount: 2, frameRate: 8, loopMode: "loop", canvas: { mode: "source", aspectRatio: "1:1", width: 64, height: 64 }, anchor: "bottom_center_feet_baseline", randomSeed: null },
    effectiveParameters: { frameCount: 2, frameRate: 8, loopMode: "loop", canvas: { mode: "source", aspectRatio: "1:1", width: 64, height: 64 }, anchor: "bottom_center_feet_baseline", randomSeed: null },
    parameterMappings: [],
    providerExtensions: { proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  };
}

function job(): GenerationJob {
  return {
    id: "job-1",
    clientRequestId: "parent-client",
    provider: "gorilla_seedance",
    request: request(),
    status: "completed",
    progress: 1,
    timestamps: { createdAt: now, updatedAt: now, completedAt: now },
    retryCount: 0,
    frameIds: ["frame-0", "frame-1"],
    resultIntegrity: { status: "complete", expectedFrameCount: 2, actualFrameCount: 2, issues: [], validatedAt: now },
  };
}

function frame(index: number): Frame {
  return { id: `frame-${index}`, jobId: "job-1", providerIndex: index, sequenceIndex: index, resourceRef: `frame-resource:frame-${index}`, mimeType: "image/png", width: 64, height: 64, size: 8, readable: true, createdAt: now };
}

const frames = [frame(0), frame(1)];
const resources: StoredFrameResource<Frame>[] = frames.map((item) => ({ id: item.id, jobId: item.jobId, sequenceIndex: item.sequenceIndex, createdAt: item.createdAt, frame: item, blob: new Blob([PNG_BYTES], { type: "image/png" }), size: 8 }));

function initialDomain(): FrameWorkspace {
  return createFrameWorkspace({ workspaceId: "workspace-1", handoff: createFrameWorkspaceHandoff(job(), frames), createdAt: now });
}

function jobRecord(): StoredGenerationJob<GenerationJob> {
  return { id: "job-1", clientRequestId: "parent-client", sourceImageId: "source-1", provider: "gorilla_seedance", status: "completed", createdAt: now, updatedAt: now, resultStorageStatus: "available", resultBytes: 16, job: job() };
}

function configure(domain = initialDomain()) {
  mocks.fetchProviders.mockResolvedValue([{ provider: "gorilla_seedance", frameRetryMode: "full_sequence_fallback", proxyInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]);
  mocks.getGenerationJob.mockResolvedValue(jobRecord());
  mocks.listGenerationJobs.mockResolvedValue([jobRecord()]);
  mocks.listFrameResources.mockResolvedValue(resources);
  mocks.getWorkspace.mockResolvedValue(frameWorkspaceStorageRecord(domain));
  mocks.listCandidates.mockResolvedValue([]);
  mocks.getSource.mockResolvedValue({ id: "source-1", createdAt: now, dataUrl: PNG_DATA_URL, mimeType: "image/png", size: 8, contentSnapshotId: "sha256:source", availability: "available" });
  mocks.retry.mockImplementation(async (input: { onReceipt: (receipt: { childJobId: string; submittedAt: string }) => Promise<void> }) => {
    await input.onReceipt({ childJobId: "child-job", submittedAt: now });
    return { attemptId: "attempt", executionMode: "full_sequence_fallback", childJobId: "child-job", candidateFrame: { ...frame(0), id: "child-frame-0", jobId: "child-job", resourceRef: "workspace-frame-resource:child-job:child-frame-0" }, candidateBlob: new Blob([PNG_BYTES], { type: "image/png" }) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64, close: vi.fn() })));
  configure();
});

describe("default frame workspace retry adapter", () => {
  it("暴露重做来源上下文，并通过统一命令非破坏性修改和保存播放 FPS", async () => {
    const adapter = createDefaultWorkspaceAdapter();
    const loaded = await adapter.loadOrCreate("job-1");

    expect(loaded).toMatchObject({
      jobId: "job-1",
      sourceJobId: "job-1",
      sourceImageId: "source-1",
      sourceFrameRate: 8,
      playbackFrameRate: 8,
      frameRate: 8,
    });

    const edited = adapter.apply(loaded, { type: "set_frame_rate", frameRate: 12 });
    expect(edited).toMatchObject({ playbackFrameRate: 12, frameRate: 12, sourceFrameRate: 8, revision: 1 });
    const saved = await adapter.save(edited, loaded.persistedRevision);
    expect(saved.persistedRevision).toBe(1);
    expect(mocks.saveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 1,
        workspace: expect.objectContaining({ playbackFrameRate: 12, source: expect.objectContaining({ frameRate: 8 }) }),
      }),
      0,
    );
  });

  it("旧 v4 工作区缺少覆盖字段时默认使用来源 FPS", async () => {
    const domain = initialDomain();
    const { playbackFrameRate: _legacyMissingField, ...legacyDomain } = domain;
    mocks.getWorkspace.mockResolvedValue({
      ...frameWorkspaceStorageRecord(domain),
      workspace: legacyDomain,
    });

    const loaded = await createDefaultWorkspaceAdapter().loadOrCreate("job-1");

    expect(loaded).toMatchObject({ sourceFrameRate: 8, playbackFrameRate: 8, frameRate: 8 });
    expect((loaded.opaque as { domain: FrameWorkspace }).domain).toMatchObject({ playbackFrameRate: 8, revision: 0 });
  });

  it("注册并持久化重试，安全落盘候选后支持接受与恢复原版", async () => {
    const adapter = createDefaultWorkspaceAdapter();
    const loaded = await adapter.loadOrCreate("job-1");
    const candidate = await adapter.requestRetry(loaded, "slot:frame-0");

    expect(mocks.retry).toHaveBeenCalledTimes(1);
    const retryInput = mocks.retry.mock.calls[0][0] as { attemptId: string; draftId: string; clientRequestId: string; capabilities: { proxyInstanceId: string } };
    expect(retryInput.draftId).toBe(retryInput.attemptId);
    expect(retryInput.clientRequestId).not.toBe(retryInput.attemptId);
    expect(retryInput.capabilities.proxyInstanceId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(mocks.saveCandidate).toHaveBeenCalledTimes(1);
    expect(mocks.saveWorkspace).toHaveBeenCalledTimes(3);
    const receiptWorkspace = mocks.saveWorkspace.mock.calls[1][0].workspace as FrameWorkspace;
    expect(Object.values(receiptWorkspace.retryAttempts)[0]).toMatchObject({ status: "running", childGenerationJobId: "child-job", clientRequestId: retryInput.clientRequestId });
    expect(candidate.frames[0].retryStatus).toBe("candidate_ready");
    expect(candidate.frames[0].candidate?.blob).toBeInstanceOf(Blob);

    const accepted = await adapter.acceptCandidate(candidate, "slot:frame-0");
    expect(mocks.adoptCandidate).toHaveBeenCalledTimes(1);
    expect(accepted.frames[0].currentVersion).toBe("candidate");
    const restored = await adapter.restoreOriginal(accepted, "slot:frame-0");
    expect(restored.frames[0].currentVersion).toBe("original");
  });

  it("候选只能显式放弃，失败不会改变当前采用帧", async () => {
    const adapter = createDefaultWorkspaceAdapter();
    const candidate = await adapter.requestRetry(await adapter.loadOrCreate("job-1"), "slot:frame-0");
    const discarded = await adapter.discardCandidate(candidate, "slot:frame-0");
    expect(discarded.frames[0].candidate).toBeUndefined();
    expect(discarded.frames[0].currentVersion).toBe("original");

    configure();
    mocks.saveCandidate.mockClear();
    mocks.retry.mockRejectedValueOnce(new FrameRetryServiceError("quota", "child_job_failed", "retry", "child-job"));
    const failedAdapter = createDefaultWorkspaceAdapter();
    const loaded = await failedAdapter.loadOrCreate("job-1");
    let failure: Error & { workspaceView: WorkspaceView };
    try {
      await failedAdapter.requestRetry(loaded, "slot:frame-0");
      throw new Error("expected retry failure");
    } catch (error) {
      failure = error as Error & { workspaceView: WorkspaceView };
    }
    expect(failure).toMatchObject({ message: "quota" });
    expect(failure.workspaceView.frames[0]).toMatchObject({ currentVersion: "original", retryStatus: "failed" });
    expect(mocks.saveCandidate).not.toHaveBeenCalled();
  });

  it("状态未知持久化；刷新后只 reconcile 已有子任务，不重提", async () => {
    mocks.retry.mockRejectedValueOnce(new FrameRetryServiceError("unknown", "status_unknown", "reconcile", "child-job"));
    const adapter = createDefaultWorkspaceAdapter();
    const unknown = await adapter.requestRetry(await adapter.loadOrCreate("job-1"), "slot:frame-0");
    expect(unknown.frames[0].retryStatus).toBe("status_unknown");

    const unknownDomain = (unknown.opaque as { domain: FrameWorkspace }).domain;
    configure(unknownDomain);
    mocks.reconcile.mockResolvedValueOnce({ attemptId: "restored", executionMode: "full_sequence_fallback", childJobId: "child-job", candidateFrame: { ...frame(0), id: "child-frame-0", jobId: "child-job", resourceRef: "workspace-frame-resource:child-job:child-frame-0" }, candidateBlob: new Blob([PNG_BYTES], { type: "image/png" }) });
    const refreshed = createDefaultWorkspaceAdapter();
    const restoredView = await refreshed.loadOrCreate("job-1");
    await refreshed.requestRetry(restoredView, "slot:frame-0");
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it("所有当前 Blob 通过解码后才持久化完整快照，存储失败不返回摘要", async () => {
    let domain = initialDomain();
    domain = setFrameDecision(domain, "slot:frame-0", "kept", { expectedRevision: 0, updatedAt: now });
    domain = setFrameDecision(domain, "slot:frame-1", "kept", { expectedRevision: 1, updatedAt: now });
    domain = setFrameWorkspaceFrameRate(domain, 12, { expectedRevision: 2, updatedAt: now });
    configure(domain);
    const adapter = createDefaultWorkspaceAdapter();
    const loaded = await adapter.loadOrCreate("job-1");
    expect(adapter.checkReadiness(loaded).ready).toBe(true);
    const summary = await adapter.createSnapshot(loaded);
    expect(mocks.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({ frameRate: 12, revision: 3 }));
    expect(domain.source.frameRate).toBe(8);
    expect(summary.frameCount).toBe(2);

    mocks.saveSnapshot.mockRejectedValueOnce(new Error("snapshot storage failed"));
    await expect(adapter.createSnapshot(loaded)).rejects.toThrow("snapshot storage failed");
  });

  it("当前采用候选缺失或损坏会阻止 readiness 与快照", async () => {
    const adapter = createDefaultWorkspaceAdapter();
    const candidate = await adapter.requestRetry(await adapter.loadOrCreate("job-1"), "slot:frame-0");
    const accepted = await adapter.acceptCandidate(candidate, "slot:frame-0");
    const acceptedDomain = (accepted.opaque as { domain: FrameWorkspace }).domain;
    configure(acceptedDomain);
    mocks.listCandidates.mockResolvedValueOnce([]);
    const refreshed = createDefaultWorkspaceAdapter();
    const missing = await refreshed.loadOrCreate("job-1");
    expect(refreshed.checkReadiness(missing)).toMatchObject({ ready: false });
    await expect(refreshed.createSnapshot(missing)).rejects.toThrow(/缺失|损坏|无法解码/);
  });

  it("未知且缺少 childJobId 时可放弃跟踪恢复 readiness，不调用 submit/query", async () => {
    mocks.retry.mockRejectedValueOnce(new FrameRetryServiceError("ambiguous submit", "status_unknown", "reconcile"));
    const adapter = createDefaultWorkspaceAdapter();
    const unknown = await adapter.requestRetry(await adapter.loadOrCreate("job-1"), "slot:frame-0");
    expect(unknown.frames[0]).toMatchObject({ retryStatus: "status_unknown", retryCanReconcile: false, retryCanAbandon: true });
    expect(adapter.checkReadiness(unknown).issues).toContain("存在尚未结束或待处理的重试。");
    mocks.retry.mockClear();
    mocks.reconcile.mockClear();

    const abandoned = await adapter.abandonRetryTracking(unknown, "slot:frame-0");
    expect(abandoned.frames[0]).toMatchObject({ retryStatus: "idle", retryCanAbandon: false });
    expect(adapter.checkReadiness(abandoned).issues).not.toContain("存在尚未结束或待处理的重试。");
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("刷新恢复 running+childId 只 reconcile，不重新 submit，并可到候选或未知", async () => {
    mocks.retry.mockRejectedValueOnce(new FrameRetryServiceError("unknown", "status_unknown", "reconcile", "child-job"));
    const firstAdapter = createDefaultWorkspaceAdapter();
    const unknown = await firstAdapter.requestRetry(await firstAdapter.loadOrCreate("job-1"), "slot:frame-0");
    const unknownDomain = (unknown.opaque as { domain: FrameWorkspace }).domain;
    const attempt = Object.values(unknownDomain.retryAttempts)[0];
    const running = transitionWorkspaceRetryAttempt(unknownDomain, attempt.id, "running", { expectedRevision: unknownDomain.revision, updatedAt: now }, { childGenerationJobId: "child-job" });

    configure(running);
    mocks.retry.mockClear();
    mocks.reconcile.mockResolvedValueOnce({ attemptId: attempt.id, executionMode: "full_sequence_fallback", childJobId: "child-job", candidateFrame: { ...frame(0), id: "child-frame-0", jobId: "child-job", resourceRef: "workspace-frame-resource:child-job:child-frame-0" }, candidateBlob: new Blob([PNG_BYTES], { type: "image/png" }) });
    const refreshed = createDefaultWorkspaceAdapter();
    const loaded = await refreshed.loadOrCreate("job-1");
    expect(loaded.frames[0]).toMatchObject({ retryStatus: "running", retryCanReconcile: true });
    const candidate = await refreshed.requestRetry(loaded, "slot:frame-0");
    expect(candidate.frames[0].retryStatus).toBe("candidate_ready");
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.retry).not.toHaveBeenCalled();

    configure(running);
    mocks.retry.mockClear();
    mocks.reconcile.mockRejectedValueOnce(new FrameRetryServiceError("still unknown", "status_unknown", "reconcile", "child-job"));
    const unknownAgainAdapter = createDefaultWorkspaceAdapter();
    const unknownAgain = await unknownAgainAdapter.requestRetry(await unknownAgainAdapter.loadOrCreate("job-1"), "slot:frame-0");
    expect(unknownAgain.frames[0]).toMatchObject({ retryStatus: "status_unknown", retryCanReconcile: true });
    expect(mocks.retry).not.toHaveBeenCalled();
  });
});
