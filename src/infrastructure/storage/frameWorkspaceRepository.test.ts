import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFrameWorkspaceSnapshot as createDomainFrameWorkspaceSnapshot,
  createFrameWorkspace as createDomainFrameWorkspace,
  setFrameDecision,
  setFrameWorkspaceFrameRate,
  type FrameWorkspace,
  type FrameWorkspaceSnapshot,
} from "../../core/frameWorkspace";
import type { Frame, FrameWorkspaceHandoff } from "../../core/sequenceGeneration";
import { closeGifCraftDatabase, openGifCraftDatabase, STORAGE_STORES } from "./database";
import {
  adoptWorkspaceFrameResource,
  checkWorkspaceCandidateCapacity,
  cleanupOrphanedWorkspaceCandidates,
  createFrameWorkspace,
  deleteFrameWorkspace,
  FrameWorkspaceAlreadyExistsError,
  FrameWorkspaceRevisionConflictError,
  FrameWorkspaceSnapshotAlreadyExistsError,
  FrameWorkspaceSnapshotValidationError,
  FrameWorkspaceValidationError,
  frameWorkspaceStorageRecord,
  getFrameWorkspace,
  getFrameWorkspaceByJobId,
  getFrameWorkspaceSnapshot,
  getFrameWorkspaceSnapshotByRevision,
  getManagedWorkspaceFrameBytes,
  getWorkspaceFrameResource,
  listFrameWorkspaces,
  listFrameWorkspaceSnapshots,
  saveFrameWorkspace,
  saveFrameWorkspaceSnapshot,
  saveWorkspaceFrameResource,
  saveWorkspaceFrameResourceAndAdopt,
  type StoredFrameWorkspace,
  type StoredWorkspaceFrameResource,
  WorkspaceCandidateQuotaError,
} from "./frameWorkspaceRepository";
import {
  cleanupSequenceStorage,
  getGenerationJob,
  saveGenerationJob,
  type StoredGenerationJob,
} from "./sequenceJobRepository";

const CREATED_AT = "2026-07-01T00:00:00.000Z";

function handoff(): FrameWorkspaceHandoff {
  const frames: Frame[] = [0, 1].map((index) => ({
    id: `job-1-frame-${index}`,
    jobId: "job-1",
    providerIndex: index,
    sequenceIndex: index,
    resourceRef: `frame-resource:${index}`,
    mimeType: "image/png",
    width: 64,
    height: 64,
    size: 9,
    readable: true,
    createdAt: CREATED_AT,
  }));
  return {
    jobId: "job-1",
    presetId: "character.idle.v1",
    presetVersion: 1,
    frames,
    frameRate: 8,
    loopMode: "loop",
    canvas: { mode: "source", aspectRatio: "1:1", width: 64, height: 64 },
    anchor: "bottom_center_feet_baseline",
  };
}

function keepAllDomainFrames(workspace: FrameWorkspace): FrameWorkspace {
  return workspace.orderedSlotIds.reduce(
    (current, slotId, index) =>
      setFrameDecision(current, slotId, "kept", {
        expectedRevision: current.revision,
        updatedAt: new Date(Date.parse(CREATED_AT) + (index + 1) * 1_000).toISOString(),
      }),
    workspace,
  );
}

async function seedOriginalSnapshotResources(
  snapshot: FrameWorkspaceSnapshot,
): Promise<void> {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.frameResources, "readwrite");
  const store = transaction.objectStore(STORAGE_STORES.frameResources);
  for (const frame of snapshot.frames) {
    store.put({
      id: frame.originalFrameId,
      jobId: snapshot.sourceJobId,
      sequenceIndex: frame.originalSequenceIndex,
      createdAt: CREATED_AT,
      frame: {
        id: frame.originalFrameId,
        jobId: snapshot.sourceJobId,
        providerIndex: frame.originalSequenceIndex,
        sequenceIndex: frame.originalSequenceIndex,
        resourceRef: frame.resourceRef,
        mimeType: frame.mimeType,
        width: frame.width,
        height: frame.height,
        size: frame.size,
        readable: true,
        createdAt: CREATED_AT,
      },
      blob: new Blob([bytes], { type: frame.mimeType }),
      size: frame.size,
    });
  }
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

