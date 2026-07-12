export const GIF_CRAFT_DATABASE_NAME = "gif-craft";
export const GIF_CRAFT_DATABASE_VERSION = 4;

export const STORAGE_STORES = {
  sourceImages: "source-images",
  generationJobs: "generation-jobs",
  frameResources: "frame-resources",
  frameWorkspaces: "frame-workspaces",
  workspaceFrameResources: "workspace-frame-resources",
  frameWorkspaceSnapshots: "frame-workspace-snapshots",
  storageMeta: "storage-meta",
} as const;

export class DatabaseBlockedError extends Error {
  constructor() {
    super("数据库升级被其他页面阻止，请关闭其他 GIF CRAFT 页面后重试。");
    this.name = "DatabaseBlockedError";
  }
}

let databasePromise: Promise<IDBDatabase> | undefined;

function createStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(STORAGE_STORES.sourceImages)) {
    const sourceImages = database.createObjectStore(STORAGE_STORES.sourceImages, {
      keyPath: "id",
    });
    sourceImages.createIndex("createdAt", "createdAt");
  }

  if (!database.objectStoreNames.contains(STORAGE_STORES.generationJobs)) {
    const jobs = database.createObjectStore(STORAGE_STORES.generationJobs, {
      keyPath: "id",
    });
    jobs.createIndex("clientRequestId", "clientRequestId", { unique: true });
    jobs.createIndex("sourceImageId", "sourceImageId");
    jobs.createIndex("status", "status");
    jobs.createIndex("createdAt", "createdAt");
    jobs.createIndex("updatedAt", "updatedAt");
    jobs.createIndex("providerExternalJob", ["provider", "externalJobId"]);
  }

  if (!database.objectStoreNames.contains(STORAGE_STORES.frameResources)) {
    const frames = database.createObjectStore(STORAGE_STORES.frameResources, {
      keyPath: "id",
    });
    frames.createIndex("jobId", "jobId");
    frames.createIndex("jobAndSequenceIndex", ["jobId", "sequenceIndex"], {
      unique: true,
    });
    frames.createIndex("createdAt", "createdAt");
  }

  if (!database.objectStoreNames.contains(STORAGE_STORES.frameWorkspaces)) {
    const workspaces = database.createObjectStore(STORAGE_STORES.frameWorkspaces, {
      keyPath: "workspaceId",
    });
    workspaces.createIndex("sourceJobId", "sourceJobId", { unique: true });
    workspaces.createIndex("createdAt", "createdAt");
    workspaces.createIndex("updatedAt", "updatedAt");
  }

  if (!database.objectStoreNames.contains(STORAGE_STORES.workspaceFrameResources)) {
    const resources = database.createObjectStore(
      STORAGE_STORES.workspaceFrameResources,
      { keyPath: "id" },
    );
    resources.createIndex("workspaceId", "workspaceId");
    resources.createIndex("workspaceAndSlot", ["workspaceId", "slotId"]);
    resources.createIndex("attemptId", "attemptId");
    resources.createIndex("childJobId", "childJobId");
    resources.createIndex("createdAt", "createdAt");
  }

  if (!database.objectStoreNames.contains(STORAGE_STORES.frameWorkspaceSnapshots)) {
    const snapshots = database.createObjectStore(
      STORAGE_STORES.frameWorkspaceSnapshots,
      { keyPath: "snapshotId" },
    );
    snapshots.createIndex("workspaceId", "workspaceId");
    snapshots.createIndex("workspaceAndRevision", ["workspaceId", "revision"], {
      unique: true,
    });
    snapshots.createIndex("createdAt", "createdAt");
  }

  if (!database.objectStoreNames.contains(STORAGE_STORES.storageMeta)) {
    database.createObjectStore(STORAGE_STORES.storageMeta, { keyPath: "key" });
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      GIF_CRAFT_DATABASE_NAME,
      GIF_CRAFT_DATABASE_VERSION,
    );
    let blocked = false;

    request.onupgradeneeded = () => createStores(request.result);
    request.onblocked = () => {
      blocked = true;
      reject(new DatabaseBlockedError());
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开本地数据库。"));
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
  });
}

export function openGifCraftDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = openDatabase().catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

export async function closeGifCraftDatabase(): Promise<void> {
  const current = databasePromise;
  databasePromise = undefined;
  if (current) {
    const database = await current.catch(() => undefined);
    database?.close();
  }
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地数据库请求失败。"));
  });
}

export function transactionCommitted(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("事务已中止。", "AbortError"));
    transaction.onerror = () => {
      // IndexedDB 会在 error 后触发 abort；统一由 onabort 返回最终错误。
    };
  });
}

export async function committedRequestResult<T>(
  request: IDBRequest<T>,
  transaction: IDBTransaction,
): Promise<T> {
  const committed = transactionCommitted(transaction);
  try {
    const result = await requestResult(request);
    await committed;
    return result;
  } catch (error) {
    await committed.catch(() => undefined);
    throw error;
  }
}
