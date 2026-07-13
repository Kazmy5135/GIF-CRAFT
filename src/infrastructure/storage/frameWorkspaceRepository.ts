import {
  freezeFrameWorkspaceSnapshot,
  markFrameWorkspacePersisted,
  restoreFrameWorkspaceDefaults,
  type FrameRevision,
  type FrameWorkspace,
  type FrameWorkspaceSnapshot,
  type FrameWorkspaceSnapshotFrame,
} from "../../core/frameWorkspace";
import {
  committedRequestResult,
  openGifCraftDatabase,
  requestResult,
  STORAGE_STORES,
  transactionCommitted,
} from "./database";
import {
  assessSequenceStorageCapacity,
  estimateSequenceStorageBudget,
  getManagedFrameBytes,
  type StoredFrameResource,
} from "./sequenceJobRepository";

const WORKSPACE_FRAME_BYTES_META_KEY = "workspace-frame-resource-bytes";
const DEFAULT_ORPHAN_AGE_MS = 24 * 60 * 60 * 1_000;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface WorkspaceFrameBytesMetaRecord {
  key: typeof WORKSPACE_FRAME_BYTES_META_KEY;
  value: number;
  updatedAt: string;
}

export interface StoredFrameWorkspace<TWorkspace = FrameWorkspace> {
  workspaceId: string;
  /** The immutable generation job used to create this workspace. Unique per workspace. */
  sourceJobId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceFrameIds: readonly string[];
  candidateResourceIds: readonly string[];
  retryJobIds: readonly string[];
  activeRetryJobIds: readonly string[];
  workspace: TWorkspace;
}

export interface StoredWorkspaceFrameResource<TRevision = FrameRevision> {
  id: string;
  workspaceId: string;
  slotId: string;
  attemptId: string;
  sourceJobId: string;
  childJobId?: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
  createdAt: string;
  adoptedAt?: string;
  adoptedRevision?: number;
  revision: TRevision;
  blob: Blob;
}

export interface FrameWorkspaceProtectionGraph {
  sourceJobIds: Set<string>;
  sourceFrameIds: Set<string>;
  candidateResourceIds: Set<string>;
  activeRetryJobIds: Set<string>;
}

export interface WorkspaceCandidateCapacityDecision {
  allowed: boolean;
  reason?: "managed_budget_exceeded" | "origin_quota_insufficient";
  requiredBytes: number;
  hardLimitBytes: number;
}

export interface WorkspaceCandidateCleanupResult {
  deletedResourceIds: string[];
  bytesBefore: number;
  bytesAfter: number;
}

export class FrameWorkspaceValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FrameWorkspaceValidationError";
  }
}

export class FrameWorkspaceAlreadyExistsError extends Error {
  constructor(readonly sourceJobId: string) {
    super("该生成任务已经拥有帧工作区，请加载现有工作区。");
    this.name = "FrameWorkspaceAlreadyExistsError";
  }
}

export class FrameWorkspaceNotFoundError extends Error {
  constructor(readonly workspaceId: string) {
    super("帧工作区不存在或已被删除。");
    this.name = "FrameWorkspaceNotFoundError";
  }
}

export class FrameWorkspaceRevisionConflictError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number | undefined,
  ) {
    super("帧工作区已在其他页面更新，请重新加载后再试。");
    this.name = "FrameWorkspaceRevisionConflictError";
  }
}

export class WorkspaceCandidateQuotaError extends Error {
  constructor(cause?: unknown) {
    super("本地存储空间不足，候选帧未保存，当前工作区保持不变。", { cause });
    this.name = "WorkspaceCandidateQuotaError";
  }
}

export class FrameWorkspaceSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameWorkspaceSnapshotValidationError";
  }
}

export class FrameWorkspaceSnapshotAlreadyExistsError extends Error {
  constructor(
    readonly snapshotId: string,
    readonly workspaceId: string,
    readonly revision: number,
  ) {
    super("该工作区修订已经保存过不可变快照，不能覆盖历史记录。");
    this.name = "FrameWorkspaceSnapshotAlreadyExistsError";
  }
}

export function frameWorkspaceStorageRecord(
  workspace: FrameWorkspace,
): StoredFrameWorkspace<FrameWorkspace> {
  const restoredWorkspace = restoreFrameWorkspaceDefaults(workspace);
  const persistedWorkspace = markFrameWorkspacePersisted(restoredWorkspace, restoredWorkspace.revision);
  const retryAttempts = Object.values(persistedWorkspace.retryAttempts);
  const activeStatuses = new Set([
    "submitting",
    "running",
    "candidate_ready",
    "status_unknown",
  ]);
  return {
    workspaceId: persistedWorkspace.workspaceId,
    sourceJobId: persistedWorkspace.sourceJobId,
    revision: persistedWorkspace.revision,
    createdAt: persistedWorkspace.createdAt,
    updatedAt: persistedWorkspace.updatedAt,
    sourceFrameIds: Object.values(persistedWorkspace.slots).map(
      (slot) => slot.originalFrameId,
    ),
    candidateResourceIds: Object.values(persistedWorkspace.revisions)
      .filter((revision) => revision.source === "retry_candidate")
      .map((revision) => revision.resourceRef),
    retryJobIds: retryAttempts.flatMap((attempt) =>
      attempt.childGenerationJobId ? [attempt.childGenerationJobId] : [],
    ),
    activeRetryJobIds: retryAttempts.flatMap((attempt) =>
      attempt.childGenerationJobId && activeStatuses.has(attempt.status)
        ? [attempt.childGenerationJobId]
        : [],
    ),
    workspace: persistedWorkspace,
  };
}