async function persistedOriginalSnapshot(
  snapshotId = "snapshot-1",
): Promise<FrameWorkspaceSnapshot> {
  const initial = createDomainFrameWorkspace({
    workspaceId: "workspace-1",
    handoff: handoff(),
    createdAt: CREATED_AT,
  });
  const ready = keepAllDomainFrames(initial);
  const snapshot = createDomainFrameWorkspaceSnapshot(ready, {
    snapshotId,
    createdAt: "2026-07-01T00:01:00.000Z",
  });
  await createFrameWorkspace(frameWorkspaceStorageRecord(initial));
  await saveFrameWorkspace(frameWorkspaceStorageRecord(ready), 0);
  await seedOriginalSnapshotResources(snapshot);
  return snapshot;
}

function workspaceRecord(
  workspaceId = "workspace-1",
  sourceJobId = "job-1",
  revision = 0,
): StoredFrameWorkspace<{ selectedSlotId: string }> {
  return {
    workspaceId,
    sourceJobId,
    revision,
    createdAt: CREATED_AT,
    updatedAt: new Date(Date.parse(CREATED_AT) + revision * 1_000).toISOString(),
    sourceFrameIds: [`${sourceJobId}-frame-0`],
    candidateResourceIds: [],
    retryJobIds: [],
    activeRetryJobIds: [],
    workspace: { selectedSlotId: "slot-1" },
  };
}

function candidateResource(
  overrides: Partial<StoredWorkspaceFrameResource<{ id: string }>> = {},
): StoredWorkspaceFrameResource<{ id: string }> {
  const blob =
    overrides.blob ??
    new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], {
      type: "image/png",
    });
  return {
    id: "candidate-1",
    workspaceId: "workspace-1",
    slotId: "slot-1",
    attemptId: "attempt-1",
    sourceJobId: "job-1",
    mimeType: "image/png",
    width: 64,
    height: 64,
    size: blob.size,
    createdAt: CREATED_AT,
    revision: { id: "candidate-1" },
    blob,
    ...overrides,
  };
}

function generationJob(id: string): StoredGenerationJob<{ id: string }> {
  return {
    id,
    clientRequestId: `request-${id}`,
    sourceImageId: "source-1",
    provider: "test",
    status: "completed",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    resultBytes: 0,
    job: { id },
  };
}

