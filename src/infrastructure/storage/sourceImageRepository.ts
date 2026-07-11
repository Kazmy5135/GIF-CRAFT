import type { SourceImageAsset } from "../../core/sourceImage";
import {
  committedRequestResult,
  openGifCraftDatabase,
  STORAGE_STORES,
  transactionCommitted,
} from "./database";

export class SourceImageInUseError extends Error {
  constructor(id: string) {
    super(`源图 ${id} 已被序列任务引用，不能删除。`);
    this.name = "SourceImageInUseError";
  }
}

function isSourceImageAsset(value: unknown): value is SourceImageAsset {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SourceImageAsset>;
  return (
    typeof record.id === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.dataUrl === "string" &&
    typeof record.mimeType === "string"
  );
}

export async function listSourceImages(): Promise<SourceImageAsset[]> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.sourceImages, "readonly");
  const items = await committedRequestResult<unknown[]>(
    transaction.objectStore(STORAGE_STORES.sourceImages).getAll(),
    transaction,
  );
  return items
    .filter(isSourceImageAsset)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSourceImage(id: string): Promise<SourceImageAsset | undefined> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.sourceImages, "readonly");
  const item = await committedRequestResult<unknown>(
    transaction.objectStore(STORAGE_STORES.sourceImages).get(id),
    transaction,
  );
  return isSourceImageAsset(item) ? item : undefined;
}

export async function saveSourceImage(asset: SourceImageAsset): Promise<void> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.sourceImages, "readwrite");
  const committed = transactionCommitted(transaction);
  transaction.objectStore(STORAGE_STORES.sourceImages).put(asset);
  await committed;
}

export async function deleteSourceImage(id: string): Promise<void> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [STORAGE_STORES.sourceImages, STORAGE_STORES.generationJobs],
    "readwrite",
  );
  let guardError: SourceImageInUseError | undefined;
  const committed = transactionCommitted(transaction).catch((error: unknown) => {
    throw guardError ?? error;
  });
  const jobs = transaction.objectStore(STORAGE_STORES.generationJobs);
  const countRequest = jobs.index("sourceImageId").count(id);
  countRequest.onsuccess = () => {
    if (countRequest.result > 0) {
      guardError = new SourceImageInUseError(id);
      transaction.abort();
      return;
    }
    transaction.objectStore(STORAGE_STORES.sourceImages).delete(id);
  };
  await committed;
}
