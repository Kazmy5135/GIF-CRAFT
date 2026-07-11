import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceImageAsset } from "../../core/sourceImage";
import { closeGifCraftDatabase, openGifCraftDatabase, STORAGE_STORES } from "./database";
import {
  assessSequenceStorageCapacity,
  checkSequenceStorageCapacity,
  cleanupSequenceStorage,
  getGenerationJob,
  getGenerationJobByClientRequestId,
  getManagedFrameBytes,
  listFrameResources,
  normalizeSequenceStorageError,
  saveCompletedGenerationResult,
  saveGenerationJob,
  SequenceStorageQuotaError,
  SequenceStorageValidationError,
  type StoredFrameResource,
  type StoredGenerationJob,
} from "./sequenceJobRepository";
import {
  deleteSourceImage,
  getSourceImage,
  saveSourceImage,
  SourceImageInUseError,
} from "./sourceImageRepository";

interface TestJobMetadata {
  source: { id: string; resourceRef: string };
  frameIds: string[];
}

interface TestFrameMetadata {
  resourceRef: string;
  mimeType: string;
}

function job(
  id: string,
  overrides: Partial<StoredGenerationJob<TestJobMetadata>> = {},
): StoredGenerationJob<TestJobMetadata> {
  const createdAt = overrides.createdAt ?? "2026-07-11T00:00:00.000Z";
  return {
    id,
    clientRequestId: `request-${id}`,
    sourceImageId: "source-1",
    provider: "test-provider",
    status: "completed",
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    resultBytes: 0,
    job: {
      source: { id: "source-1", resourceRef: "source-image:source-1" },
      frameIds: [`frame-${id}-0`],
    },
    ...overrides,
  };
}

function frame(
  jobId: string,
  sequenceIndex = 0,
  contents = "frame",
): StoredFrameResource<TestFrameMetadata> {
  const blob = new Blob([contents], { type: "image/png" });
  return {
    id: `frame-${jobId}-${sequenceIndex}`,
    jobId,
    sequenceIndex,
    createdAt: "2026-07-11T00:00:00.000Z",
    frame: {
      resourceRef: `frame-resource:${jobId}:${sequenceIndex}`,
      mimeType: "image/png",
    },
    blob,
    size: blob.size,
  };
}

const sourceImage: SourceImageAsset = {
  id: "source-1",
  jobId: "source-job-1",
  provider: "local",
  model: "local-upload",
  mode: "local_upload",
  createdAt: "2026-07-11T00:00:00.000Z",
  dataUrl: "data:image/png;base64,aGVsbG8=",
  mimeType: "image/png",
  promptSnapshot: {
    userPrompt: "",
    basePrompt: "",
    negativePrompt: "",
    compiledPrompt: "",
    templateVersion: 1,
  },
  effectiveParameters: {
    aspectRatio: "1:1",
    quality: "standard",
    providerSize: "1x1",
  },
};

