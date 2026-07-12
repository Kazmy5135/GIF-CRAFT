import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceImageAsset } from "../../core/sourceImage";
import {
  closeGifCraftDatabase,
  DatabaseBlockedError,
  GIF_CRAFT_DATABASE_NAME,
  GIF_CRAFT_DATABASE_VERSION,
  openGifCraftDatabase,
  requestResult,
  STORAGE_STORES,
  transactionCommitted,
} from "./database";
import { getSourceImage, listSourceImages, saveSourceImage } from "./sourceImageRepository";

function openLegacyDatabase(asset?: SourceImageAsset): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GIF_CRAFT_DATABASE_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORAGE_STORES.sourceImages, {
        keyPath: "id",
      });
      store.createIndex("createdAt", "createdAt");
      if (asset) store.put(asset);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function openV2Database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GIF_CRAFT_DATABASE_NAME, 2);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      const sources = database.createObjectStore(STORAGE_STORES.sourceImages, {
        keyPath: "id",
      });
      sources.createIndex("createdAt", "createdAt");
      const jobs = database.createObjectStore(STORAGE_STORES.generationJobs, {
        keyPath: "id",
      });
      jobs.createIndex("clientRequestId", "clientRequestId", { unique: true });
      jobs.createIndex("sourceImageId", "sourceImageId");
      jobs.createIndex("status", "status");
      jobs.createIndex("createdAt", "createdAt");
      jobs.createIndex("updatedAt", "updatedAt");
      jobs.createIndex("providerExternalJob", ["provider", "externalJobId"]);
      const frames = database.createObjectStore(STORAGE_STORES.frameResources, {
        keyPath: "id",
      });
      frames.createIndex("jobId", "jobId");
      frames.createIndex("jobAndSequenceIndex", ["jobId", "sequenceIndex"], {
        unique: true,
      });
      frames.createIndex("createdAt", "createdAt");
      database.createObjectStore(STORAGE_STORES.storageMeta, { keyPath: "key" });
      sources.put(legacyAsset);
      jobs.put({
        id: "job-v2",
        clientRequestId: "request-v2",
        sourceImageId: legacyAsset.id,
        provider: "test",
        status: "completed",
        createdAt: legacyAsset.createdAt,
        updatedAt: legacyAsset.createdAt,
        resultBytes: 3,
        job: { id: "job-v2" },
      });
      frames.put({
        id: "frame-v2",
        jobId: "job-v2",
        sequenceIndex: 0,
        createdAt: legacyAsset.createdAt,
        frame: { id: "frame-v2" },
        blob: new Blob(["v2!"], { type: "image/png" }),
        size: 3,
      });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function openV3WorkspaceDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GIF_CRAFT_DATABASE_NAME, 3);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      const sources = database.createObjectStore(STORAGE_STORES.sourceImages, {
        keyPath: "id",
      });
      sources.createIndex("createdAt", "createdAt");
      const jobs = database.createObjectStore(STORAGE_STORES.generationJobs, {
        keyPath: "id",
      });
      jobs.createIndex("clientRequestId", "clientRequestId", { unique: true });
      jobs.createIndex("sourceImageId", "sourceImageId");
      jobs.createIndex("status", "status");
      jobs.createIndex("createdAt", "createdAt");
      jobs.createIndex("updatedAt", "updatedAt");
      jobs.createIndex("providerExternalJob", ["provider", "externalJobId"]);
      const frames = database.createObjectStore(STORAGE_STORES.frameResources, {
        keyPath: "id",
      });
      frames.createIndex("jobId", "jobId");
      frames.createIndex("jobAndSequenceIndex", ["jobId", "sequenceIndex"], {
        unique: true,
      });
      frames.createIndex("createdAt", "createdAt");
      const workspaces = database.createObjectStore(STORAGE_STORES.frameWorkspaces, {
        keyPath: "workspaceId",
      });
      workspaces.createIndex("sourceJobId", "sourceJobId", { unique: true });
      workspaces.createIndex("createdAt", "createdAt");
      workspaces.createIndex("updatedAt", "updatedAt");
      const candidates = database.createObjectStore(
        STORAGE_STORES.workspaceFrameResources,
        { keyPath: "id" },
      );
      candidates.createIndex("workspaceId", "workspaceId");
      candidates.createIndex("workspaceAndSlot", ["workspaceId", "slotId"]);
      candidates.createIndex("attemptId", "attemptId");
      candidates.createIndex("childJobId", "childJobId");
      candidates.createIndex("createdAt", "createdAt");
      database.createObjectStore(STORAGE_STORES.storageMeta, { keyPath: "key" });

      const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
      sources.put(legacyAsset);
      jobs.put({
        id: "job-v3",
        clientRequestId: "request-v3",
        sourceImageId: legacyAsset.id,
        provider: "test",
        status: "completed",
        createdAt: legacyAsset.createdAt,
        updatedAt: legacyAsset.createdAt,
        resultBytes: 3,
        job: { id: "job-v3" },
      });
      frames.put({
        id: "frame-v3",
        jobId: "job-v3",
        sequenceIndex: 0,
        createdAt: legacyAsset.createdAt,
        frame: { id: "frame-v3", jobId: "job-v3", sequenceIndex: 0 },
        blob: new Blob(["v3!"], { type: "image/png" }),
        size: 3,
      });
      workspaces.put({
        workspaceId: "workspace-v3",
        sourceJobId: "job-v3",
        revision: 2,
        createdAt: legacyAsset.createdAt,
        updatedAt: legacyAsset.createdAt,
        sourceFrameIds: ["frame-v3"],
        candidateResourceIds: ["candidate-v3"],
        retryJobIds: ["retry-v3"],
        activeRetryJobIds: [],
        workspace: { selectedSlotId: "slot-v3" },
      });
      candidates.put({
        id: "candidate-v3",
        workspaceId: "workspace-v3",
        slotId: "slot-v3",
        attemptId: "attempt-v3",
        sourceJobId: "job-v3",
        childJobId: "retry-v3",
        mimeType: "image/png",
        width: 64,
        height: 64,
        size: pngBytes.byteLength,
        createdAt: legacyAsset.createdAt,
        revision: { id: "revision-v3" },
        blob: new Blob([pngBytes], { type: "image/png" }),
      });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