export function workspaceFrameResourceStorageRecord(input: {
  revision: FrameRevision;
  sourceJobId: string;
  blob: Blob;
  childJobId?: string;
}): StoredWorkspaceFrameResource<FrameRevision> {
  if (input.revision.source !== "retry_candidate" || !input.revision.retryAttemptId) {
    throw new FrameWorkspaceValidationError("只有带重试尝试引用的候选修订可以保存新 Blob。");
  }
  return {
    id: input.revision.resourceRef,
    workspaceId: input.revision.workspaceId,
    slotId: input.revision.slotId,
    attemptId: input.revision.retryAttemptId,
    sourceJobId: input.sourceJobId,
    childJobId: input.childJobId,
    mimeType: input.revision.mimeType,
    width: input.revision.width,
    height: input.revision.height,
    size: input.revision.size,
    createdAt: input.revision.createdAt,
    revision: input.revision,
    blob: input.blob,
  };
}

function containsUnsafePayload(value: unknown, seen = new Set<object>()): boolean {
  if (value instanceof Blob) return true;
  if (typeof value === "string") {
    if (/^(data:image\/|blob:)/i.test(value)) return true;
    if (
      /^https?:\/\//i.test(value) &&
      /[?&](?:[^=&]*(?:token|signature|credential|expires|x-amz-|x-goog-|googleaccessid|access[_-]?key)[^=&]*|sig|se)=/i.test(
        value,
      )
    ) {
      return true;
    }
    return false;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => containsUnsafePayload(item, seen));
}

function assertUniqueStrings(values: readonly string[], field: string): void {
  if (values.some((value) => !value.trim()) || new Set(values).size !== values.length) {
    throw new FrameWorkspaceValidationError(`${field} 必须是无重复的非空 ID 列表。`);
  }
}

function assertWorkspaceRecord<TWorkspace>(record: StoredFrameWorkspace<TWorkspace>): void {
  if (
    !record.workspaceId.trim() ||
    !record.sourceJobId.trim() ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !record.createdAt ||
    !record.updatedAt ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    Number.isNaN(Date.parse(record.updatedAt))
  ) {
    throw new FrameWorkspaceValidationError("工作区缺少有效的持久化索引字段。");
  }
  assertUniqueStrings(record.sourceFrameIds, "sourceFrameIds");
  assertUniqueStrings(record.candidateResourceIds, "candidateResourceIds");
  assertUniqueStrings(record.retryJobIds, "retryJobIds");
  assertUniqueStrings(record.activeRetryJobIds, "activeRetryJobIds");
  if (record.activeRetryJobIds.some((id) => !record.retryJobIds.includes(id))) {
    throw new FrameWorkspaceValidationError("活动重试任务必须包含在工作区重试引用中。");
  }
  if (containsUnsafePayload(record.workspace)) {
    throw new FrameWorkspaceValidationError(
      "工作区元数据不能包含 Blob、data URL、临时对象 URL 或完整签名 URL。",
    );
  }
}

function restoreWorkspaceRecordDefaults<TWorkspace>(
  record: StoredFrameWorkspace<TWorkspace> | undefined,
): StoredFrameWorkspace<TWorkspace> | undefined {
  if (!record || !record.workspace || typeof record.workspace !== "object") return record;
  const workspace = record.workspace as Partial<FrameWorkspace>;
  if (
    typeof workspace.workspaceId !== "string" ||
    typeof workspace.sourceJobId !== "string" ||
    !workspace.source ||
    !Array.isArray(workspace.orderedSlotIds)
  ) {
    return record;
  }
  const restored = restoreFrameWorkspaceDefaults(record.workspace as unknown as FrameWorkspace);
  return (restored as unknown) === record.workspace
    ? record
    : { ...record, workspace: restored as unknown as TWorkspace };
}

function assertCandidateResource<TRevision>(
  resource: StoredWorkspaceFrameResource<TRevision>,
): void {
  if (
    !resource.id.trim() ||
    !resource.workspaceId.trim() ||
    !resource.slotId.trim() ||
    !resource.attemptId.trim() ||
    !resource.sourceJobId.trim() ||
    !ALLOWED_IMAGE_MIME_TYPES.has(resource.mimeType) ||
    !(resource.blob instanceof Blob) ||
    resource.blob.size <= 0 ||
    resource.size !== resource.blob.size ||
    resource.blob.type !== resource.mimeType ||
    !Number.isSafeInteger(resource.width) ||
    resource.width <= 0 ||
    !Number.isSafeInteger(resource.height) ||
    resource.height <= 0 ||
    !resource.createdAt
  ) {
    throw new FrameWorkspaceValidationError("候选帧 Blob、尺寸、MIME、体积或归属无效。");
  }
  if (
    (resource.adoptedRevision === undefined) !== (resource.adoptedAt === undefined) ||
    (resource.adoptedRevision !== undefined &&
      (!Number.isSafeInteger(resource.adoptedRevision) || resource.adoptedRevision < 1))
  ) {
    throw new FrameWorkspaceValidationError("候选帧采用标记不完整。");
  }
  if (containsUnsafePayload(resource.revision)) {
    throw new FrameWorkspaceValidationError(
      "候选帧元数据不能包含 Blob、data URL、临时对象 URL 或完整签名 URL。",
    );
  }
  if (resource.revision && typeof resource.revision === "object") {
    const metadata = resource.revision as Record<string, unknown>;
    const matches: readonly [string, unknown][] = [
      ["resourceRef", resource.id],
      ["workspaceId", resource.workspaceId],
      ["slotId", resource.slotId],
      ["attemptId", resource.attemptId],
      ["sourceJobId", resource.sourceJobId],
      ["mimeType", resource.mimeType],
      ["width", resource.width],
      ["height", resource.height],
      ["size", resource.size],
    ];
    for (const [field, expected] of matches) {
      if (metadata[field] !== undefined && metadata[field] !== expected) {
        throw new FrameWorkspaceValidationError(`候选帧元数据字段 ${field} 与资源不一致。`);
      }
    }
    if (
      metadata.retryAttemptId !== undefined &&
      metadata.retryAttemptId !== resource.attemptId
    ) {
      throw new FrameWorkspaceValidationError(
        "候选帧元数据字段 retryAttemptId 与资源不一致。",
      );
    }
  }
}