describe("frame workspace repository", () => {
  beforeEach(async () => {
    await closeGifCraftDatabase();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("navigator", {
      storage: {
        estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 1024 * 1024 * 1024 }),
      },
    });
  });

  afterEach(async () => {
    await closeGifCraftDatabase();
    vi.unstubAllGlobals();
  });

  it("creates, reads, lists and deletes a workspace by workspaceId and unique jobId", async () => {
    const workspace = workspaceRecord();
    await createFrameWorkspace(workspace);

    await expect(getFrameWorkspace(workspace.workspaceId)).resolves.toEqual(workspace);
    await expect(getFrameWorkspaceByJobId(workspace.sourceJobId)).resolves.toEqual(workspace);
    await expect(listFrameWorkspaces()).resolves.toEqual([workspace]);
    await expect(
      createFrameWorkspace(workspaceRecord("workspace-2", workspace.sourceJobId)),
    ).rejects.toBeInstanceOf(FrameWorkspaceAlreadyExistsError);

    await deleteFrameWorkspace(workspace.workspaceId, workspace.revision);
    await expect(getFrameWorkspace(workspace.workspaceId)).resolves.toBeUndefined();
  });

  it("rejects stale revisions without overwriting the current workspace", async () => {
    const original = workspaceRecord();
    await createFrameWorkspace(original);
    const updated = {
      ...workspaceRecord("workspace-1", "job-1", 1),
      workspace: { selectedSlotId: "slot-2" },
    };
    await saveFrameWorkspace(updated, 0);

    await expect(
      saveFrameWorkspace(
        { ...workspaceRecord("workspace-1", "job-1", 1), workspace: { selectedSlotId: "old" } },
        0,
      ),
    ).rejects.toMatchObject({
      name: "FrameWorkspaceRevisionConflictError",
      expectedRevision: 0,
      actualRevision: 1,
    });
    await expect(getFrameWorkspace("workspace-1")).resolves.toEqual(updated);
  });

  it("persists multiple debounced local edits in one optimistic write", async () => {
    await createFrameWorkspace(workspaceRecord());
    const afterTwoCommands = {
      ...workspaceRecord("workspace-1", "job-1", 2),
      workspace: { selectedSlotId: "slot-after-two-edits" },
    };

    await saveFrameWorkspace(afterTwoCommands, 0);

    await expect(getFrameWorkspace("workspace-1")).resolves.toEqual(afterTwoCommands);
  });

  it("aligns core edit revisions with storage acknowledgement revisions", async () => {
    const initial = createDomainFrameWorkspace({
      workspaceId: "workspace-1",
      handoff: handoff(),
      createdAt: CREATED_AT,
    });
    await createFrameWorkspace(frameWorkspaceStorageRecord(initial));
    const first = setFrameDecision(initial, initial.orderedSlotIds[0]!, "kept", {
      expectedRevision: 0,
      updatedAt: "2026-07-01T00:00:01.000Z",
    });
    const second = setFrameDecision(first, first.orderedSlotIds[1]!, "kept", {
      expectedRevision: 1,
      updatedAt: "2026-07-01T00:00:02.000Z",
    });
    const stored = frameWorkspaceStorageRecord(second);

    expect(second).toMatchObject({ revision: 2, lastPersistedRevision: 0 });
    expect(stored.workspace).toMatchObject({ revision: 2, lastPersistedRevision: 2 });
    await saveFrameWorkspace(stored, 0);
    await expect(getFrameWorkspace("workspace-1")).resolves.toMatchObject({
      revision: 2,
      workspace: { revision: 2, lastPersistedRevision: 2 },
    });
  });

  it("restores legacy IndexedDB v4 workspaces with source FPS and persists later overrides", async () => {
    const initial = createDomainFrameWorkspace({
      workspaceId: "workspace-legacy-v4",
      handoff: handoff(),
      createdAt: CREATED_AT,
    });
    const currentRecord = frameWorkspaceStorageRecord(initial);
    const { playbackFrameRate: _legacyMissingField, ...legacyWorkspace } = currentRecord.workspace;
    const database = await openGifCraftDatabase();
    const transaction = database.transaction(STORAGE_STORES.frameWorkspaces, "readwrite");
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    transaction.objectStore(STORAGE_STORES.frameWorkspaces).put({
      ...currentRecord,
      workspaceId: initial.workspaceId,
      workspace: legacyWorkspace,
    });
    await committed;

    const loaded = await getFrameWorkspace<FrameWorkspace>(initial.workspaceId);
    const loadedByJob = await getFrameWorkspaceByJobId<FrameWorkspace>(initial.sourceJobId);
    const listed = await listFrameWorkspaces<FrameWorkspace>();

    expect(loaded?.workspace).toMatchObject({ playbackFrameRate: 8, revision: 0, lastPersistedRevision: 0 });
    expect(loadedByJob?.workspace.playbackFrameRate).toBe(8);
    expect(listed[0]?.workspace.playbackFrameRate).toBe(8);

    const edited = setFrameWorkspaceFrameRate(loaded!.workspace, 12, {
      expectedRevision: 0,
      updatedAt: "2026-07-01T00:00:01.000Z",
    });
    await saveFrameWorkspace(frameWorkspaceStorageRecord(edited), 0);

    await expect(getFrameWorkspace<FrameWorkspace>(initial.workspaceId)).resolves.toMatchObject({
      revision: 1,
      workspace: {
        playbackFrameRate: 12,
        source: { frameRate: 8 },
        revision: 1,
        lastPersistedRevision: 1,
      },
    });
  });

  it("persists and restores a complete snapshot as a deeply frozen history record", async () => {
    const snapshot = await persistedOriginalSnapshot();

    await saveFrameWorkspaceSnapshot(snapshot);

    const loaded = await getFrameWorkspaceSnapshot(snapshot.snapshotId);
    expect(loaded).toEqual(snapshot);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.frames)).toBe(true);
    expect(Object.isFrozen(loaded?.frames[0])).toBe(true);
    await expect(
      getFrameWorkspaceSnapshotByRevision(snapshot.workspaceId, snapshot.revision),
    ).resolves.toEqual(snapshot);
    await expect(listFrameWorkspaceSnapshots(snapshot.workspaceId)).resolves.toEqual([
      snapshot,
    ]);
  });

  it("never overwrites an existing snapshot id or workspace revision", async () => {
    const snapshot = await persistedOriginalSnapshot();
    await saveFrameWorkspaceSnapshot(snapshot);

    await expect(saveFrameWorkspaceSnapshot(snapshot)).rejects.toBeInstanceOf(
      FrameWorkspaceSnapshotAlreadyExistsError,
    );
    await expect(
      saveFrameWorkspaceSnapshot({ ...snapshot, snapshotId: "snapshot-other-id" }),
    ).rejects.toBeInstanceOf(FrameWorkspaceSnapshotAlreadyExistsError);
    await expect(getFrameWorkspaceSnapshot(snapshot.snapshotId)).resolves.toEqual(snapshot);
  });

  it("rejects structurally invalid, stale or dangling snapshots before persistence", async () => {
    const snapshot = await persistedOriginalSnapshot();
    const invalidOrder = {
      ...snapshot,
      snapshotId: "snapshot-invalid-order",
      frames: snapshot.frames.map((frame, index) =>
        index === 0 ? { ...frame, outputIndex: 4 } : frame,
      ),
    };
    await expect(saveFrameWorkspaceSnapshot(invalidOrder)).rejects.toBeInstanceOf(
      FrameWorkspaceSnapshotValidationError,
    );

    const dangling = {
      ...snapshot,
      snapshotId: "snapshot-dangling",
      frames: snapshot.frames.map((frame, index) =>
        index === 0 ? { ...frame, resourceRef: "frame-resource:missing" } : frame,
      ),
    };
    await expect(saveFrameWorkspaceSnapshot(dangling)).rejects.toBeInstanceOf(
      FrameWorkspaceSnapshotValidationError,
    );

    await expect(
      saveFrameWorkspaceSnapshot({
        ...snapshot,
        snapshotId: "snapshot-stale",
        revision: snapshot.revision + 1,
      }),
    ).rejects.toBeInstanceOf(FrameWorkspaceSnapshotValidationError);
    await expect(listFrameWorkspaceSnapshots(snapshot.workspaceId)).resolves.toEqual([]);
  });

  it("persists candidate snapshot resources and protects their source data after workspace deletion", async () => {
    const originalSnapshot = await persistedOriginalSnapshot();
    const firstFrame = originalSnapshot.frames[0]!;
    const candidate = candidateResource({
      slotId: firstFrame.slotId,
      revision: { id: "revision:candidate:1" },
    });
    await saveWorkspaceFrameResource(candidate);
    const current = await getFrameWorkspace(originalSnapshot.workspaceId);
    expect(current).toBeDefined();
    const adoptedWorkspace = {
      ...current!,
      revision: originalSnapshot.revision + 1,
      updatedAt: "2026-07-01T00:00:03.000Z",
      candidateResourceIds: [candidate.id],
    };
    await adoptWorkspaceFrameResource({
      workspace: adoptedWorkspace,
      candidateId: candidate.id,
      expectedRevision: originalSnapshot.revision,
      adoptedAt: adoptedWorkspace.updatedAt,
    });
    const candidateSnapshot: FrameWorkspaceSnapshot = {
      ...originalSnapshot,
      snapshotId: "snapshot-candidate",
      revision: adoptedWorkspace.revision,
      frames: originalSnapshot.frames.map((frame, index) =>
        index === 0
          ? {
              ...frame,
              revisionId: "revision:candidate:1",
              revisionSource: "retry_candidate",
              resourceRef: candidate.id,
            }
          : frame,
      ),
    };
    await saveFrameWorkspaceSnapshot(candidateSnapshot);
    await saveGenerationJob(generationJob(originalSnapshot.sourceJobId));

    await deleteFrameWorkspace(originalSnapshot.workspaceId, adoptedWorkspace.revision);
    await cleanupOrphanedWorkspaceCandidates({
      now: new Date("2026-07-12T00:00:00.000Z"),
      orphanAgeMs: 0,
    });
    await cleanupSequenceStorage({
      now: new Date("2026-07-12T00:00:00.000Z"),
      maxTerminalJobs: 0,
      metadataMaxAgeMs: 0,
    });

    await expect(getWorkspaceFrameResource(candidate.id)).resolves.toBeDefined();
    await expect(getGenerationJob(originalSnapshot.sourceJobId)).resolves.toBeDefined();
    await expect(getFrameWorkspaceSnapshot(candidateSnapshot.snapshotId)).resolves.toEqual(
      candidateSnapshot,
    );
  });

  it("validates candidate Blob metadata and ownership before storing it", async () => {
    await createFrameWorkspace(workspaceRecord());

    await expect(
      saveWorkspaceFrameResource(
        candidateResource({
          mimeType: "image/jpeg",
        }),
      ),
    ).rejects.toBeInstanceOf(FrameWorkspaceValidationError);
    await expect(
      saveWorkspaceFrameResource(candidateResource({ workspaceId: "other" })),
    ).rejects.toBeInstanceOf(FrameWorkspaceValidationError);
    const unreadable = new Blob(["not-an-image"], { type: "image/png" });
    await expect(
      saveWorkspaceFrameResource(
        candidateResource({ blob: unreadable, size: unreadable.size }),
      ),
    ).rejects.toBeInstanceOf(FrameWorkspaceValidationError);
    await expect(getManagedWorkspaceFrameBytes()).resolves.toBe(0);
  });

  it("rejects decoded dimensions that disagree with candidate metadata", async () => {
    await createFrameWorkspace(workspaceRecord());
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 32, height: 64, close }),
    );

    await expect(saveWorkspaceFrameResource(candidateResource())).rejects.toThrow(
      "候选帧解码尺寸与声明尺寸不一致",
    );
    expect(close).toHaveBeenCalledOnce();
    await expect(getWorkspaceFrameResource("candidate-1")).resolves.toBeUndefined();
  });

  it("rejects signed URLs in workspace metadata", async () => {
    await expect(
      createFrameWorkspace({
        ...workspaceRecord(),
        workspace: {
          selectedSlotId: "slot-1",
          resourceUrl: "https://cdn.test/frame.png?X-Amz-Signature=secret",
        },
      }),
    ).rejects.toBeInstanceOf(FrameWorkspaceValidationError);
  });

  it("preflights candidate capacity before opening a write transaction", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 100 }) },
    });

    await expect(checkWorkspaceCandidateCapacity(100)).resolves.toMatchObject({
      allowed: false,
      reason: "managed_budget_exceeded",
    });
  });

  it("stores and adopts a candidate atomically", async () => {
    const original = workspaceRecord();
    await createFrameWorkspace(original);
    const candidate = candidateResource();
    const updated: StoredFrameWorkspace<{ selectedSlotId: string }> = {
      ...workspaceRecord("workspace-1", "job-1", 1),
      candidateResourceIds: [candidate.id],
    };

    await saveWorkspaceFrameResourceAndAdopt({
      workspace: updated,
      candidate,
      expectedRevision: 0,
      adoptedAt: updated.updatedAt,
    });

    await expect(getFrameWorkspace("workspace-1")).resolves.toEqual(updated);
    await expect(getWorkspaceFrameResource(candidate.id)).resolves.toMatchObject({
      adoptedRevision: 1,
      adoptedAt: updated.updatedAt,
    });
    await expect(getManagedWorkspaceFrameBytes()).resolves.toBe(candidate.size);
  });

  it("leaves the current workspace intact when candidate quota preflight fails", async () => {
    const original = workspaceRecord();
    await createFrameWorkspace(original);
    vi.stubGlobal("navigator", {
      storage: { estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 100 }) },
    });
    const bytes = new Uint8Array(60);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const blob = new Blob([bytes], { type: "image/png" });
    const candidate = candidateResource({ blob, size: blob.size });
    const updated = {
      ...workspaceRecord("workspace-1", "job-1", 1),
      candidateResourceIds: [candidate.id],
    };

    await expect(
      saveWorkspaceFrameResourceAndAdopt({
        workspace: updated,
        candidate,
        expectedRevision: 0,
        adoptedAt: updated.updatedAt,
      }),
    ).rejects.toBeInstanceOf(WorkspaceCandidateQuotaError);
    await expect(getFrameWorkspace("workspace-1")).resolves.toEqual(original);
    await expect(getWorkspaceFrameResource(candidate.id)).resolves.toBeUndefined();
  });

  it("rolls back a candidate insert when atomic adoption loses a revision race", async () => {
    const original = workspaceRecord();
    await createFrameWorkspace(original);
    const winner = workspaceRecord("workspace-1", "job-1", 1);
    await saveFrameWorkspace(winner, 0);
    const candidate = candidateResource();
    const loser = {
      ...workspaceRecord("workspace-1", "job-1", 1),
      candidateResourceIds: [candidate.id],
    };

    await expect(
      saveWorkspaceFrameResourceAndAdopt({
        workspace: loser,
        candidate,
        expectedRevision: 0,
        adoptedAt: loser.updatedAt,
      }),
    ).rejects.toBeInstanceOf(FrameWorkspaceRevisionConflictError);
    await expect(getWorkspaceFrameResource(candidate.id)).resolves.toBeUndefined();
    await expect(getFrameWorkspace("workspace-1")).resolves.toEqual(winner);
    await expect(getManagedWorkspaceFrameBytes()).resolves.toBe(0);
  });

  it("adopts an already stored candidate in the same transaction as workspace metadata", async () => {
    await createFrameWorkspace(workspaceRecord());
    const candidate = candidateResource();
    await saveWorkspaceFrameResource(candidate);
    const updated = {
      ...workspaceRecord("workspace-1", "job-1", 1),
      candidateResourceIds: [candidate.id],
    };

    await adoptWorkspaceFrameResource({
      workspace: updated,
      candidateId: candidate.id,
      expectedRevision: 0,
      adoptedAt: updated.updatedAt,
    });

    await expect(getFrameWorkspace("workspace-1")).resolves.toEqual(updated);
    await expect(getWorkspaceFrameResource(candidate.id)).resolves.toMatchObject({
      adoptedRevision: 1,
    });
  });

  it("deletes only candidate blobs owned by a deleted workspace", async () => {
    await saveGenerationJob(generationJob("job-1"));
    await createFrameWorkspace(workspaceRecord());
    const candidate = candidateResource();
    await saveWorkspaceFrameResource(candidate);

    const result = await deleteFrameWorkspace("workspace-1", 0);

    expect(result.deletedResourceIds).toEqual([candidate.id]);
    await expect(getWorkspaceFrameResource(candidate.id)).resolves.toBeUndefined();
    await expect(getGenerationJob("job-1")).resolves.toBeDefined();
  });

  it("does not reclaim a candidate while another workspace metadata record references it", async () => {
    await createFrameWorkspace(workspaceRecord());
    const candidate = candidateResource();
    await saveWorkspaceFrameResource(candidate);
    await createFrameWorkspace({
      ...workspaceRecord("workspace-2", "job-2"),
      candidateResourceIds: [candidate.id],
    });

    const deletion = await deleteFrameWorkspace("workspace-1", 0);
    const cleanup = await cleanupOrphanedWorkspaceCandidates({
      now: new Date("2026-07-12T00:00:00.000Z"),
      orphanAgeMs: 0,
    });

    expect(deletion.deletedResourceIds).toEqual([]);
    expect(cleanup.deletedResourceIds).toEqual([]);
    await expect(getWorkspaceFrameResource(candidate.id)).resolves.toBeDefined();
  });

  it("protects source and retry generation jobs referenced by an active workspace", async () => {
    await saveGenerationJob(generationJob("job-1"));
    await saveGenerationJob(generationJob("retry-1"));
    await saveGenerationJob(generationJob("retry-history"));
    await saveGenerationJob(generationJob("unprotected"));
    await createFrameWorkspace({
      ...workspaceRecord(),
      retryJobIds: ["retry-1", "retry-history"],
      activeRetryJobIds: ["retry-1"],
    });

    const result = await cleanupSequenceStorage({
      now: new Date("2026-07-12T00:00:00.000Z"),
      maxTerminalJobs: 0,
      metadataMaxAgeMs: 0,
    });

    expect(result.deletedJobIds).toEqual(
      expect.arrayContaining(["retry-history", "unprotected"]),
    );
    expect(result.deletedJobIds).not.toContain("retry-1");
    await expect(getGenerationJob("job-1")).resolves.toBeDefined();
    await expect(getGenerationJob("retry-1")).resolves.toBeDefined();
    await expect(getGenerationJob("retry-history")).resolves.toBeUndefined();
  });

  it("reclaims old unreferenced candidates even while their owning workspace exists", async () => {
    await createFrameWorkspace(workspaceRecord());
    const owned = candidateResource();
    await saveWorkspaceFrameResource(owned);
    const database = await openGifCraftDatabase();
    const transaction = database.transaction(
      STORAGE_STORES.workspaceFrameResources,
      "readwrite",
    );
    transaction.objectStore(STORAGE_STORES.workspaceFrameResources).put(
      candidateResource({
        id: "orphan",
        workspaceId: "deleted-workspace",
        createdAt: "2026-07-01T00:00:00.000Z",
        revision: { id: "orphan" },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });

    const result = await cleanupOrphanedWorkspaceCandidates({
      now: new Date("2026-07-12T00:00:00.000Z"),
      orphanAgeMs: 0,
    });

    expect(result.deletedResourceIds).toEqual(
      expect.arrayContaining([owned.id, "orphan"]),
    );
    await expect(getWorkspaceFrameResource(owned.id)).resolves.toBeUndefined();
  });
});
