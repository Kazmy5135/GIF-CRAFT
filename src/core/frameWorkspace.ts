import type {
  Frame,
  FrameWorkspaceHandoff,
  SequenceAnchor,
  SequenceCanvasParameters,
  SequenceGenerationError,
  SequenceLoopMode,
  SequencePresetId,
} from "./sequenceGeneration.js";

export const FRAME_WORKSPACE_SCHEMA_VERSION = 1 as const;

export type FrameDecision = "pending" | "kept" | "removed";
export type FrameWorkspaceFilter = "all" | FrameDecision;
export type FrameRevisionSource = "original" | "retry_candidate";
export type FrameRetryExecutionMode = "native_single_frame" | "full_sequence_fallback";
export type FrameRetryAttemptStatus =
  | "submitting"
  | "running"
  | "candidate_ready"
  | "failed"
  | "status_unknown"
  | "accepted"
  | "discarded";

export interface FrameRevision {
  readonly id: string;
  readonly workspaceId: string;
  readonly slotId: string;
  readonly source: FrameRevisionSource;
  readonly originalFrameId?: string;
  readonly retryAttemptId?: string;
  readonly resourceRef: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly size: number;
  readonly readable: boolean;
  readonly createdAt: string;
  readonly isCurrent: boolean;
}

export interface FrameRetryInputSnapshot {
  readonly targetFrameId: string;
  readonly originalSequenceIndex: number;
  readonly parentJobId: string;
  readonly workspaceRevision: number;
  readonly previousFrameId?: string;
  readonly nextFrameId?: string;
  readonly prompt: string;
}

export interface FrameRetryAttempt {
  readonly id: string;
  readonly workspaceId: string;
  readonly slotId: string;
  readonly originalSequenceIndex: number;
  readonly parentJobId: string;
  readonly clientRequestId: string;
  readonly executionMode: FrameRetryExecutionMode;
  readonly inputSnapshot: FrameRetryInputSnapshot;
  readonly status: FrameRetryAttemptStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly candidateRevisionId?: string;
  readonly childGenerationJobId?: string;
  readonly error?: SequenceGenerationError;
}

export interface FrameWorkspaceSlot {
  readonly id: string;
  readonly originalFrameId: string;
  readonly originalSequenceIndex: number;
  readonly decision: FrameDecision;
  readonly originalRevisionId: string;
  readonly currentRevisionId: string;
  readonly candidateRevisionId?: string;
  readonly retryAttemptIds: readonly string[];
}

export interface FrameWorkspaceSourceSnapshot {
  readonly presetId: SequencePresetId;
  readonly presetVersion: 1;
  readonly frameRate: number;
  readonly loopMode: SequenceLoopMode;
  readonly canvas: SequenceCanvasParameters;
  readonly anchor: SequenceAnchor;
}