async function readBlobPrefix(blob: Blob, length: number): Promise<Uint8Array> {
  const slice = blob.slice(0, length);
  if (typeof slice.arrayBuffer === "function") {
    return new Uint8Array(await slice.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取候选帧。"));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(slice);
  });
}

async function assertCandidateImageSignature<TRevision>(
  resource: StoredWorkspaceFrameResource<TRevision>,
): Promise<void> {
  const bytes = await readBlobPrefix(resource.blob, 12);
  const isPng =
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  const isJpeg =
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp =
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  const matchesMime =
    (resource.mimeType === "image/png" && isPng) ||
    (resource.mimeType === "image/jpeg" && isJpeg) ||
    (resource.mimeType === "image/webp" && isWebp);
  if (!matchesMime) {
    throw new FrameWorkspaceValidationError("候选帧内容不可读或与声明的 MIME 不匹配。");
  }

  if (typeof globalThis.createImageBitmap === "function") {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await globalThis.createImageBitmap(resource.blob);
      if (bitmap.width !== resource.width || bitmap.height !== resource.height) {
        throw new FrameWorkspaceValidationError("候选帧解码尺寸与声明尺寸不一致。");
      }
    } catch (error) {
      if (error instanceof FrameWorkspaceValidationError) throw error;
      throw new FrameWorkspaceValidationError("候选帧无法安全解码。", { cause: error });
    } finally {
      bitmap?.close();
    }
  }
}

function normalizeWorkspaceStorageError(error: unknown): never {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    throw new WorkspaceCandidateQuotaError(error);
  }
  throw error;
}

async function abortTransaction(transaction: IDBTransaction): Promise<void> {
  try {
    transaction.abort();
  } catch {
    // A request can already have aborted the transaction.
  }
}

export async function createFrameWorkspace<TWorkspace>(
  record: StoredFrameWorkspace<TWorkspace>,
): Promise<void> {
  assertWorkspaceRecord(record);
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.frameWorkspaces, "readwrite");
  const committed = transactionCommitted(transaction);
  transaction.objectStore(STORAGE_STORES.frameWorkspaces).add(record);
  try {
    await committed;
  } catch (error) {
    if (error instanceof DOMException && error.name === "ConstraintError") {
      throw new FrameWorkspaceAlreadyExistsError(record.sourceJobId);
    }
    throw error;
  }
}

export async function getFrameWorkspace<TWorkspace = FrameWorkspace>(
  workspaceId: string,
): Promise<StoredFrameWorkspace<TWorkspace> | undefined> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.frameWorkspaces, "readonly");
  const record = await committedRequestResult<StoredFrameWorkspace<TWorkspace> | undefined>(
    transaction.objectStore(STORAGE_STORES.frameWorkspaces).get(workspaceId),
    transaction,
  );
  return restoreWorkspaceRecordDefaults(record);
}

export async function getFrameWorkspaceByJobId<TWorkspace = FrameWorkspace>(
  jobId: string,
): Promise<StoredFrameWorkspace<TWorkspace> | undefined> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.frameWorkspaces, "readonly");
  const record = await committedRequestResult<StoredFrameWorkspace<TWorkspace> | undefined>(
    transaction.objectStore(STORAGE_STORES.frameWorkspaces).index("sourceJobId").get(jobId),
    transaction,
  );
  return restoreWorkspaceRecordDefaults(record);
}

export async function listFrameWorkspaces<TWorkspace = FrameWorkspace>(): Promise<
  StoredFrameWorkspace<TWorkspace>[]
> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.frameWorkspaces, "readonly");
  const workspaces = await committedRequestResult<StoredFrameWorkspace<TWorkspace>[]>(
    transaction.objectStore(STORAGE_STORES.frameWorkspaces).getAll(),
    transaction,
  );
  return workspaces
    .map((record) => restoreWorkspaceRecordDefaults(record)!)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function assertExpectedRevision<TWorkspace>(
  store: IDBObjectStore,
  workspaceId: string,
  expectedRevision: number,
): Promise<StoredFrameWorkspace<TWorkspace>> {
  const current = await requestResult<StoredFrameWorkspace<TWorkspace> | undefined>(
    store.get(workspaceId),
  );
  if (!current || current.revision !== expectedRevision) {
    throw new FrameWorkspaceRevisionConflictError(
      workspaceId,
      expectedRevision,
      current?.revision,
    );
  }
  return current;
}

function assertNextRevision<TWorkspace>(
  record: StoredFrameWorkspace<TWorkspace>,
  expectedRevision: number,
): void {
  if (record.revision <= expectedRevision) {
    throw new FrameWorkspaceValidationError("保存记录的 revision 必须高于预期持久化修订。");
  }
}

