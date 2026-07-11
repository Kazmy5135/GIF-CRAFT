import type { Frame, GenerationJob } from "../../core/sequenceGeneration";
import {
  committedRequestResult,
  openGifCraftDatabase,
  requestResult,
  STORAGE_STORES,
  transactionCommitted,
} from "./database";

const FRAME_BYTES_META_KEY = "frame-resource-bytes";
const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_SEQUENCE_RETENTION = {
  maxCompletedJobs: 20,
  maxAgeMs: 30 * DAY_MS,
  maxTerminalJobs: 100,
  metadataMaxAgeMs: 90 * DAY_MS,
  orphanAgeMs: DAY_MS,
  fallbackBudgetBytes: 512 * 1024 * 1024,
  maximumBudgetBytes: 1024 * 1024 * 1024,
  quotaFraction: 0.6,
  cleanupThresholdFraction: 0.8,
  cleanupTargetFraction: 0.7,
  hardLimitFraction: 0.9,
} as const;

export interface StoredGenerationJob<TJob = GenerationJob> {
  id: string;
  clientRequestId: string;
  sourceImageId: string;
  provider: string;
  externalJobId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** Storage-layer availability; the immutable domain job keeps its original frame IDs. */
  resultStorageStatus?: "available" | "purged";
  resultPurgedAt?: string;
  /** Bytes currently owned by this job in frame-resources; zero after result purge. */
  resultBytes: number;
  job: TJob;
}

export interface StoredFrameResource<TFrame = Frame> {
  id: string;
  jobId: string;
  sequenceIndex: number;
  createdAt: string;
  frame: TFrame;
  blob: Blob;
  size: number;
}

interface StorageMetaRecord {
  key: typeof FRAME_BYTES_META_KEY;
  value: number;
  updatedAt: string;
}

export interface SequenceStorageBudget {
  budgetBytes: number;
  usageBytes?: number;
  quotaBytes?: number;
  availableBytes?: number;
}

export interface SequenceStorageCapacityDecision {
  allowed: boolean;
  reason?: "managed_budget_exceeded" | "origin_quota_insufficient";
  requiredBytes: number;
  hardLimitBytes: number;
}

export interface CleanupSequenceStorageOptions {
  now?: Date;
  protectedJobIds?: Iterable<string>;
  maxCompletedJobs?: number;
  maxAgeMs?: number;
  maxTerminalJobs?: number;
  metadataMaxAgeMs?: number;
  orphanAgeMs?: number;
  budgetBytes?: number;
}

export interface CleanupSequenceStorageResult {
  deletedJobIds: string[];
  purgedJobIds: string[];
  deletedFrameIds: string[];
  bytesBefore: number;
  bytesAfter: number;
}

export class SequenceStorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SequenceStorageValidationError";
  }
}

export class SequenceStorageQuotaError extends Error {
  constructor(cause?: unknown) {
    super("本地存储空间不足，序列结果未能完整保存。", { cause });
    this.name = "SequenceStorageQuotaError";
  }
}

export function generationJobStorageRecord(
  job: GenerationJob,
): StoredGenerationJob<GenerationJob> {
  return {
    id: job.id,
    clientRequestId: job.clientRequestId,
    sourceImageId: job.request.source.id,
    provider: job.provider,
    externalJobId: job.externalJobRef,
    status: job.status,
    createdAt: job.timestamps.createdAt,
    updatedAt: job.timestamps.updatedAt,
    resultBytes: 0,
    job,
  };
}

export function frameResourceStorageRecord(
  frame: Frame,
  blob: Blob,
): StoredFrameResource<Frame> {
  return {
    id: frame.id,
    jobId: frame.jobId,
    sequenceIndex: frame.sequenceIndex,
    createdAt: frame.createdAt,
    frame,
    blob,
    size: blob.size,
  };
}

function containsPersistedImagePayload(value: unknown, seen = new Set<object>()): boolean {
  if (value instanceof Blob) return true;
  if (typeof value === "string") return /^data:image\//i.test(value) || /^blob:/i.test(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => containsPersistedImagePayload(item, seen));
}

function assertJobRecord<TJob>(job: StoredGenerationJob<TJob>): void {
  if (
    !job.id ||
    !job.clientRequestId ||
    !job.sourceImageId ||
    !job.provider ||
    !job.status ||
    !job.createdAt ||
    !job.updatedAt
  ) {
    throw new SequenceStorageValidationError("生成任务缺少持久化索引字段。");
  }
  if (!Number.isSafeInteger(job.resultBytes) || job.resultBytes < 0) {
    throw new SequenceStorageValidationError("任务结果资源字节数无效。 ");
  }
  if (containsPersistedImagePayload(job.job)) {
    throw new SequenceStorageValidationError(
      "任务元数据不能包含 Blob、data URL 或临时对象 URL。",
    );
  }
}

