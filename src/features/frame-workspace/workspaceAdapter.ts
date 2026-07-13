import type { Frame, GenerationJob, SequenceLoopMode } from "../../core/sequenceGeneration";

export type FrameDecisionView = "pending" | "kept" | "removed";
export type WorkspaceFilter = "all" | FrameDecisionView;
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "failed";

export interface EligibleJobView {
  id: string;
  presetName: string;
  frameCount: number;
  frameRate: number;
  loopMode: SequenceLoopMode;
  createdAt: string;
}

export interface WorkspaceFrameView {
  id: string;
  originalFrameId: string;
  originalIndex: number;
  decision: FrameDecisionView;
  currentVersion: "original" | "candidate";
  frame: Frame;
  blob: Blob | null;
  retryStatus?: "idle" | "running" | "candidate_ready" | "status_unknown" | "failed";
  retryMode?: "native_single_frame" | "full_sequence_fallback" | "unsupported";
  retryError?: string;
  retryCanReconcile?: boolean;
  retryCanAbandon?: boolean;
  candidate?: {
    attemptId: string;
    frame: Frame;
    blob: Blob | null;
  };
}

export interface WorkspaceView {
  id: string;
  /** @deprecated Use sourceJobId. */
  jobId: string;
  sourceJobId: string;
  sourceImageId: string;
  revision: number;
  persistedRevision: number;
  presetName: string;
  /** @deprecated Use playbackFrameRate. */
  frameRate: number;
  sourceFrameRate: number;
  playbackFrameRate: number;
  loopMode: SequenceLoopMode;
  canvas: { width: number; height: number };
  frames: WorkspaceFrameView[];
  updatedAt: string;
  /** Adapter-private domain payload. Components must never inspect it. */
  opaque?: unknown;
}

export interface ReadinessView {
  ready: boolean;
  issues: string[];
}

export interface SnapshotView {
  id: string;
  frameCount: number;
  createdAt: string;
}

export type WorkspaceCommand =
  | { type: "set_decision"; frameId: string; decision: FrameDecisionView }
  | { type: "restore"; frameId: string }
  | { type: "move"; frameId: string; targetIndex: number }
  | { type: "set_frame_rate"; frameRate: number };

export class WorkspaceConflictError extends Error {
  constructor(message = "工作区已在另一个页面更新。") {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

/**
 * UI-only port. Domain/storage details stay behind this adapter so the page never
 * reconstructs revision, ordering or snapshot rules.
 */
export interface FrameWorkspaceAdapter {
  listEligibleJobs(): Promise<EligibleJobView[]>;
  loadOrCreate(jobId: string): Promise<WorkspaceView>;
  apply(workspace: WorkspaceView, command: WorkspaceCommand): WorkspaceView;
  save(workspace: WorkspaceView, expectedRevision: number): Promise<WorkspaceView>;
  checkReadiness(workspace: WorkspaceView): ReadinessView;
  createSnapshot(workspace: WorkspaceView): Promise<SnapshotView>;
  describeRetryCapability(frame: WorkspaceFrameView): string;
  requestRetry(workspace: WorkspaceView, frameId: string): Promise<WorkspaceView>;
  acceptCandidate(workspace: WorkspaceView, frameId: string): Promise<WorkspaceView>;
  discardCandidate(workspace: WorkspaceView, frameId: string): Promise<WorkspaceView>;
  restoreOriginal(workspace: WorkspaceView, frameId: string): Promise<WorkspaceView>;
  abandonRetryTracking(workspace: WorkspaceView, frameId: string): Promise<WorkspaceView>;
}

export function isEligibleGenerationJob(job: GenerationJob): boolean {
  return job.status === "completed" && job.resultIntegrity.status === "complete" && job.frameIds.length > 0;
}