export async function saveFrameWorkspace<TWorkspace>(
  record: StoredFrameWorkspace<TWorkspace>,
  expectedRevision: number,
): Promise<void> {
  assertWorkspaceRecord(record);
  assertNextRevision(record, expectedRevision);
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.frameWorkspaces, "readwrite");
  const committed = transactionCommitted(transaction);
  const store = transaction.objectStore(STORAGE_STORES.frameWorkspaces);
  try {
    const current = await assertExpectedRevision<TWorkspace>(
      store,
      record.workspaceId,
      expectedRevision,
    );
    if (current.sourceJobId !== record.sourceJobId || current.createdAt !== record.createdAt) {
      throw new FrameWorkspaceValidationError("工作区来源任务和创建时间不可修改。");
    }
    store.put(record);
    await committed;
  } catch (error) {
    await abortTransaction(transaction);
    await committed.catch(() => undefined);
    throw error;
  }
}

export async function getManagedWorkspaceFrameBytes(): Promise<number> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(STORAGE_STORES.storageMeta, "readonly");
  const meta = await committedRequestResult<WorkspaceFrameBytesMetaRecord | undefined>(
    transaction.objectStore(STORAGE_STORES.storageMeta).get(WORKSPACE_FRAME_BYTES_META_KEY),
    transaction,
  );
  return Math.max(0, meta?.value ?? 0);
}

export async function checkWorkspaceCandidateCapacity(
  expectedWriteBytes: number,
): Promise<WorkspaceCandidateCapacityDecision> {
  if (!Number.isSafeInteger(expectedWriteBytes) || expectedWriteBytes <= 0) {
    throw new FrameWorkspaceValidationError("候选帧预检体积必须是正整数。");
  }
  await cleanupOrphanedWorkspaceCandidates();
  const [budget, frameBytes, workspaceBytes] = await Promise.all([
    estimateSequenceStorageBudget(),
    getManagedFrameBytes(),
    getManagedWorkspaceFrameBytes(),
  ]);
  return assessSequenceStorageCapacity({
    budget,
    managedBytes: frameBytes + workspaceBytes,
    expectedWriteBytes,
  });
}

async function assertCandidateCapacity(size: number): Promise<void> {
  const capacity = await checkWorkspaceCandidateCapacity(size);
  if (!capacity.allowed) throw new WorkspaceCandidateQuotaError();
}

export async function saveWorkspaceFrameResource<TRevision>(
  resource: StoredWorkspaceFrameResource<TRevision>,
): Promise<void> {
  assertCandidateResource(resource);
  await assertCandidateImageSignature(resource);
  await assertCandidateCapacity(resource.size);
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [
      STORAGE_STORES.frameWorkspaces,
      STORAGE_STORES.workspaceFrameResources,
      STORAGE_STORES.storageMeta,
    ],
    "readwrite",
  );
  const committed = transactionCommitted(transaction);
  const workspaceStore = transaction.objectStore(STORAGE_STORES.frameWorkspaces);
  const resourceStore = transaction.objectStore(STORAGE_STORES.workspaceFrameResources);
  const metaStore = transaction.objectStore(STORAGE_STORES.storageMeta);
  try {
    const [workspace, existing, meta] = await Promise.all([
      requestResult<StoredFrameWorkspace | undefined>(workspaceStore.get(resource.workspaceId)),
      requestResult<StoredWorkspaceFrameResource | undefined>(resourceStore.get(resource.id)),
      requestResult<WorkspaceFrameBytesMetaRecord | undefined>(
        metaStore.get(WORKSPACE_FRAME_BYTES_META_KEY),
      ),
    ]);
    if (!workspace || workspace.sourceJobId !== resource.sourceJobId) {
      throw new FrameWorkspaceValidationError("候选帧与工作区来源任务不匹配。");
    }
    if (existing) throw new FrameWorkspaceValidationError("候选帧资源 ID 已存在。");
    resourceStore.add(resource);
    metaStore.put({
      key: WORKSPACE_FRAME_BYTES_META_KEY,
      value: Math.max(0, meta?.value ?? 0) + resource.size,
      updatedAt: new Date().toISOString(),
    } satisfies WorkspaceFrameBytesMetaRecord);
    await committed;
  } catch (error) {
    await abortTransaction(transaction);
    await committed.catch(() => undefined);
    normalizeWorkspaceStorageError(error);
  }
}

export async function getWorkspaceFrameResource<TRevision = FrameRevision>(
  id: string,
): Promise<StoredWorkspaceFrameResource<TRevision> | undefined> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    STORAGE_STORES.workspaceFrameResources,
    "readonly",
  );
  return committedRequestResult<StoredWorkspaceFrameResource<TRevision> | undefined>(
    transaction.objectStore(STORAGE_STORES.workspaceFrameResources).get(id),
    transaction,
  );
}

export async function listWorkspaceFrameResources<TRevision = FrameRevision>(
  workspaceId: string,
): Promise<StoredWorkspaceFrameResource<TRevision>[]> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    STORAGE_STORES.workspaceFrameResources,
    "readonly",
  );
  return committedRequestResult<StoredWorkspaceFrameResource<TRevision>[]>(
    transaction
      .objectStore(STORAGE_STORES.workspaceFrameResources)
      .index("workspaceId")
      .getAll(workspaceId),
    transaction,
  );
}

