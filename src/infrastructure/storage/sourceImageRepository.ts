import type { SourceImageAsset } from "../../core/sourceImage";

const DB_NAME = "gif-craft";
const DB_VERSION = 1;
const STORE_NAME = "source-images";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function listSourceImages(): Promise<SourceImageAsset[]> {
  const items = await withStore<SourceImageAsset[]>("readonly", (store) =>
    store.getAll(),
  );
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveSourceImage(asset: SourceImageAsset): Promise<void> {
  await withStore<IDBValidKey>("readwrite", (store) => store.put(asset));
}

export async function deleteSourceImage(id: string): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.delete(id));
}