export interface FrameWorkspace {
  readonly workspaceId: string;
  readonly schemaVersion: typeof FRAME_WORKSPACE_SCHEMA_VERSION;
  readonly sourceJobId: string;
  readonly source: FrameWorkspaceSourceSnapshot;
  readonly orderedSlotIds: readonly string[];
  readonly slots: Readonly<Record<string, FrameWorkspaceSlot>>;
  readonly revisions: Readonly<Record<string, FrameRevision>>;
  readonly retryAttempts: Readonly<Record<string, FrameRetryAttempt>>;
  readonly selectedSlotId: string | null;
  readonly playheadSlotId: string | null;
  readonly revision: number;
  readonly lastPersistedRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type FrameWorkspaceHandoffIssueCode =
  | "job_id_missing"
  | "workspace_id_missing"
  | "invalid_timestamp"
  | "invalid_playback_metadata"
  | "empty_frame_set"
  | "frame_job_mismatch"
  | "duplicate_frame_id"
  | "duplicate_provider_index"
  | "duplicate_sequence_index"
  | "sequence_index_gap"
  | "invalid_frame_resource"
  | "unsupported_mime_type"
  | "invalid_dimensions"
  | "dimension_mismatch"
  | "invalid_size";

export interface FrameWorkspaceHandoffIssue {
  readonly code: FrameWorkspaceHandoffIssueCode;
  readonly message: string;
  readonly frameId?: string;
}

export type FrameWorkspaceHandoffGuardResult =
  | { readonly ok: true; readonly frames: readonly Frame[] }
  | { readonly ok: false; readonly issues: readonly FrameWorkspaceHandoffIssue[] };

const supportedFrameMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

export function guardFrameWorkspaceHandoff(
  handoff: FrameWorkspaceHandoff,
): FrameWorkspaceHandoffGuardResult {
  const issues: FrameWorkspaceHandoffIssue[] = [];
  if (!handoff.jobId.trim()) {
    issues.push({ code: "job_id_missing", message: "来源任务 ID 缺失。" });
  }
  if (
    !Number.isInteger(handoff.frameRate) ||
    handoff.frameRate <= 0 ||
    !Number.isInteger(handoff.canvas.width) ||
    handoff.canvas.width <= 0 ||
    !Number.isInteger(handoff.canvas.height) ||
    handoff.canvas.height <= 0
  ) {
    issues.push({ code: "invalid_playback_metadata", message: "来源任务的播放或画布参数无效。" });
  }
  if (handoff.frames.length === 0) {
    issues.push({ code: "empty_frame_set", message: "来源任务没有可交接的帧。" });
  }

  const frameIds = new Set<string>();
  const providerIndexes = new Set<number>();
  const sequenceIndexes = new Set<number>();
  for (const frame of handoff.frames) {
    if (frame.jobId !== handoff.jobId) {
      issues.push({ code: "frame_job_mismatch", frameId: frame.id, message: "帧不属于来源任务。" });
    }
    if (frameIds.has(frame.id)) {
      issues.push({ code: "duplicate_frame_id", frameId: frame.id, message: "帧 ID 重复。" });
    }
    frameIds.add(frame.id);
    if (providerIndexes.has(frame.providerIndex)) {
      issues.push({ code: "duplicate_provider_index", frameId: frame.id, message: "服务商索引重复。" });
    }
    providerIndexes.add(frame.providerIndex);
    if (sequenceIndexes.has(frame.sequenceIndex)) {
      issues.push({ code: "duplicate_sequence_index", frameId: frame.id, message: "原始序列索引重复。" });
    }
    sequenceIndexes.add(frame.sequenceIndex);
    if (!frame.readable || !frame.resourceRef.trim() || /^(?:blob|data):/i.test(frame.resourceRef)) {
      issues.push({ code: "invalid_frame_resource", frameId: frame.id, message: "帧资源不可持久读取。" });
    }
    if (!supportedFrameMimeTypes.has(frame.mimeType)) {
      issues.push({ code: "unsupported_mime_type", frameId: frame.id, message: "帧格式不受支持。" });
    }
    if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0) {
      issues.push({ code: "invalid_dimensions", frameId: frame.id, message: "帧尺寸无效。" });
    } else if (frame.width !== handoff.canvas.width || frame.height !== handoff.canvas.height) {
      issues.push({ code: "dimension_mismatch", frameId: frame.id, message: "帧尺寸与画布不一致。" });
    }
    if (!Number.isInteger(frame.size) || frame.size <= 0) {
      issues.push({ code: "invalid_size", frameId: frame.id, message: "帧资源大小无效。" });
    }
  }
  for (let index = 0; index < handoff.frames.length; index += 1) {
    if (!sequenceIndexes.has(index)) {
      issues.push({ code: "sequence_index_gap", message: `原始序列缺少索引 ${index}。` });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, frames: [...handoff.frames].sort((a, b) => a.sequenceIndex - b.sequenceIndex) };
}

export interface CreateFrameWorkspaceInput {
  readonly workspaceId: string;
  readonly handoff: FrameWorkspaceHandoff;
  readonly createdAt: string;
}

export function createFrameWorkspace(input: CreateFrameWorkspaceInput): FrameWorkspace {
  const { workspaceId, handoff, createdAt } = input;
  if (!workspaceId.trim()) throw new Error("工作区 ID 缺失。");
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("工作区创建时间无效。");
  const guard = guardFrameWorkspaceHandoff(handoff);
  if (!guard.ok) {
    throw new Error(`工作区交接无效：${guard.issues.map((issue) => issue.message).join("；")}`);
  }

  const slots: Record<string, FrameWorkspaceSlot> = {};
  const revisions: Record<string, FrameRevision> = {};
  const orderedSlotIds: string[] = [];
  for (const frame of guard.frames) {
    const slotId = `slot:${frame.id}`;
    const revisionId = `revision:original:${frame.id}`;
    orderedSlotIds.push(slotId);
    slots[slotId] = {
      id: slotId,
      originalFrameId: frame.id,
      originalSequenceIndex: frame.sequenceIndex,
      decision: "pending",
      originalRevisionId: revisionId,
      currentRevisionId: revisionId,
      retryAttemptIds: [],
    };
    revisions[revisionId] = {
      id: revisionId,
      workspaceId,
      slotId,
      source: "original",
      originalFrameId: frame.id,
      resourceRef: frame.resourceRef,
      mimeType: frame.mimeType,
      width: frame.width,
      height: frame.height,
      size: frame.size,
      readable: frame.readable,
      createdAt: frame.createdAt,
      isCurrent: true,
    };
  }
  return {
    workspaceId,
    schemaVersion: FRAME_WORKSPACE_SCHEMA_VERSION,
    sourceJobId: handoff.jobId,
    source: {
      presetId: handoff.presetId,
      presetVersion: handoff.presetVersion,
      frameRate: handoff.frameRate,
      loopMode: handoff.loopMode,
      canvas: { ...handoff.canvas },
      anchor: handoff.anchor,
    },
    orderedSlotIds,
    slots,
    revisions,
    retryAttempts: {},
    selectedSlotId: orderedSlotIds[0] ?? null,
    playheadSlotId: orderedSlotIds[0] ?? null,
    revision: 0,
    lastPersistedRevision: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

export class FrameWorkspaceConflictError extends Error {
  readonly code = "workspace_revision_conflict";
  readonly recoveryAction = "reload_workspace";

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`工作区已更新（期望修订 ${expectedRevision}，当前修订 ${actualRevision}），请重新加载。`);
    this.name = "FrameWorkspaceConflictError";
  }
}

export function assertWorkspaceRevision(workspace: FrameWorkspace, expectedRevision: number): void {
  if (workspace.revision !== expectedRevision) {
    throw new FrameWorkspaceConflictError(expectedRevision, workspace.revision);
  }
}

/** Applies a repository acknowledgement without creating a new user-edit revision. */
export function markFrameWorkspacePersisted(
  workspace: FrameWorkspace,
  persistedRevision: number,
): FrameWorkspace {
  if (!Number.isSafeInteger(persistedRevision) || persistedRevision < 0 || persistedRevision > workspace.revision) {
    throw new Error("持久化确认修订无效。");
  }
  if (persistedRevision <= workspace.lastPersistedRevision) return workspace;
  return { ...workspace, lastPersistedRevision: persistedRevision };
}

export interface FrameWorkspaceCommandOptions {
  readonly expectedRevision: number;
  readonly updatedAt: string;
}

function assertCommand(workspace: FrameWorkspace, options: FrameWorkspaceCommandOptions): void {
  assertWorkspaceRevision(workspace, options.expectedRevision);
  if (Number.isNaN(Date.parse(options.updatedAt))) throw new Error("工作区更新时间无效。");
}

function changed(workspace: FrameWorkspace, options: FrameWorkspaceCommandOptions, patch: Partial<FrameWorkspace>): FrameWorkspace {
  return { ...workspace, ...patch, revision: workspace.revision + 1, updatedAt: options.updatedAt };
}

function requireSlot(workspace: FrameWorkspace, slotId: string): FrameWorkspaceSlot {
  const slot = workspace.slots[slotId];
  if (!slot) throw new Error(`工作区槽位不存在：${slotId}`);
  return slot;
}

export function filterWorkspaceSlots(
  workspace: FrameWorkspace,
  filter: FrameWorkspaceFilter,
): readonly FrameWorkspaceSlot[] {
  return workspace.orderedSlotIds
    .map((slotId) => workspace.slots[slotId])
    .filter((slot): slot is FrameWorkspaceSlot => Boolean(slot))
    .filter((slot) => filter === "all" || slot.decision === filter);
}

export function countWorkspaceDecisions(workspace: FrameWorkspace): Readonly<Record<FrameDecision, number>> {
  const counts: Record<FrameDecision, number> = { pending: 0, kept: 0, removed: 0 };
  for (const slotId of workspace.orderedSlotIds) {
    const slot = workspace.slots[slotId];
    if (slot) counts[slot.decision] += 1;
  }
  return counts;
}

export function setFrameDecision(
  workspace: FrameWorkspace,
  slotId: string,
  decision: FrameDecision,
  options: FrameWorkspaceCommandOptions,
): FrameWorkspace {
  assertCommand(workspace, options);
  const slot = requireSlot(workspace, slotId);
  if (slot.decision === decision) return workspace;
  return changed(workspace, options, { slots: { ...workspace.slots, [slotId]: { ...slot, decision } } });
}

export function removeFrame(
  workspace: FrameWorkspace,
  slotId: string,
  options: FrameWorkspaceCommandOptions,
): FrameWorkspace {
  return setFrameDecision(workspace, slotId, "removed", options);
}

export function restoreFrame(
  workspace: FrameWorkspace,
  slotId: string,
  options: FrameWorkspaceCommandOptions & { readonly decision?: Exclude<FrameDecision, "removed"> },
): FrameWorkspace {
  return setFrameDecision(workspace, slotId, options.decision ?? "pending", options);
}

export type FrameMoveDirection = "backward" | "forward" | "first" | "last";

export function moveFrameSlot(
  workspace: FrameWorkspace,
  slotId: string,
  direction: FrameMoveDirection,
  options: FrameWorkspaceCommandOptions,
): FrameWorkspace {
  assertCommand(workspace, options);
  requireSlot(workspace, slotId);
  const from = workspace.orderedSlotIds.indexOf(slotId);
  const last = workspace.orderedSlotIds.length - 1;
  const to = direction === "backward" ? Math.max(0, from - 1) : direction === "forward" ? Math.min(last, from + 1) : direction === "first" ? 0 : last;
  if (from === to) return workspace;
  const order = [...workspace.orderedSlotIds];
  order.splice(from, 1);
  order.splice(to, 0, slotId);
  return changed(workspace, options, { orderedSlotIds: order });
}

export function moveFrameSlotTo(
  workspace: FrameWorkspace,
  slotId: string,
  targetSlotId: string,
  placement: "before" | "after",
  options: FrameWorkspaceCommandOptions,
): FrameWorkspace {
  assertCommand(workspace, options);
  requireSlot(workspace, slotId);
  requireSlot(workspace, targetSlotId);
  if (slotId === targetSlotId) return workspace;
  const order = workspace.orderedSlotIds.filter((id) => id !== slotId);
  const targetIndex = order.indexOf(targetSlotId);
  order.splice(targetIndex + (placement === "after" ? 1 : 0), 0, slotId);
  if (order.every((id, index) => id === workspace.orderedSlotIds[index])) return workspace;
  return changed(workspace, options, { orderedSlotIds: order });
}

const retryTransitions: Readonly<Record<FrameRetryAttemptStatus, readonly FrameRetryAttemptStatus[]>> = {
  submitting: ["running", "candidate_ready", "failed", "status_unknown", "discarded"],
  running: ["candidate_ready", "failed", "status_unknown", "discarded"],
  candidate_ready: ["accepted", "discarded"],
  status_unknown: ["running", "candidate_ready", "failed", "discarded"],
  failed: [],
  accepted: [],
  discarded: [],
};

export function canTransitionFrameRetryAttempt(
  current: FrameRetryAttemptStatus,
  next: FrameRetryAttemptStatus,
): boolean {
  return retryTransitions[current].includes(next);
}

export function transitionFrameRetryAttempt(
  attempt: FrameRetryAttempt,
  next: FrameRetryAttemptStatus,
  updatedAt: string,
  patch: Pick<FrameRetryAttempt, "candidateRevisionId" | "childGenerationJobId" | "error"> = {},
): FrameRetryAttempt {
  if (!canTransitionFrameRetryAttempt(attempt.status, next)) {
    throw new Error(`非法重试状态转换：${attempt.status} -> ${next}`);
  }
  return { ...attempt, ...patch, status: next, updatedAt };
}

export function transitionWorkspaceRetryAttempt(
  workspace: FrameWorkspace,
  attemptId: string,
  next: Exclude<FrameRetryAttemptStatus, "candidate_ready" | "accepted">,
  options: FrameWorkspaceCommandOptions,
  patch: Pick<FrameRetryAttempt, "childGenerationJobId" | "error"> = {},
): FrameWorkspace {
  assertCommand(workspace, options);
  const attempt = workspace.retryAttempts[attemptId];
  if (!attempt) throw new Error("重试尝试不存在。");
  if (attempt.status === "candidate_ready") {
    throw new Error("候选就绪后必须使用接受或放弃候选命令。");
  }
  const updatedAttempt = transitionFrameRetryAttempt(attempt, next, options.updatedAt, {
    candidateRevisionId: attempt.candidateRevisionId,
    childGenerationJobId: patch.childGenerationJobId ?? attempt.childGenerationJobId,
    error: patch.error,
  });
  return changed(workspace, options, {
    retryAttempts: { ...workspace.retryAttempts, [attemptId]: updatedAttempt },
  });
}

export interface RegisterFrameRetryAttemptInput {
  readonly attempt: FrameRetryAttempt;
  readonly options: FrameWorkspaceCommandOptions;
}

const activeRetryStatuses = new Set<FrameRetryAttemptStatus>([
  "submitting",
  "running",
  "candidate_ready",
  "status_unknown",
]);

export function registerFrameRetryAttempt(
  workspace: FrameWorkspace,
  input: RegisterFrameRetryAttemptInput,
): FrameWorkspace {
  assertCommand(workspace, input.options);
  const { attempt } = input;
  const slot = requireSlot(workspace, attempt.slotId);
  if (attempt.workspaceId !== workspace.workspaceId || attempt.parentJobId !== workspace.sourceJobId || attempt.originalSequenceIndex !== slot.originalSequenceIndex) {
    throw new Error("重试尝试与工作区目标不一致。");
  }
  const duplicate = Object.values(workspace.retryAttempts).find(
    (item) => item.clientRequestId === attempt.clientRequestId,
  );
  if (duplicate) return workspace;
  if (workspace.retryAttempts[attempt.id]) throw new Error("重试尝试 ID 已存在。");
  if (attempt.inputSnapshot.workspaceRevision !== workspace.revision) {
    throw new FrameWorkspaceConflictError(attempt.inputSnapshot.workspaceRevision, workspace.revision);
  }
  if (slot.retryAttemptIds.some((id) => activeRetryStatuses.has(workspace.retryAttempts[id]?.status))) {
    throw new Error("同一槽位已有活动重试。");
  }
  return changed(workspace, input.options, {
    slots: { ...workspace.slots, [slot.id]: { ...slot, retryAttemptIds: [...slot.retryAttemptIds, attempt.id] } },
    retryAttempts: { ...workspace.retryAttempts, [attempt.id]: attempt },
  });
}

export interface RetryCandidateInput {
  readonly attemptId: string;
  readonly revision: FrameRevision;
  readonly options: FrameWorkspaceCommandOptions;
}

export function attachRetryCandidate(workspace: FrameWorkspace, input: RetryCandidateInput): FrameWorkspace {
  assertCommand(workspace, input.options);
  const attempt = workspace.retryAttempts[input.attemptId];
  if (!attempt) throw new Error("重试尝试不存在。");
  if (!canTransitionFrameRetryAttempt(attempt.status, "candidate_ready")) {
    throw new Error(`当前重试状态不能挂接候选：${attempt.status}`);
  }
  const slot = requireSlot(workspace, attempt.slotId);
  const candidate = input.revision;
  if (workspace.revisions[candidate.id]) throw new Error("候选修订 ID 已存在。");
  if (
    candidate.workspaceId !== workspace.workspaceId ||
    candidate.slotId !== slot.id ||
    candidate.source !== "retry_candidate" ||
    candidate.retryAttemptId !== attempt.id ||
    candidate.isCurrent ||
    !candidate.readable ||
    !candidate.resourceRef.trim() ||
    /^(?:blob|data):/i.test(candidate.resourceRef) ||
    !supportedFrameMimeTypes.has(candidate.mimeType) ||
    candidate.width !== workspace.source.canvas.width ||
    candidate.height !== workspace.source.canvas.height ||
    !Number.isInteger(candidate.size) ||
    candidate.size <= 0
  ) {
    throw new Error("候选修订资源或归属无效。");
  }
  const updatedAttempt = transitionFrameRetryAttempt(attempt, "candidate_ready", input.options.updatedAt, {
    candidateRevisionId: candidate.id,
    childGenerationJobId: attempt.childGenerationJobId,
    error: undefined,
  });
  return changed(workspace, input.options, {
    slots: { ...workspace.slots, [slot.id]: { ...slot, candidateRevisionId: candidate.id } },
    revisions: { ...workspace.revisions, [candidate.id]: candidate },
    retryAttempts: { ...workspace.retryAttempts, [attempt.id]: updatedAttempt },
  });
}

function setCurrentRevision(
  workspace: FrameWorkspace,
  slot: FrameWorkspaceSlot,
  revisionId: string,
): Readonly<Record<string, FrameRevision>> {
  const next = { ...workspace.revisions };
  for (const id of Object.keys(next)) {
    const revision = next[id];
    if (revision.slotId === slot.id && revision.isCurrent !== (id === revisionId)) {
      next[id] = { ...revision, isCurrent: id === revisionId };
    }
  }
  return next;
}

export function acceptRetryCandidate(
  workspace: FrameWorkspace,
  attemptId: string,
  options: FrameWorkspaceCommandOptions,
): FrameWorkspace {
  assertCommand(workspace, options);
  const attempt = workspace.retryAttempts[attemptId];
  if (!attempt || attempt.status !== "candidate_ready" || !attempt.candidateRevisionId) {
    throw new Error("没有可接受的重试候选。");
  }
  const slot = requireSlot(workspace, attempt.slotId);
  const candidate = workspace.revisions[attempt.candidateRevisionId];
  if (!candidate || candidate.slotId !== slot.id || !candidate.readable) throw new Error("候选修订不可用。");
  const accepted = transitionFrameRetryAttempt(attempt, "accepted", options.updatedAt, {
    candidateRevisionId: candidate.id,
    childGenerationJobId: attempt.childGenerationJobId,
    error: undefined,
  });
  return changed(workspace, options, {
    slots: {
      ...workspace.slots,
      [slot.id]: { ...slot, currentRevisionId: candidate.id, candidateRevisionId: undefined },
    },
    revisions: setCurrentRevision(workspace, slot, candidate.id),
    retryAttempts: { ...workspace.retryAttempts, [attempt.id]: accepted },
  });
}

export function discardRetryCandidate(
  workspace: FrameWorkspace,
  attemptId: string,
  options: FrameWorkspaceCommandOptions,
): FrameWorkspace {
  assertCommand(workspace, options);
  const attempt = workspace.retryAttempts[attemptId];
  if (!attempt || attempt.status !== "candidate_ready") throw new Error("没有可放弃的重试候选。");
  const slot = requireSlot(workspace, attempt.slotId);
  const discarded = transitionFrameRetryAttempt(attempt, "discarded", options.updatedAt, {
    candidateRevisionId: attempt.candidateRevisionId,
    childGenerationJobId: attempt.childGenerationJobId,
    error: undefined,
  });
  return changed(workspace, options, {
    slots: { ...workspace.slots, [slot.id]: { ...slot, candidateRevisionId: undefined } },
    retryAttempts: { ...workspace.retryAttempts, [attempt.id]: discarded },
  });
}

export function restoreOriginalFrame(
  workspace: FrameWorkspace,
  slotId: string,
  options: FrameWorkspaceCommandOptions,
): FrameWorkspace {
  assertCommand(workspace, options);
  const slot = requireSlot(workspace, slotId);
  if (slot.currentRevisionId === slot.originalRevisionId) return workspace;
  if (!workspace.revisions[slot.originalRevisionId]) throw new Error("原版修订不存在。");
  return changed(workspace, options, {
    slots: { ...workspace.slots, [slot.id]: { ...slot, currentRevisionId: slot.originalRevisionId } },
    revisions: setCurrentRevision(workspace, slot, slot.originalRevisionId),
  });
}

export type FrameWorkspaceReadinessIssueCode =
  | "too_few_frames"
  | "unreviewed_frame"
  | "duplicate_slot_id"
  | "missing_slot"
  | "unordered_slot"
  | "missing_revision"
  | "revision_slot_mismatch"
  | "current_revision_mismatch"
  | "unreadable_revision"
  | "invalid_revision_resource"
  | "dimension_mismatch"
  | "duplicate_original_sequence_index"
  | "missing_retry_attempt"
  | "retry_attempt_slot_mismatch"
  | "missing_candidate_revision"
  | "active_retry";

export interface FrameWorkspaceReadinessIssue {
  readonly code: FrameWorkspaceReadinessIssueCode;
  readonly message: string;
  readonly slotId?: string;
  readonly retryAttemptId?: string;
}

export interface FrameWorkspaceReadiness {
  readonly ready: boolean;
  readonly includedFrameCount: number;
  readonly issues: readonly FrameWorkspaceReadinessIssue[];
}

export function validateFrameWorkspaceSnapshot(workspace: FrameWorkspace): FrameWorkspaceReadiness {
  const issues: FrameWorkspaceReadinessIssue[] = [];
  const seenSlotIds = new Set<string>();
  const sequenceIndexes = new Set<number>();
  let includedFrameCount = 0;
  for (const slotId of workspace.orderedSlotIds) {
    if (seenSlotIds.has(slotId)) {
      issues.push({ code: "duplicate_slot_id", slotId, message: "工作区顺序包含重复槽位。" });
      continue;
    }
    seenSlotIds.add(slotId);
    const slot = workspace.slots[slotId];
    if (!slot) {
      issues.push({ code: "missing_slot", slotId, message: "工作区顺序引用了不存在的槽位。" });
      continue;
    }
    if (slot.decision === "removed") continue;
    includedFrameCount += 1;
    if (slot.decision !== "kept") {
      issues.push({ code: "unreviewed_frame", slotId, message: "纳入快照的帧尚未标记为保留。" });
    }
    if (sequenceIndexes.has(slot.originalSequenceIndex)) {
      issues.push({ code: "duplicate_original_sequence_index", slotId, message: "原始序列索引重复。" });
    }
    sequenceIndexes.add(slot.originalSequenceIndex);
    const revision = workspace.revisions[slot.currentRevisionId];
    if (!revision) {
      issues.push({ code: "missing_revision", slotId, message: "当前采用修订不存在。" });
      continue;
    }
    if (revision.slotId !== slotId || revision.workspaceId !== workspace.workspaceId) {
      issues.push({ code: "revision_slot_mismatch", slotId, message: "当前修订归属不一致。" });
    }
    const currentRevisionCount = Object.values(workspace.revisions).filter(
      (item) => item.slotId === slotId && item.isCurrent,
    ).length;
    if (!revision.isCurrent || currentRevisionCount !== 1) {
      issues.push({ code: "current_revision_mismatch", slotId, message: "槽位当前修订标记不一致。" });
    }
    if (!revision.readable) {
      issues.push({ code: "unreadable_revision", slotId, message: "当前采用资源不可读。" });
    }
    if (!revision.resourceRef.trim() || /^(?:blob|data):/i.test(revision.resourceRef) || !supportedFrameMimeTypes.has(revision.mimeType) || !Number.isInteger(revision.size) || revision.size <= 0) {
      issues.push({ code: "invalid_revision_resource", slotId, message: "当前采用资源引用或元数据无效。" });
    }
    if (revision.width !== workspace.source.canvas.width || revision.height !== workspace.source.canvas.height) {
      issues.push({ code: "dimension_mismatch", slotId, message: "当前采用资源尺寸与画布不一致。" });
    }
    for (const attemptId of slot.retryAttemptIds) {
      const attempt = workspace.retryAttempts[attemptId];
      if (!attempt) {
        issues.push({ code: "missing_retry_attempt", slotId, retryAttemptId: attemptId, message: "槽位引用的重试尝试不存在。" });
      } else if (attempt.slotId !== slotId || attempt.workspaceId !== workspace.workspaceId) {
        issues.push({ code: "retry_attempt_slot_mismatch", slotId, retryAttemptId: attemptId, message: "重试尝试归属不一致。" });
      }
      if (attempt?.candidateRevisionId && !workspace.revisions[attempt.candidateRevisionId]) {
        issues.push({ code: "missing_candidate_revision", slotId, retryAttemptId: attemptId, message: "重试尝试引用的候选修订不存在。" });
      }
    }
  }
  for (const slotId of Object.keys(workspace.slots)) {
    if (!seenSlotIds.has(slotId)) {
      issues.push({ code: "unordered_slot", slotId, message: "工作区槽位未出现在稳定顺序中。" });
    }
  }
  if (includedFrameCount < 2) {
    issues.push({ code: "too_few_frames", message: "工作区至少需要 2 个纳入序列的帧。" });
  }
  for (const attempt of Object.values(workspace.retryAttempts)) {
    if (activeRetryStatuses.has(attempt.status)) {
      issues.push({ code: "active_retry", slotId: attempt.slotId, retryAttemptId: attempt.id, message: "存在尚未结束或待处理的重试。" });
    }
  }
  return { ready: issues.length === 0, includedFrameCount, issues };
}

export interface FrameWorkspaceSnapshotFrame {
  readonly outputIndex: number;
  readonly slotId: string;
  readonly originalFrameId: string;
  readonly originalSequenceIndex: number;
  readonly revisionId: string;
  readonly revisionSource: FrameRevisionSource;
  readonly resourceRef: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly size: number;
}

export interface FrameWorkspaceSnapshot {
  readonly snapshotId: string;
  readonly workspaceId: string;
  readonly schemaVersion: typeof FRAME_WORKSPACE_SCHEMA_VERSION;
  readonly revision: number;
  readonly sourceJobId: string;
  readonly createdAt: string;
  readonly frames: readonly FrameWorkspaceSnapshotFrame[];
  readonly frameRate: number;
  readonly loopMode: SequenceLoopMode;
  readonly canvas: SequenceCanvasParameters;
  readonly anchor: SequenceAnchor;
}

export interface CreateFrameWorkspaceSnapshotInput {
  readonly snapshotId: string;
  readonly createdAt: string;
}

export function freezeFrameWorkspaceSnapshot(
  snapshot: FrameWorkspaceSnapshot,
): FrameWorkspaceSnapshot {
  Object.freeze(snapshot.canvas);
  for (const frame of snapshot.frames) Object.freeze(frame);
  Object.freeze(snapshot.frames);
  return Object.freeze(snapshot);
}

export function createFrameWorkspaceSnapshot(
  workspace: FrameWorkspace,
  input: CreateFrameWorkspaceSnapshotInput,
): FrameWorkspaceSnapshot {
  const readiness = validateFrameWorkspaceSnapshot(workspace);
  if (!readiness.ready) {
    throw new Error(`工作区尚不可交接：${readiness.issues.map((issue) => issue.message).join("；")}`);
  }
  if (!input.snapshotId.trim() || Number.isNaN(Date.parse(input.createdAt))) {
    throw new Error("快照 ID 或创建时间无效。");
  }
  const frames = workspace.orderedSlotIds
    .map((slotId) => workspace.slots[slotId])
    .filter((slot): slot is FrameWorkspaceSlot => Boolean(slot) && slot.decision === "kept")
    .map((slot, outputIndex): FrameWorkspaceSnapshotFrame => {
      const revision = workspace.revisions[slot.currentRevisionId]!;
      return {
        outputIndex,
        slotId: slot.id,
        originalFrameId: slot.originalFrameId,
        originalSequenceIndex: slot.originalSequenceIndex,
        revisionId: revision.id,
        revisionSource: revision.source,
        resourceRef: revision.resourceRef,
        mimeType: revision.mimeType,
        width: revision.width,
        height: revision.height,
        size: revision.size,
      };
    });
  return freezeFrameWorkspaceSnapshot({
    snapshotId: input.snapshotId,
    workspaceId: workspace.workspaceId,
    schemaVersion: workspace.schemaVersion,
    revision: workspace.revision,
    sourceJobId: workspace.sourceJobId,
    createdAt: input.createdAt,
    frames,
    frameRate: workspace.source.frameRate,
    loopMode: workspace.source.loopMode,
    canvas: { ...workspace.source.canvas },
    anchor: workspace.source.anchor,
  });
}