function assertFrameResources<TFrame>(
  jobId: string,
  resources: readonly StoredFrameResource<TFrame>[],
): void {
  const ids = new Set<string>();
  const indexes = new Set<number>();
  for (const resource of resources) {
    if (
      !resource.id ||
      resource.jobId !== jobId ||
      !Number.isInteger(resource.sequenceIndex) ||
      resource.sequenceIndex < 0 ||
      !(resource.blob instanceof Blob) ||
      resource.size !== resource.blob.size ||
      resource.size <= 0
    ) {
      throw new SequenceStorageValidationError("帧资源记录无效或与任务不匹配。");
    }
    if (ids.has(resource.id) || indexes.has(resource.sequenceIndex)) {
      throw new SequenceStorageValidationError("帧 ID 和任务内序号必须唯一。");
    }
    if (containsPersistedImagePayload(resource.frame)) {
      throw new SequenceStorageValidationError(
        "帧元数据不能再次嵌入 Blob、data URL 或临时对象 URL。",
      );
    }
    if (resource.frame && typeof resource.frame === "object") {
      const metadata = resource.frame as Partial<Frame>;
      if (
        (metadata.id !== undefined && metadata.id !== resource.id) ||
        (metadata.jobId !== undefined && metadata.jobId !== resource.jobId) ||
        (metadata.sequenceIndex !== undefined &&
          metadata.sequenceIndex !== resource.sequenceIndex) ||
        (metadata.size !== undefined && metadata.size !== resource.size)
      ) {
        throw new SequenceStorageValidationError("帧元数据与 Blob 存储索引不一致。");
      }
    }
    ids.add(resource.id);
    indexes.add(resource.sequenceIndex);
  }
}

export function normalizeSequenceStorageError(error: unknown): never {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    throw new SequenceStorageQuotaError(error);
  }
  throw error;
}

export async function estimateSequenceStorageBudget(): Promise<SequenceStorageBudget> {
  const estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => undefined);
  const quotaBytes = estimate?.quota;
  const usageBytes = estimate?.usage;
  const budgetBytes = quotaBytes
    ? Math.min(
        DEFAULT_SEQUENCE_RETENTION.maximumBudgetBytes,
        Math.floor(quotaBytes * DEFAULT_SEQUENCE_RETENTION.quotaFraction),
      )
    : DEFAULT_SEQUENCE_RETENTION.fallbackBudgetBytes;
  return {
    budgetBytes,
    usageBytes,
    quotaBytes,
    availableBytes:
      quotaBytes !== undefined && usageBytes !== undefined
        ? Math.max(0, quotaBytes - usageBytes)
        : undefined,
  };
}

export function assessSequenceStorageCapacity(input: {
  budget: SequenceStorageBudget;
  managedBytes: number;
  expectedWriteBytes: number;
}): SequenceStorageCapacityDecision {
  const expectedWriteBytes = Math.max(0, input.expectedWriteBytes);
  const hardLimitBytes = Math.floor(
    input.budget.budgetBytes * DEFAULT_SEQUENCE_RETENTION.hardLimitFraction,
  );
  if (input.managedBytes + expectedWriteBytes > hardLimitBytes) {
    return {
      allowed: false,
      reason: "managed_budget_exceeded",
      requiredBytes: expectedWriteBytes,
      hardLimitBytes,
    };
  }
  if (
    input.budget.availableBytes !== undefined &&
    input.budget.availableBytes < Math.ceil(expectedWriteBytes * 1.25)
  ) {
    return {
      allowed: false,
      reason: "origin_quota_insufficient",
      requiredBytes: expectedWriteBytes,
      hardLimitBytes,
    };
  }
  return { allowed: true, requiredBytes: expectedWriteBytes, hardLimitBytes };
}

export async function getManagedFrameBytes(): Promise<number> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.storageMeta, "readonly");
  const meta = await committedRequestResult<StorageMetaRecord | undefined>(
    transaction.objectStore(STORAGE_STORES.storageMeta).get(FRAME_BYTES_META_KEY),
    transaction,
  );
  return Math.max(0, meta?.value ?? 0);
}

