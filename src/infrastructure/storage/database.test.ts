import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceImageAsset } from "../../core/sourceImage";
import {
  closeGifCraftDatabase,
  DatabaseBlockedError,
  GIF_CRAFT_DATABASE_NAME,
  GIF_CRAFT_DATABASE_VERSION,
  openGifCraftDatabase,
  STORAGE_STORES,
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

  it("returns a deterministic error when another page blocks the v2 upgrade", async () => {
    const legacy = await openLegacyDatabase();

    await expect(openGifCraftDatabase()).rejects.toBeInstanceOf(DatabaseBlockedError);
    legacy.close();
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