export async function adoptWorkspaceFrameResource<TWorkspace>(input: {
  workspace: StoredFrameWorkspace<TWorkspace>;
  candidateId: string;
  expectedRevision: number;
  adoptedAt: string;
}): Promise<void> {
  assertWorkspaceRecord(input.workspace);
  assertNextRevision(input.workspace, input.expectedRevision);
  if (!input.workspace.candidateResourceIds.includes(input.candidateId)) {
    throw new FrameWorkspaceValidationError("采用的候选帧未被新工作区修订引用。");
  }
  if (Number.isNaN(Date.parse(input.adoptedAt))) {
    throw new FrameWorkspaceValidationError("候选帧采用时间无效。");
  }
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [STORAGE_STORES.frameWorkspaces, STORAGE_STORES.workspaceFrameResources],
    "readwrite",
  );
  const committed = transactionCommitted(transaction);
  const workspaceStore = transaction.objectStore(STORAGE_STORES.frameWorkspaces);
  const resourceStore = transaction.objectStore(STORAGE_STORES.workspaceFrameResources);
  try {
    const [current, candidate] = await Promise.all([
      assertExpectedRevision<TWorkspace>(
        workspaceStore,
        input.workspace.workspaceId,
        input.expectedRevision,
      ),
      requestResult<StoredWorkspaceFrameResource | undefined>(
        resourceStore.get(input.candidateId),
      ),
    ]);
    if (
      current.sourceJobId !== input.workspace.sourceJobId ||
      current.createdAt !== input.workspace.createdAt ||
      candidate?.workspaceId !== input.workspace.workspaceId ||
      candidate.sourceJobId !== input.workspace.sourceJobId
    ) {
      throw new FrameWorkspaceValidationError("候选帧不存在或归属工作区不匹配。");
    }
    workspaceStore.put(input.workspace);
    resourceStore.put({
      ...candidate,
      adoptedAt: input.adoptedAt,
      adoptedRevision: input.workspace.revision,
    } satisfies StoredWorkspaceFrameResource);
    await committed;
  } catch (error) {
    await abortTransaction(transaction);
    await committed.catch(() => undefined);
    normalizeWorkspaceStorageError(error);
  }
}

export async function saveWorkspaceFrameResourceAndAdopt<TWorkspace, TRevision>(input: {
  workspace: StoredFrameWorkspace<TWorkspace>;
  candidate: StoredWorkspaceFrameResource<TRevision>;
  expectedRevision: number;
  adoptedAt: string;
}): Promise<void> {
  assertWorkspaceRecord(input.workspace);
  assertCandidateResource(input.candidate);
  await assertCandidateImageSignature(input.candidate);
  assertNextRevision(input.workspace, input.expectedRevision);
  if (
    input.candidate.workspaceId !== input.workspace.workspaceId ||
    input.candidate.sourceJobId !== input.workspace.sourceJobId ||
    !input.workspace.candidateResourceIds.includes(input.candidate.id)
  ) {
    throw new FrameWorkspaceValidationError("候选帧、工作区修订和来源任务不匹配。");
  }
  if (Number.isNaN(Date.parse(input.adoptedAt))) {
    throw new FrameWorkspaceValidationError("候选帧采用时间无效。");
  }
  await assertCandidateCapacity(input.candidate.size);
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [
      STORAGE_STORES.frameWorkspaces,
      STORAGE_STORES.workspaceFrameResources,
      STORAGE_STORES.storageMeta,
    ],
    "readwrite",
  );
  const committed = transactionCommitted(transaction);
  const workspaceStore = transaction.objectStore(STORAGE_STORES.frameWorkspaces);
  const resourceStore = transaction.objectStore(STORAGE_STORES.workspaceFrameResources);
  const metaStore = transaction.objectStore(STORAGE_STORES.storageMeta);
  try {
    const [current, existingCandidate, meta] = await Promise.all([
      assertExpectedRevision<TWorkspace>(
        workspaceStore,
        input.workspace.workspaceId,
        input.expectedRevision,
      ),
      requestResult<StoredWorkspaceFrameResource | undefined>(
        resourceStore.get(input.candidate.id),
      ),
      requestResult<WorkspaceFrameBytesMetaRecord | undefined>(
        metaStore.get(WORKSPACE_FRAME_BYTES_META_KEY),
      ),
    ]);
    if (
      current.sourceJobId !== input.workspace.sourceJobId ||
      current.createdAt !== input.workspace.createdAt ||
      existingCandidate
    ) {
      throw new FrameWorkspaceValidationError("候选帧 ID 已存在或工作区来源已改变。");
    }
    workspaceStore.put(input.workspace);
    resourceStore.add({
      ...input.candidate,
      adoptedAt: input.adoptedAt,
      adoptedRevision: input.workspace.revision,
    });
    metaStore.put({
      key: WORKSPACE_FRAME_BYTES_META_KEY,
      value: Math.max(0, meta?.value ?? 0) + input.candidate.size,
      updatedAt: input.adoptedAt,
    } satisfies WorkspaceFrameBytesMetaRecord);
    await committed;
  } catch (error) {
    await abortTransaction(transaction);
    await committed.catch(() => undefined);
    normalizeWorkspaceStorageError(error);
  }
}