export async function checkSequenceStorageCapacity(
  expectedWriteBytes: number,
  cleanupOptions: CleanupSequenceStorageOptions = {},
): Promise<SequenceStorageCapacityDecision> {
  const budget = await estimateSequenceStorageBudget();
  await cleanupSequenceStorage({
    ...cleanupOptions,
    budgetBytes: cleanupOptions.budgetBytes ?? budget.budgetBytes,
  });
  const managedBytes = await getManagedFrameBytes();
  return assessSequenceStorageCapacity({ budget, managedBytes, expectedWriteBytes });
}

export async function saveGenerationJob<TJob>(
  job: StoredGenerationJob<TJob>,
): Promise<void> {
  assertJobRecord(job);
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.generationJobs, "readwrite");
  const committed = transactionCommitted(transaction);
  transaction.objectStore(STORAGE_STORES.generationJobs).put(job);
  await committed.catch(normalizeSequenceStorageError);
}

export async function getGenerationJob<TJob = GenerationJob>(
  id: string,
): Promise<StoredGenerationJob<TJob> | undefined> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.generationJobs, "readonly");
  const job = await committedRequestResult<StoredGenerationJob<TJob> | undefined>(
    transaction.objectStore(STORAGE_STORES.generationJobs).get(id),
    transaction,
  );
  return job;
}

export async function getGenerationJobByClientRequestId<TJob = GenerationJob>(
  clientRequestId: string,
): Promise<StoredGenerationJob<TJob> | undefined> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.generationJobs, "readonly");
  const job = await committedRequestResult<StoredGenerationJob<TJob> | undefined>(
    transaction
      .objectStore(STORAGE_STORES.generationJobs)
      .index("clientRequestId")
      .get(clientRequestId),
    transaction,
  );
  return job;
}

export async function listGenerationJobs<TJob = GenerationJob>(): Promise<
  StoredGenerationJob<TJob>[]
> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.generationJobs, "readonly");
  const jobs = await committedRequestResult<StoredGenerationJob<TJob>[]>(
    transaction.objectStore(STORAGE_STORES.generationJobs).getAll(),
    transaction,
  );
  return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listFrameResources<TFrame = Frame>(
  jobId: string,
): Promise<StoredFrameResource<TFrame>[]> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.frameResources, "readonly");
  const resources = await committedRequestResult<StoredFrameResource<TFrame>[]>(
    transaction.objectStore(STORAGE_STORES.frameResources).index("jobId").getAll(jobId),
    transaction,
  );
  return resources.sort((a, b) => a.sequenceIndex - b.sequenceIndex);
}

export async function saveCompletedGenerationResult<TJob, TFrame>(
  job: StoredGenerationJob<TJob>,
  resources: readonly StoredFrameResource<TFrame>[],
): Promise<void> {
  assertJobRecord(job);
  if (job.status !== "completed") {
    throw new SequenceStorageValidationError("只有完整任务可以原子保存结果。");
  }
  assertFrameResources(job.id, resources);
  if (job.job && typeof job.job === "object") {
    const metadata = job.job as Partial<GenerationJob>;
    if (metadata.resultIntegrity && metadata.resultIntegrity.status !== "complete") {
      throw new SequenceStorageValidationError("结果完整性校验通过前不能持久化完成任务。");
    }
    if (metadata.frameIds) {
      const orderedResourceIds = [...resources]
        .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
        .map((resource) => resource.id);
      if (
        metadata.frameIds.length !== orderedResourceIds.length ||
        metadata.frameIds.some((id, index) => id !== orderedResourceIds[index])
      ) {
        throw new SequenceStorageValidationError("任务帧引用与原子保存的资源集合不一致。");
      }
    }
  }

  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [
      STORAGE_STORES.generationJobs,
      STORAGE_STORES.frameResources,
      STORAGE_STORES.storageMeta,
    ],
    "readwrite",
  );
  const committed = transactionCommitted(transaction);
  const jobStore = transaction.objectStore(STORAGE_STORES.generationJobs);
  const frameStore = transaction.objectStore(STORAGE_STORES.frameResources);
  const metaStore = transaction.objectStore(STORAGE_STORES.storageMeta);
  const existingJobRequest = jobStore.get(job.id);
  const metaRequest = metaStore.get(FRAME_BYTES_META_KEY);
  const [existingJob, meta] = await Promise.all([
    requestResult<StoredGenerationJob | undefined>(existingJobRequest),
    requestResult<StorageMetaRecord | undefined>(metaRequest),
  ]);
  await deleteFrameKeysByJob(frameStore, job.id);
  const previousJobBytes = existingJob?.resultBytes ?? 0;
  const newJobBytes = resources.reduce((sum, item) => sum + item.size, 0);
  for (const item of resources) frameStore.put(item);
  jobStore.put({
    ...job,
    resultStorageStatus: "available",
    resultPurgedAt: undefined,
    resultBytes: newJobBytes,
  } satisfies StoredGenerationJob<TJob>);
  metaStore.put({
    key: FRAME_BYTES_META_KEY,
    value: Math.max(meta?.value ?? 0, previousJobBytes) - previousJobBytes + newJobBytes,
    updatedAt: new Date().toISOString(),
  } satisfies StorageMetaRecord);

  await committed.catch(normalizeSequenceStorageError);
}