describe("sequence job storage", () => {
  beforeEach(async () => {
    await closeGifCraftDatabase();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("Blob", NodeBlob);
  });

  afterEach(async () => {
    await closeGifCraftDatabase();
    vi.unstubAllGlobals();
  });

  it("stores job metadata and frame Blobs separately and reads them by stable indexes", async () => {
    const storedJob = job("job-1", {
      clientRequestId: "client-request-1",
      job: {
        source: { id: "source-1", resourceRef: "source-image:source-1" },
        frameIds: ["frame-job-1-0", "frame-job-1-1"],
      },
    });
    const resources = [frame(storedJob.id, 1, "second"), frame(storedJob.id, 0, "first")];

    await saveCompletedGenerationResult(storedJob, resources);

    await expect(getGenerationJob(storedJob.id)).resolves.toMatchObject({
      ...storedJob,
      resultStorageStatus: "available",
      resultBytes: resources.reduce((sum, item) => sum + item.size, 0),
    });
    await expect(getGenerationJobByClientRequestId("client-request-1")).resolves.toMatchObject({
      ...storedJob,
      resultStorageStatus: "available",
      resultBytes: resources.reduce((sum, item) => sum + item.size, 0),
    });
    const restored = await listFrameResources<TestFrameMetadata>(storedJob.id);
    expect(restored.map((item) => item.sequenceIndex)).toEqual([0, 1]);
    expect(restored[0].blob).toBeInstanceOf(Blob);
    expect(restored[0].blob.size).toBe(new Blob(["first"]).size);
    expect(restored[0].frame.resourceRef).toBe("frame-resource:job-1:0");
  });

  it("rolls back every frame when the task write violates the idempotency index", async () => {
    await saveGenerationJob(job("existing", { clientRequestId: "duplicate-request" }));
    const conflicting = job("conflict", { clientRequestId: "duplicate-request" });

    await expect(
      saveCompletedGenerationResult(conflicting, [frame(conflicting.id)]),
    ).rejects.toMatchObject({ name: "ConstraintError" });
    await expect(listFrameResources(conflicting.id)).resolves.toEqual([]);
    await expect(getGenerationJob(conflicting.id)).resolves.toBeUndefined();
  });

  it("replaces an existing result without double-counting managed bytes", async () => {
    const storedJob = job("replace-result");
    await saveCompletedGenerationResult(storedJob, [frame(storedJob.id, 0, "old")]);
    const replacement = frame(storedJob.id, 0, "replacement-bytes");

    await saveCompletedGenerationResult(storedJob, [replacement]);

    await expect(getManagedFrameBytes()).resolves.toBe(replacement.size);
    await expect(getGenerationJob(storedJob.id)).resolves.toMatchObject({
      resultBytes: replacement.size,
    });
    const resources = await listFrameResources(storedJob.id);
    expect(resources).toHaveLength(1);
    expect(resources[0].blob.size).toBe(replacement.size);
  });

  it("does not persist image payloads inside task or frame metadata", async () => {
    const invalidJob = job("invalid", {
      job: {
        source: { id: "source-1", resourceRef: "data:image/png;base64,aGVsbG8=" },
        frameIds: [],
      },
    });

    await expect(saveGenerationJob(invalidJob)).rejects.toBeInstanceOf(
      SequenceStorageValidationError,
    );
  });

  it("blocks writes before crossing the managed budget or origin headroom", () => {
    expect(
      assessSequenceStorageCapacity({
        budget: { budgetBytes: 1_000, availableBytes: 10_000 },
        managedBytes: 850,
        expectedWriteBytes: 100,
      }),
    ).toMatchObject({ allowed: false, reason: "managed_budget_exceeded" });
    expect(
      assessSequenceStorageCapacity({
        budget: { budgetBytes: 10_000, availableBytes: 100 },
        managedBytes: 0,
        expectedWriteBytes: 100,
      }),
    ).toMatchObject({ allowed: false, reason: "origin_quota_insufficient" });
    expect(
      assessSequenceStorageCapacity({
        budget: { budgetBytes: 10_000, availableBytes: 10_000 },
        managedBytes: 100,
        expectedWriteBytes: 100,
      }),
    ).toMatchObject({ allowed: true });
  });

  it("maps browser quota aborts to a stable storage error", () => {
    expect(() =>
      normalizeSequenceStorageError(
        new DOMException("quota exceeded", "QuotaExceededError"),
      ),
    ).toThrow(SequenceStorageQuotaError);
  });

  it("prevents deletion of a source image referenced by any generation job", async () => {
    await saveSourceImage(sourceImage);
    await saveGenerationJob(job("uses-source"));

    await expect(deleteSourceImage(sourceImage.id)).rejects.toBeInstanceOf(
      SourceImageInUseError,
    );
    await expect(getSourceImage(sourceImage.id)).resolves.toEqual(sourceImage);
  });

  it("purges oldest completed frame Blobs while retaining task metadata", async () => {
    const oldest = job("oldest", {
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const middle = job("middle", {
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const newest = job("newest", {
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    await saveCompletedGenerationResult(oldest, [frame(oldest.id)]);
    await saveCompletedGenerationResult(middle, [frame(middle.id)]);
    await saveCompletedGenerationResult(newest, [frame(newest.id)]);

    const result = await cleanupSequenceStorage({
      now: new Date("2026-07-11T00:00:00.000Z"),
      protectedJobIds: [oldest.id],
      maxCompletedJobs: 1,
      maxAgeMs: 365 * 24 * 60 * 60 * 1_000,
      budgetBytes: 1_000_000,
    });

    expect(result.deletedJobIds).toEqual([]);
    expect(result.purgedJobIds).toEqual([middle.id]);
    await expect(getGenerationJob(oldest.id)).resolves.toBeDefined();
    await expect(getGenerationJob(middle.id)).resolves.toMatchObject({
      id: middle.id,
      status: "completed",
      resultStorageStatus: "purged",
      resultPurgedAt: "2026-07-11T00:00:00.000Z",
      resultBytes: 0,
    });
    await expect(listFrameResources(middle.id)).resolves.toEqual([]);
    await expect(getGenerationJob(newest.id)).resolves.toBeDefined();
  });

  it("cleans terminal metadata separately by count and age, including failed and cancelled", async () => {
    const completed = job("completed-recent", {
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const failedRecent = job("failed-recent", {
      status: "failed",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
    const cancelled = job("cancelled", {
      status: "cancelled",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    const failedOld = job("failed-old", {
      status: "failed",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const activeOld = job("active-old", {
      status: "generating",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const unknownOld = job("unknown-old", {
      status: "status_unknown",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await saveCompletedGenerationResult(completed, [frame(completed.id)]);
    await Promise.all(
      [failedRecent, cancelled, failedOld, activeOld, unknownOld].map(saveGenerationJob),
    );

    const result = await cleanupSequenceStorage({
      now: new Date("2026-07-11T00:00:00.000Z"),
      maxCompletedJobs: 20,
      maxAgeMs: 365 * 24 * 60 * 60 * 1_000,
      maxTerminalJobs: 2,
      metadataMaxAgeMs: 90 * 24 * 60 * 60 * 1_000,
      budgetBytes: 1_000_000,
    });

    expect(new Set(result.deletedJobIds)).toEqual(
      new Set([cancelled.id, failedOld.id]),
    );
    await expect(getGenerationJob(completed.id)).resolves.toBeDefined();
    await expect(getGenerationJob(failedRecent.id)).resolves.toBeDefined();
    await expect(getGenerationJob(cancelled.id)).resolves.toBeUndefined();
    await expect(getGenerationJob(failedOld.id)).resolves.toBeUndefined();
    await expect(getGenerationJob(activeOld.id)).resolves.toBeDefined();
    await expect(getGenerationJob(unknownOld.id)).resolves.toBeDefined();
  });

  it("cascades frame deletion when completed metadata reaches the 90-day limit", async () => {
    const expired = job("completed-expired", {
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await saveCompletedGenerationResult(expired, [frame(expired.id)]);

    const result = await cleanupSequenceStorage({
      now: new Date("2026-07-11T00:00:00.000Z"),
      maxCompletedJobs: 20,
      maxAgeMs: 365 * 24 * 60 * 60 * 1_000,
      maxTerminalJobs: 100,
      metadataMaxAgeMs: 90 * 24 * 60 * 60 * 1_000,
      budgetBytes: 1_000_000,
    });

    expect(result.deletedJobIds).toEqual([expired.id]);
    expect(result.purgedJobIds).toEqual([]);
    await expect(getGenerationJob(expired.id)).resolves.toBeUndefined();
    await expect(listFrameResources(expired.id)).resolves.toEqual([]);
  });

  it("retains unresolved unknown metadata but expires explicitly abandoned metadata", async () => {
    const unknown = job("unknown", {
      status: "status_unknown",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const abandoned = job("abandoned", {
      status: "abandoned",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await Promise.all([saveGenerationJob(unknown), saveGenerationJob(abandoned)]);

    const result = await cleanupSequenceStorage({
      now: new Date("2026-07-11T00:00:00.000Z"),
      maxTerminalJobs: 100,
      metadataMaxAgeMs: 90 * 24 * 60 * 60 * 1_000,
      budgetBytes: 1_000_000,
    });

    expect(result.deletedJobIds).toEqual([abandoned.id]);
    await expect(getGenerationJob(unknown.id)).resolves.toBeDefined();
    await expect(getGenerationJob(abandoned.id)).resolves.toBeUndefined();
  });

  it("runs retention before capacity checks and honors protected job ids", async () => {
    const protectedJob = job("protected-capacity", {
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    await saveCompletedGenerationResult(protectedJob, [frame(protectedJob.id)]);

    await checkSequenceStorageCapacity(0, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      protectedJobIds: [protectedJob.id],
      maxCompletedJobs: 0,
      budgetBytes: 1_000_000,
    });
    await expect(getGenerationJob(protectedJob.id)).resolves.toMatchObject({
      resultStorageStatus: "available",
    });

    await checkSequenceStorageCapacity(0, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      maxCompletedJobs: 0,
      budgetBytes: 1_000_000,
    });
    await expect(getGenerationJob(protectedJob.id)).resolves.toMatchObject({
      resultStorageStatus: "purged",
      resultBytes: 0,
    });
  });

  it("purges a large Blob through key cursors without calling getAll on frame resources", async () => {
    const large = job("large-result", {
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    await saveCompletedGenerationResult(large, [frame(large.id, 0, "x".repeat(2 * 1024 * 1024))]);
    const database = await openGifCraftDatabase();
    const probeTransaction = database.transaction(STORAGE_STORES.frameResources, "readonly");
    const frameStore = probeTransaction.objectStore(STORAGE_STORES.frameResources);
    const getAllSpy = vi.spyOn(Object.getPrototypeOf(frameStore), "getAll");

    await cleanupSequenceStorage({
      now: new Date("2026-07-11T00:00:00.000Z"),
      maxCompletedJobs: 0,
      budgetBytes: 10_000_000,
    });

    expect(
      getAllSpy.mock.contexts.some(
        (context) => (context as IDBObjectStore).name === STORAGE_STORES.frameResources,
      ),
    ).toBe(false);
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    await expect(getManagedFrameBytes()).resolves.toBe(0);
    await expect(listFrameResources(large.id)).resolves.toEqual([]);
  });

  it("removes old orphan frames without touching active jobs", async () => {
    const active = job("active", { status: "generating" });
    await saveGenerationJob(active);
    const database = await openGifCraftDatabase();
    const transaction = database.transaction(STORAGE_STORES.frameResources, "readwrite");
    transaction.objectStore(STORAGE_STORES.frameResources).put(
      frame(active.id, 0, "active-frame"),
    );
    transaction.objectStore(STORAGE_STORES.frameResources).put(
      frame("missing-job", 0, "orphan"),
    );
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });

    const result = await cleanupSequenceStorage({
      now: new Date("2026-07-13T00:00:00.000Z"),
      budgetBytes: 1,
    });

    expect(result.deletedFrameIds).toEqual(["frame-missing-job-0"]);
    await expect(getGenerationJob(active.id)).resolves.toBeDefined();
    await expect(listFrameResources(active.id)).resolves.toHaveLength(1);
  });
});