export async function deleteFrameWorkspace(
  workspaceId: string,
  expectedRevision?: number,
): Promise<WorkspaceCandidateCleanupResult> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [
      STORAGE_STORES.frameWorkspaces,
      STORAGE_STORES.workspaceFrameResources,
      STORAGE_STORES.frameWorkspaceSnapshots,
      STORAGE_STORES.storageMeta,
    ],
    "readwrite",
  );
  const committed = transactionCommitted(transaction);
  const workspaceStore = transaction.objectStore(STORAGE_STORES.frameWorkspaces);
  const resourceStore = transaction.objectStore(STORAGE_STORES.workspaceFrameResources);
  const snapshotStore = transaction.objectStore(STORAGE_STORES.frameWorkspaceSnapshots);
  const metaStore = transaction.objectStore(STORAGE_STORES.storageMeta);
  try {
    const [workspace, workspaces, snapshots, resources, meta] = await Promise.all([
      requestResult<StoredFrameWorkspace | undefined>(workspaceStore.get(workspaceId)),
      requestResult<StoredFrameWorkspace[]>(workspaceStore.getAll()),
      requestResult<FrameWorkspaceSnapshot[]>(snapshotStore.getAll()),
      requestResult<StoredWorkspaceFrameResource[]>(
        resourceStore.index("workspaceId").getAll(workspaceId),
      ),
      requestResult<WorkspaceFrameBytesMetaRecord | undefined>(
        metaStore.get(WORKSPACE_FRAME_BYTES_META_KEY),
      ),
    ]);
    if (!workspace) throw new FrameWorkspaceNotFoundError(workspaceId);
    if (expectedRevision !== undefined && workspace.revision !== expectedRevision) {
      throw new FrameWorkspaceRevisionConflictError(
        workspaceId,
        expectedRevision,
        workspace.revision,
      );
    }
    const referencedByOtherWorkspaces = new Set(
      workspaces
        .filter((item) => item.workspaceId !== workspaceId)
        .flatMap((item) => [...item.candidateResourceIds]),
    );
    snapshots
      .flatMap((snapshot) => snapshot.frames)
      .filter((frame) => frame.revisionSource === "retry_candidate")
      .forEach((frame) => referencedByOtherWorkspaces.add(frame.resourceRef));
    const reclaimableResources = resources.filter(
      (resource) => !referencedByOtherWorkspaces.has(resource.id),
    );
    const reclaimedBytes = reclaimableResources.reduce(
      (sum, resource) => sum + resource.size,
      0,
    );
    workspaceStore.delete(workspaceId);
    for (const resource of reclaimableResources) resourceStore.delete(resource.id);
    const bytesBefore = Math.max(0, meta?.value ?? 0);
    const bytesAfter = Math.max(0, bytesBefore - reclaimedBytes);
    metaStore.put({
      key: WORKSPACE_FRAME_BYTES_META_KEY,
      value: bytesAfter,
      updatedAt: new Date().toISOString(),
    } satisfies WorkspaceFrameBytesMetaRecord);
    await committed;
    return {
      deletedResourceIds: reclaimableResources.map((resource) => resource.id),
      bytesBefore,
      bytesAfter,
    };
  } catch (error) {
    await abortTransaction(transaction);
    await committed.catch(() => undefined);
    throw error;
  }
}

export async function cleanupOrphanedWorkspaceCandidates(input: {
  now?: Date;
  orphanAgeMs?: number;
} = {}): Promise<WorkspaceCandidateCleanupResult> {
  const now = input.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - (input.orphanAgeMs ?? DEFAULT_ORPHAN_AGE_MS),
  ).toISOString();
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [
      STORAGE_STORES.frameWorkspaces,
      STORAGE_STORES.workspaceFrameResources,
      STORAGE_STORES.frameWorkspaceSnapshots,
      STORAGE_STORES.storageMeta,
    ],
    "readwrite",
  );
  const committed = transactionCommitted(transaction);
  const workspaceStore = transaction.objectStore(STORAGE_STORES.frameWorkspaces);
  const resourceStore = transaction.objectStore(STORAGE_STORES.workspaceFrameResources);
  const snapshotStore = transaction.objectStore(STORAGE_STORES.frameWorkspaceSnapshots);
  const metaStore = transaction.objectStore(STORAGE_STORES.storageMeta);
  try {
    const [workspaces, snapshots, resources, meta] = await Promise.all([
      requestResult<StoredFrameWorkspace[]>(workspaceStore.getAll()),
      requestResult<FrameWorkspaceSnapshot[]>(snapshotStore.getAll()),
      requestResult<StoredWorkspaceFrameResource[]>(resourceStore.getAll()),
      requestResult<WorkspaceFrameBytesMetaRecord | undefined>(
        metaStore.get(WORKSPACE_FRAME_BYTES_META_KEY),
      ),
    ]);
    const referencedCandidateIds = new Set(
      workspaces.flatMap((workspace) => [...workspace.candidateResourceIds]),
    );
    snapshots
      .flatMap((snapshot) => snapshot.frames)
      .filter((frame) => frame.revisionSource === "retry_candidate")
      .forEach((frame) => referencedCandidateIds.add(frame.resourceRef));
    const orphans = resources.filter(
      (resource) =>
        !referencedCandidateIds.has(resource.id) &&
        resource.createdAt.localeCompare(cutoff) <= 0,
    );
    for (const resource of orphans) resourceStore.delete(resource.id);
    const bytesBefore = Math.max(
      0,
      meta?.value ?? 0,
      resources.reduce((sum, resource) => sum + resource.size, 0),
    );
    const bytesAfter = Math.max(
      0,
      bytesBefore - orphans.reduce((sum, resource) => sum + resource.size, 0),
    );
    metaStore.put({
      key: WORKSPACE_FRAME_BYTES_META_KEY,
      value: bytesAfter,
      updatedAt: now.toISOString(),
    } satisfies WorkspaceFrameBytesMetaRecord);
    await committed;
    return {
      deletedResourceIds: orphans.map((resource) => resource.id),
      bytesBefore,
      bytesAfter,
    };
  } catch (error) {
    await abortTransaction(transaction);
    await committed.catch(() => undefined);
    normalizeWorkspaceStorageError(error);
  }
}