function deleteFrameKeysByJob(
  frameStore: IDBObjectStore,
  jobId: string,
  deletedFrameIds?: string[],
  scheduledFrameIds: Set<string> = new Set(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = frameStore.index("jobId").openKeyCursor(jobId);
    request.onerror = () => reject(request.error ?? new Error("无法遍历任务帧资源索引。"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const frameId = String(cursor.primaryKey);
      if (!scheduledFrameIds.has(frameId)) {
        scheduledFrameIds.add(frameId);
        frameStore.delete(cursor.primaryKey);
        deletedFrameIds?.push(frameId);
      }
      cursor.continue();
    };
  });
}

async function deleteOldOrphanFrameKeys(
  frameStore: IDBObjectStore,
  jobIds: ReadonlySet<string>,
  cutoff: string,
  deletedFrameIds: string[],
  scheduledFrameIds: Set<string>,
): Promise<number> {
  const oldFrameIds = await new Promise<Set<string>>((resolve, reject) => {
    const ids = new Set<string>();
    const request = frameStore.index("createdAt").openKeyCursor();
    request.onerror = () => reject(request.error ?? new Error("无法遍历帧资源时间索引。"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(ids);
        return;
      }
      if (String(cursor.key) <= cutoff) ids.add(String(cursor.primaryKey));
      cursor.continue();
    };
  });
  await new Promise<void>((resolve, reject) => {
    const request = frameStore.index("jobId").openKeyCursor();
    request.onerror = () => reject(request.error ?? new Error("无法遍历帧资源任务索引。"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const frameId = String(cursor.primaryKey);
      const jobId = String(cursor.key);
      if (
        oldFrameIds.has(frameId) &&
        !jobIds.has(jobId) &&
        !scheduledFrameIds.has(frameId)
      ) {
        scheduledFrameIds.add(frameId);
        frameStore.delete(cursor.primaryKey);
        deletedFrameIds.push(frameId);
      }
      cursor.continue();
    };
  });
  // Orphans have no owning job metadata, so their size cannot be read without
  // cloning the Blob value. Keep the managed-byte counter conservative.
  return 0;
}

export async function cleanupSequenceStorage(
  options: CleanupSequenceStorageOptions = {},
): Promise<CleanupSequenceStorageResult> {
  const now = options.now ?? new Date();
  const protectedJobIds = new Set(options.protectedJobIds ?? []);
  const maxCompletedJobs =
    options.maxCompletedJobs ?? DEFAULT_SEQUENCE_RETENTION.maxCompletedJobs;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_SEQUENCE_RETENTION.maxAgeMs;
  const maxTerminalJobs =
    options.maxTerminalJobs ?? DEFAULT_SEQUENCE_RETENTION.maxTerminalJobs;
  const metadataMaxAgeMs =
    options.metadataMaxAgeMs ?? DEFAULT_SEQUENCE_RETENTION.metadataMaxAgeMs;
  const orphanAgeMs = options.orphanAgeMs ?? DEFAULT_SEQUENCE_RETENTION.orphanAgeMs;
  const budget = options.budgetBytes ?? (await estimateSequenceStorageBudget()).budgetBytes;
  const cleanupThreshold = budget * DEFAULT_SEQUENCE_RETENTION.cleanupThresholdFraction;
  const cleanupTarget = budget * DEFAULT_SEQUENCE_RETENTION.cleanupTargetFraction;

  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [
      STORAGE_STORES.generationJobs,
      STORAGE_STORES.frameResources,
      STORAGE_STORES.storageMeta,
    ],
    "readwrite",
  );
  const committed = transactionCommitted(transaction);
  const jobStore = transaction.objectStore(STORAGE_STORES.generationJobs);
  const frameStore = transaction.objectStore(STORAGE_STORES.frameResources);
  const metaStore = transaction.objectStore(STORAGE_STORES.storageMeta);
  const jobsRequest = jobStore.getAll();
  const metaRequest = metaStore.get(FRAME_BYTES_META_KEY);
  const result: CleanupSequenceStorageResult = {
    deletedJobIds: [],
    purgedJobIds: [],
    deletedFrameIds: [],
    bytesBefore: 0,
    bytesAfter: 0,
  };
  const [jobs, meta] = await Promise.all([
    requestResult<StoredGenerationJob[]>(jobsRequest),
    requestResult<StorageMetaRecord | undefined>(metaRequest),
  ]);
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const trackedBytes = jobs.reduce((sum, job) => sum + (job.resultBytes ?? 0), 0);
  result.bytesBefore = Math.max(0, meta?.value ?? 0, trackedBytes);

  // Unknown means the remote outcome is unresolved and is deliberately retained.
  // Only an explicit local abandon decision makes that record eligible for 100/90 cleanup.
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "abandoned"]);
  const terminal = jobs
    .filter((job) => terminalStatuses.has(job.status) && !protectedJobIds.has(job.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const deleteMetadata = new Set<string>();
  terminal.forEach((job, index) => {
    const age = now.getTime() - new Date(job.updatedAt).getTime();
    if (index >= maxTerminalJobs || !Number.isFinite(age) || age > metadataMaxAgeMs) {
      deleteMetadata.add(job.id);
    }
  });

  const completed = jobs
    .filter(
      (job) =>
        job.status === "completed" &&
        !protectedJobIds.has(job.id) &&
        !deleteMetadata.has(job.id) &&
        (job.resultBytes ?? 0) > 0,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const purgeResults = new Set<string>();
  completed.forEach((job, index) => {
    const age = now.getTime() - new Date(job.updatedAt).getTime();
    if (index >= maxCompletedJobs || !Number.isFinite(age) || age > maxAgeMs) {
      purgeResults.add(job.id);
    }
  });

  let projectedBytes = result.bytesBefore;
  for (const jobId of deleteMetadata) projectedBytes -= jobById.get(jobId)?.resultBytes ?? 0;
  for (const jobId of purgeResults) projectedBytes -= jobById.get(jobId)?.resultBytes ?? 0;
  if (projectedBytes > cleanupThreshold) {
    for (const job of [...completed].reverse()) {
      if (projectedBytes <= cleanupTarget) break;
      if (purgeResults.has(job.id)) continue;
      purgeResults.add(job.id);
      projectedBytes -= job.resultBytes ?? 0;
    }
  }

  const scheduledFrameIds = new Set<string>();
  const frameDeletionJobIds = new Set([...deleteMetadata, ...purgeResults]);
  const deletionTasks = [...frameDeletionJobIds].map((jobId) =>
    deleteFrameKeysByJob(
      frameStore,
      jobId,
      result.deletedFrameIds,
      scheduledFrameIds,
    ),
  );
  const orphanCutoff = new Date(now.getTime() - orphanAgeMs).toISOString();
  const orphanBytesPromise = deleteOldOrphanFrameKeys(
    frameStore,
    new Set(jobById.keys()),
    orphanCutoff,
    result.deletedFrameIds,
    scheduledFrameIds,
  );
  const [, orphanBytes] = await Promise.all([
    Promise.all(deletionTasks),
    orphanBytesPromise,
  ]);

  for (const jobId of purgeResults) {
    const job = jobById.get(jobId);
    if (!job || deleteMetadata.has(jobId)) continue;
    jobStore.put({
      ...job,
      resultStorageStatus: "purged",
      resultPurgedAt: now.toISOString(),
      resultBytes: 0,
    } satisfies StoredGenerationJob);
    result.purgedJobIds.push(jobId);
  }
  for (const jobId of deleteMetadata) {
    jobStore.delete(jobId);
    result.deletedJobIds.push(jobId);
  }
  const deletedTrackedBytes = [...frameDeletionJobIds].reduce(
    (sum, jobId) => sum + (jobById.get(jobId)?.resultBytes ?? 0),
    0,
  );
  result.bytesAfter = Math.max(0, result.bytesBefore - deletedTrackedBytes - orphanBytes);
  metaStore.put({
    key: FRAME_BYTES_META_KEY,
    value: result.bytesAfter,
    updatedAt: now.toISOString(),
  } satisfies StorageMetaRecord);

  await committed.catch(normalizeSequenceStorageError);
  return result;
}
