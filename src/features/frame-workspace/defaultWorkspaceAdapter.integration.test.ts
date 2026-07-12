import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame, GenerationJob, SequenceGenerationRequest } from "../../core/sequenceGeneration";
import { closeGifCraftDatabase } from "../../infrastructure/storage/database";
import { getFrameWorkspaceSnapshot } from "../../infrastructure/storage/frameWorkspaceRepository";
import { frameResourceStorageRecord, generationJobStorageRecord, listFrameResources, saveCompletedGenerationResult } from "../../infrastructure/storage/sequenceJobRepository";
import { createDefaultWorkspaceAdapter } from "./defaultWorkspaceAdapter";

const api = vi.hoisted(() => ({ fetchProviders: vi.fn() }));
vi.mock("../../infrastructure/api/sequenceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/api/sequenceApi")>()),
  fetchSequenceProviders: api.fetchProviders,
}));

const now = "2026-07-13T02:00:00.000Z";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function request(): SequenceGenerationRequest {
  return {
    draftId: "job-integration", clientRequestId: "client-integration", provider: "gorilla_seedance",
    source: { id: "source-integration", confirmedAt: now, contentSnapshotId: "sha256:source", resourceRef: "source-image:source-integration", mimeType: "image/png", width: 64, height: 64, size: 8 },
    presetId: "character.idle.v1", presetVersion: 1,
    promptSnapshot: { layerRefs: [{ id: "game.sequence.common.v1", version: 1 }], userDescription: "idle", compiledText: "compiled" },
    requestedParameters: { frameCount: 2, frameRate: 8, loopMode: "loop", canvas: { mode: "source", aspectRatio: "1:1", width: 64, height: 64 }, anchor: "bottom_center_feet_baseline", randomSeed: null },
    effectiveParameters: { frameCount: 2, frameRate: 8, loopMode: "loop", canvas: { mode: "source", aspectRatio: "1:1", width: 64, height: 64 }, anchor: "bottom_center_feet_baseline", randomSeed: null },
    parameterMappings: [], providerExtensions: { proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  };
}

function frame(index: number): Frame {
  return { id: `integration-frame-${index}`, jobId: "job-integration", providerIndex: index, sequenceIndex: index, resourceRef: `frame-resource:integration-frame-${index}`, mimeType: "image/png", width: 64, height: 64, size: 8, readable: true, createdAt: now };
}

describe("default workspace adapter + IndexedDB", () => {
  beforeEach(async () => {
    await closeGifCraftDatabase();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("navigator", { storage: { estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 1024 * 1024 * 1024 }) } });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64, close: vi.fn() })));
    api.fetchProviders.mockResolvedValue([{ provider: "gorilla_seedance", frameRetryMode: "full_sequence_fallback", proxyInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]);
  });

  afterEach(async () => {
    await closeGifCraftDatabase();
    vi.unstubAllGlobals();
  });

  it("实际创建/修订工作区并持久化可再次读取的不可变快照", async () => {
    const frames = [frame(0), frame(1)];
    const job: GenerationJob = {
      id: "job-integration", clientRequestId: "client-integration", provider: "gorilla_seedance", request: request(), status: "completed", progress: 1,
      timestamps: { createdAt: now, updatedAt: now, completedAt: now }, retryCount: 0,
      frameIds: frames.map((item) => item.id),
      resultIntegrity: { status: "complete", expectedFrameCount: 2, actualFrameCount: 2, issues: [], validatedAt: now },
    };
    await saveCompletedGenerationResult(
      generationJobStorageRecord(job),
      frames.map((item) => frameResourceStorageRecord(item, new Blob([png], { type: "image/png" }))),
    );
    const storedResources = await listFrameResources<Frame>(job.id);
    expect(storedResources.map((resource) => ({ id: resource.id, jobId: resource.jobId, size: resource.size, blobSize: resource.blob.size, blobType: resource.blob.type, readable: resource.frame.readable }))).toEqual([
      { id: "integration-frame-0", jobId: job.id, size: 8, blobSize: 8, blobType: "image/png", readable: true },
      { id: "integration-frame-1", jobId: job.id, size: 8, blobSize: 8, blobType: "image/png", readable: true },
    ]);

    const adapter = createDefaultWorkspaceAdapter();
    let view = await adapter.loadOrCreate(job.id);
    view = await adapter.save(adapter.apply(view, { type: "set_decision", frameId: view.frames[0].id, decision: "kept" }), 0);
    view = await adapter.save(adapter.apply(view, { type: "set_decision", frameId: view.frames[1].id, decision: "kept" }), 1);
    const summary = await adapter.createSnapshot(view);
    const persisted = await getFrameWorkspaceSnapshot(summary.id);

    expect(persisted).toMatchObject({ snapshotId: summary.id, workspaceId: view.id, revision: 2, sourceJobId: job.id });
    expect(persisted?.frames.map((item) => item.outputIndex)).toEqual([0, 1]);
    expect(Object.isFrozen(persisted)).toBe(true);
  });
});