function assertSnapshotStructure(snapshot: FrameWorkspaceSnapshot): void {
  if (
    !snapshot.snapshotId.trim() ||
    !snapshot.workspaceId.trim() ||
    !snapshot.sourceJobId.trim() ||
    snapshot.schemaVersion !== 1 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    Number.isNaN(Date.parse(snapshot.createdAt)) ||
    !Number.isSafeInteger(snapshot.frameRate) ||
    snapshot.frameRate <= 0 ||
    !["loop", "once"].includes(snapshot.loopMode) ||
    snapshot.canvas.mode !== "source" ||
    !snapshot.canvas.aspectRatio ||
    !Number.isSafeInteger(snapshot.canvas.width) ||
    snapshot.canvas.width <= 0 ||
    !Number.isSafeInteger(snapshot.canvas.height) ||
    snapshot.canvas.height <= 0 ||
    !["bottom_center_feet_baseline", "full_canvas_fixed_camera"].includes(
      snapshot.anchor,
    )
  ) {
    throw new FrameWorkspaceSnapshotValidationError("工作区快照头部或播放元数据无效。");
  }
  if (snapshot.frames.length < 2) {
    throw new FrameWorkspaceSnapshotValidationError("工作区快照至少需要两个完整帧。");
  }
  if (containsUnsafePayload(snapshot)) {
    throw new FrameWorkspaceSnapshotValidationError(
      "工作区快照不能包含 Blob、临时 URL、data URL 或完整签名 URL。",
    );
  }

  const slotIds = new Set<string>();
  const originalFrameIds = new Set<string>();
  const originalIndexes = new Set<number>();
  const revisionIds = new Set<string>();
  snapshot.frames.forEach((frame, index) => {
    if (
      frame.outputIndex !== index ||
      !frame.slotId.trim() ||
      !frame.originalFrameId.trim() ||
      !Number.isSafeInteger(frame.originalSequenceIndex) ||
      frame.originalSequenceIndex < 0 ||
      !frame.revisionId.trim() ||
      !["original", "retry_candidate"].includes(frame.revisionSource) ||
      !frame.resourceRef.trim() ||
      !ALLOWED_IMAGE_MIME_TYPES.has(frame.mimeType) ||
      frame.width !== snapshot.canvas.width ||
      frame.height !== snapshot.canvas.height ||
      !Number.isSafeInteger(frame.size) ||
      frame.size <= 0
    ) {
      throw new FrameWorkspaceSnapshotValidationError(
        `工作区快照第 ${index + 1} 帧的顺序、资源或尺寸元数据无效。`,
      );
    }
    if (
      slotIds.has(frame.slotId) ||
      originalFrameIds.has(frame.originalFrameId) ||
      originalIndexes.has(frame.originalSequenceIndex) ||
      revisionIds.has(frame.revisionId)
    ) {
      throw new FrameWorkspaceSnapshotValidationError("工作区快照包含重复帧或修订引用。");
    }
    slotIds.add(frame.slotId);
    originalFrameIds.add(frame.originalFrameId);
    originalIndexes.add(frame.originalSequenceIndex);
    revisionIds.add(frame.revisionId);
  });
}

function assertOriginalSnapshotResource(
  snapshot: FrameWorkspaceSnapshot,
  frame: FrameWorkspaceSnapshotFrame,
  resource: StoredFrameResource | undefined,
  workspace: StoredFrameWorkspace,
): void {
  const metadata = resource?.frame;
  if (
    !resource ||
    !("blob" in resource) ||
    resource.id !== frame.originalFrameId ||
    resource.jobId !== snapshot.sourceJobId ||
    resource.sequenceIndex !== frame.originalSequenceIndex ||
    resource.size !== frame.size ||
    metadata?.id !== frame.originalFrameId ||
    metadata?.jobId !== snapshot.sourceJobId ||
    metadata?.resourceRef !== frame.resourceRef ||
    metadata?.mimeType !== frame.mimeType ||
    metadata?.width !== frame.width ||
    metadata?.height !== frame.height ||
    !workspace.sourceFrameIds.includes(frame.originalFrameId)
  ) {
    throw new FrameWorkspaceSnapshotValidationError(
      `快照帧 ${frame.outputIndex} 的原始资源不存在或与元数据不一致。`,
    );
  }
}

function assertCandidateSnapshotResource(
  snapshot: FrameWorkspaceSnapshot,
  frame: FrameWorkspaceSnapshotFrame,
  resource: StoredWorkspaceFrameResource | undefined,
  workspace: StoredFrameWorkspace,
): void {
  const revision = resource?.revision as Partial<FrameRevision> | undefined;
  if (
    !resource ||
    !("blob" in resource) ||
    resource.id !== frame.resourceRef ||
    resource.workspaceId !== snapshot.workspaceId ||
    resource.sourceJobId !== snapshot.sourceJobId ||
    resource.mimeType !== frame.mimeType ||
    resource.width !== frame.width ||
    resource.height !== frame.height ||
    resource.size !== frame.size ||
    resource.adoptedRevision === undefined ||
    resource.adoptedRevision > snapshot.revision ||
    revision?.id !== frame.revisionId ||
    !workspace.candidateResourceIds.includes(resource.id)
  ) {
    throw new FrameWorkspaceSnapshotValidationError(
      `快照帧 ${frame.outputIndex} 的候选资源不存在、未采用或归属不一致。`,
    );
  }
}