const legacyAsset: SourceImageAsset = {
  id: "source-1",
  jobId: "source-job-1",
  provider: "local",
  model: "local-upload",
  mode: "local_upload",
  createdAt: "2026-07-11T00:00:00.000Z",
  dataUrl: "data:image/png;base64,aGVsbG8=",
  mimeType: "image/png",
  width: 1,
  height: 1,
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

describe("GIF CRAFT IndexedDB schema", () => {
  beforeEach(async () => {
    await closeGifCraftDatabase();
    vi.stubGlobal("indexedDB", new IDBFactory());
  });

  afterEach(async () => {
    await closeGifCraftDatabase();
    vi.unstubAllGlobals();
  });

  it("migrates a v1 database without rewriting or losing source images", async () => {
    const legacy = await openLegacyDatabase(legacyAsset);
    legacy.close();

    const database = await openGifCraftDatabase();

    expect(database.version).toBe(GIF_CRAFT_DATABASE_VERSION);
    expect(Array.from(database.objectStoreNames)).toEqual(
      expect.arrayContaining(Object.values(STORAGE_STORES)),
    );
    await expect(getSourceImage(legacyAsset.id)).resolves.toEqual(legacyAsset);
  });

  it("uses the unified version for new source-image writes", async () => {
    await saveSourceImage(legacyAsset);

    await expect(listSourceImages()).resolves.toEqual([legacyAsset]);
    expect((await openGifCraftDatabase()).version).toBe(GIF_CRAFT_DATABASE_VERSION);
  });

  it("returns a deterministic error when another page blocks the v4 upgrade", async () => {
    const legacy = await openLegacyDatabase();

    await expect(openGifCraftDatabase()).rejects.toBeInstanceOf(DatabaseBlockedError);
    legacy.close();
  });

  it("adds workspace stores while preserving v2 jobs and frame blobs", async () => {
    const legacy = await openV2Database();
    legacy.close();

    const database = await openGifCraftDatabase();
    const transaction = database.transaction(
      [STORAGE_STORES.generationJobs, STORAGE_STORES.frameResources],
      "readonly",
    );
    const jobRequest = transaction.objectStore(STORAGE_STORES.generationJobs).get("job-v2");
    const frameRequest = transaction.objectStore(STORAGE_STORES.frameResources).get("frame-v2");
    const [job, frame] = await Promise.all([
      new Promise<Record<string, unknown>>((resolve) => {
        jobRequest.onsuccess = () => resolve(jobRequest.result);
      }),
      new Promise<{ blob: Blob }>((resolve) => {
        frameRequest.onsuccess = () => resolve(frameRequest.result);
      }),
    ]);

    expect(job.id).toBe("job-v2");
    expect(frame).toMatchObject({ id: "frame-v2", jobId: "job-v2", size: 3 });
    expect(frame).toHaveProperty("blob");
    expect(database.objectStoreNames.contains(STORAGE_STORES.frameWorkspaces)).toBe(true);
    expect(database.objectStoreNames.contains(STORAGE_STORES.workspaceFrameResources)).toBe(
      true,
    );
    expect(database.objectStoreNames.contains(STORAGE_STORES.frameWorkspaceSnapshots)).toBe(
      true,
    );
    const snapshotTransaction = database.transaction(
      STORAGE_STORES.frameWorkspaceSnapshots,
      "readonly",
    );
    expect(
      snapshotTransaction
        .objectStore(STORAGE_STORES.frameWorkspaceSnapshots)
        .index("workspaceAndRevision").unique,
    ).toBe(true);
  });

  it("migrates a populated v3 workspace database to v4 without losing data", async () => {
    const legacy = await openV3WorkspaceDatabase();
    expect(legacy.objectStoreNames.contains(STORAGE_STORES.frameWorkspaceSnapshots)).toBe(
      false,
    );
    legacy.close();

    const database = await openGifCraftDatabase();
    const transaction = database.transaction(
      [
        STORAGE_STORES.sourceImages,
        STORAGE_STORES.generationJobs,
        STORAGE_STORES.frameResources,
        STORAGE_STORES.frameWorkspaces,
        STORAGE_STORES.workspaceFrameResources,
        STORAGE_STORES.frameWorkspaceSnapshots,
      ],
      "readonly",
    );
    const committed = transactionCommitted(transaction);
    const snapshotRevisionIndexUnique = transaction
      .objectStore(STORAGE_STORES.frameWorkspaceSnapshots)
      .index("workspaceAndRevision").unique;
    const [source, job, frame, workspace, candidate, snapshots] = await Promise.all([
      requestResult(transaction.objectStore(STORAGE_STORES.sourceImages).get(legacyAsset.id)),
      requestResult(transaction.objectStore(STORAGE_STORES.generationJobs).get("job-v3")),
      requestResult(transaction.objectStore(STORAGE_STORES.frameResources).get("frame-v3")),
      requestResult(
        transaction.objectStore(STORAGE_STORES.frameWorkspaces).get("workspace-v3"),
      ),
      requestResult(
        transaction
          .objectStore(STORAGE_STORES.workspaceFrameResources)
          .get("candidate-v3"),
      ),
      requestResult(
        transaction.objectStore(STORAGE_STORES.frameWorkspaceSnapshots).getAll(),
      ),
    ]);
    await committed;

    expect(database.version).toBe(GIF_CRAFT_DATABASE_VERSION);
    expect(source).toEqual(legacyAsset);
    expect(job).toMatchObject({ id: "job-v3", clientRequestId: "request-v3" });
    expect(frame).toMatchObject({ id: "frame-v3", jobId: "job-v3", size: 3 });
    expect(frame).toHaveProperty("blob");
    expect(workspace).toMatchObject({
      workspaceId: "workspace-v3",
      sourceJobId: "job-v3",
      revision: 2,
      candidateResourceIds: ["candidate-v3"],
    });
    expect(candidate).toMatchObject({
      id: "candidate-v3",
      workspaceId: "workspace-v3",
      childJobId: "retry-v3",
      size: 9,
    });
    expect(candidate).toHaveProperty("blob");
    expect(snapshots).toEqual([]);
    expect(snapshotRevisionIndexUnique).toBe(true);
  });

  it("closes its connection when a newer database version is requested", async () => {
    await openGifCraftDatabase();
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(
        GIF_CRAFT_DATABASE_NAME,
        GIF_CRAFT_DATABASE_VERSION + 1,
      );
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    expect(upgraded.version).toBe(GIF_CRAFT_DATABASE_VERSION + 1);
    upgraded.close();
  });

  it("isolates corrupted v1 records instead of losing the complete history", async () => {
    const database = await openGifCraftDatabase();
    const transaction = database.transaction(STORAGE_STORES.sourceImages, "readwrite");
    transaction.objectStore(STORAGE_STORES.sourceImages).put({
      id: "broken",
      createdAt: 123,
      dataUrl: null,
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    await saveSourceImage(legacyAsset);

    await expect(listSourceImages()).resolves.toEqual([legacyAsset]);
  });
});