export async function saveFrameWorkspaceSnapshot(
  snapshot: FrameWorkspaceSnapshot,
): Promise<void> {
  assertSnapshotStructure(snapshot);
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [
      STORAGE_STORES.frameWorkspaceSnapshots,
      STORAGE_STORES.frameWorkspaces,
      STORAGE_STORES.frameResources,
      STORAGE_STORES.workspaceFrameResources,
    ],
    "readwrite",
  );
  const committed = transactionCommitted(transaction);
  const snapshotStore = transaction.objectStore(STORAGE_STORES.frameWorkspaceSnapshots);
  const workspaceStore = transaction.objectStore(STORAGE_STORES.frameWorkspaces);
  const frameStore = transaction.objectStore(STORAGE_STORES.frameResources);
  const candidateStore = transaction.objectStore(STORAGE_STORES.workspaceFrameResources);
  try {
    const workspaceRequest = workspaceStore.get(snapshot.workspaceId);
    const resourceRequests = snapshot.frames.map((frame) =>
      frame.revisionSource === "original"
        ? frameStore.get(frame.originalFrameId)
        : candidateStore.get(frame.resourceRef),
    );
    const [workspace, ...resources] = await Promise.all([
      requestResult<StoredFrameWorkspace | undefined>(workspaceRequest),
      ...resourceRequests.map((request) => requestResult(request)),
    ]);
    if (
      !workspace ||
      workspace.sourceJobId !== snapshot.sourceJobId ||
      workspace.revision !== snapshot.revision
    ) {
      throw new FrameWorkspaceSnapshotValidationError(
        "快照必须对应已持久化的当前工作区修订。",
      );
    }
    snapshot.frames.forEach((frame, index) => {
      if (frame.revisionSource === "original") {
        assertOriginalSnapshotResource(
          snapshot,
          frame,
          resources[index] as StoredFrameResource | undefined,
          workspace,
        );
      } else {
        assertCandidateSnapshotResource(
          snapshot,
          frame,
          resources[index] as StoredWorkspaceFrameResource | undefined,
          workspace,
        );
      }
    });
    snapshotStore.add(snapshot);
    await committed;
  } catch (error) {
    await abortTransaction(transaction);
    await committed.catch(() => undefined);
    if (error instanceof DOMException && error.name === "ConstraintError") {
      throw new FrameWorkspaceSnapshotAlreadyExistsError(
        snapshot.snapshotId,
        snapshot.workspaceId,
        snapshot.revision,
      );
    }
    throw error;
  }
}

export async function getFrameWorkspaceSnapshot(
  snapshotId: string,
): Promise<FrameWorkspaceSnapshot | undefined> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    STORAGE_STORES.frameWorkspaceSnapshots,
    "readonly",
  );
  const snapshot = await committedRequestResult<FrameWorkspaceSnapshot | undefined>(
    transaction.objectStore(STORAGE_STORES.frameWorkspaceSnapshots).get(snapshotId),
    transaction,
  );
  return snapshot ? freezeFrameWorkspaceSnapshot(snapshot) : undefined;
}

export async function getFrameWorkspaceSnapshotByRevision(
  workspaceId: string,
  revision: number,
): Promise<FrameWorkspaceSnapshot | undefined> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    STORAGE_STORES.frameWorkspaceSnapshots,
    "readonly",
  );
  const snapshot = await committedRequestResult<FrameWorkspaceSnapshot | undefined>(
    transaction
      .objectStore(STORAGE_STORES.frameWorkspaceSnapshots)
      .index("workspaceAndRevision")
      .get([workspaceId, revision]),
    transaction,
  );
  return snapshot ? freezeFrameWorkspaceSnapshot(snapshot) : undefined;
}

export async function listFrameWorkspaceSnapshots(
  workspaceId: string,
): Promise<FrameWorkspaceSnapshot[]> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    STORAGE_STORES.frameWorkspaceSnapshots,
    "readonly",
  );
  const snapshots = await committedRequestResult<FrameWorkspaceSnapshot[]>(
    transaction
      .objectStore(STORAGE_STORES.frameWorkspaceSnapshots)
      .index("workspaceId")
      .getAll(workspaceId),
    transaction,
  );
  return snapshots
    .sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt))
    .map((snapshot) => freezeFrameWorkspaceSnapshot(snapshot));
}

export async function getFrameWorkspaceProtectionGraph(): Promise<FrameWorkspaceProtectionGraph> {
  const database = await openGifCraftDatabase();
  const transaction = database.transaction(
    [STORAGE_STORES.frameWorkspaces, STORAGE_STORES.frameWorkspaceSnapshots],
    "readonly",
  );
  const committed = transactionCommitted(transaction);
  const [workspaces, snapshots] = await Promise.all([
    requestResult<StoredFrameWorkspace[]>(
      transaction.objectStore(STORAGE_STORES.frameWorkspaces).getAll(),
    ),
    requestResult<FrameWorkspaceSnapshot[]>(
      transaction.objectStore(STORAGE_STORES.frameWorkspaceSnapshots).getAll(),
    ),
  ]);
  await committed;
  const graph: FrameWorkspaceProtectionGraph = {
    sourceJobIds: new Set(),
    sourceFrameIds: new Set(),
    candidateResourceIds: new Set(),
    activeRetryJobIds: new Set(),
  };
  for (const workspace of workspaces) {
    graph.sourceJobIds.add(workspace.sourceJobId);
    workspace.sourceFrameIds.forEach((id) => graph.sourceFrameIds.add(id));
    workspace.candidateResourceIds.forEach((id) => graph.candidateResourceIds.add(id));
    workspace.activeRetryJobIds.forEach((id) => graph.activeRetryJobIds.add(id));
  }
  for (const snapshot of snapshots) {
    graph.sourceJobIds.add(snapshot.sourceJobId);
    snapshot.frames.forEach((frame) => {
      graph.sourceFrameIds.add(frame.originalFrameId);
      if (frame.revisionSource === "retry_candidate") {
        graph.candidateResourceIds.add(frame.resourceRef);
      }
    });
  }
  return graph;
}
