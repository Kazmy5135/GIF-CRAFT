import type {
  FrameWorkspaceSnapshot,
  FrameWorkspaceSnapshotFrame,
} from "./frameWorkspace.js";

export const PNG_ZIP_EXPORT_SCHEMA_VERSION = 1 as const;

export type PngZipExportErrorCode =
  | "invalid_snapshot_id"
  | "snapshot_not_found"
  | "snapshot_invalid"
  | "resource_missing"
  | "resource_mismatch"
  | "image_decode_failed"
  | "zip_failed"
  | "download_failed";

export class PngZipExportError extends Error {
  constructor(
    readonly code: PngZipExportErrorCode,
    message: string,
    readonly recoverable = true,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PngZipExportError";
  }
}

export interface PngZipManifestFrame {
  readonly outputIndex: number;
  readonly outputNumber: number;
  readonly fileName: string;
  readonly slotId: string;
  readonly originalFrameId: string;
  readonly originalSequenceIndex: number;
  readonly revisionId: string;
  readonly revisionSource: FrameWorkspaceSnapshotFrame["revisionSource"];
  readonly resourceRef: string;
  readonly width: number;
  readonly height: number;
}

export interface PngZipManifest {
  readonly schemaVersion: typeof PNG_ZIP_EXPORT_SCHEMA_VERSION;
  readonly format: "png-zip";
  /** Sequence ID intentionally reuses GenerationJob.id. */
  readonly sequenceId: string;
  readonly sourceJobId: string;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly snapshotCreatedAt: string;
  readonly revision: number;
  readonly frameRate: number;
  readonly loopMode: FrameWorkspaceSnapshot["loopMode"];
  readonly canvas: FrameWorkspaceSnapshot["canvas"];
  readonly anchor: FrameWorkspaceSnapshot["anchor"];
  readonly frames: readonly PngZipManifestFrame[];
}

export interface PngZipExportDescriptor {
  readonly snapshot: FrameWorkspaceSnapshot;
  readonly manifest: PngZipManifest;
  readonly archiveFileName: string;
}

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

function assertSafeId(value: string, label: string): void {
  if (!value.trim()) {
    throw new PngZipExportError("snapshot_invalid", `${label} 不能为空。`, false);
  }
}

export function assertExportableSnapshot(snapshot: FrameWorkspaceSnapshot): void {
  assertSafeId(snapshot.snapshotId, "快照 ID");
  assertSafeId(snapshot.workspaceId, "工作区 ID");
  assertSafeId(snapshot.sourceJobId, "序列 ID");
  if (
    snapshot.schemaVersion !== 1 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Number.isSafeInteger(snapshot.frameRate) ||
    snapshot.frameRate <= 0 ||
    Number.isNaN(Date.parse(snapshot.createdAt)) ||
    !["loop", "once"].includes(snapshot.loopMode) ||
    snapshot.canvas.mode !== "source" ||
    !snapshot.canvas.aspectRatio ||
    !Number.isSafeInteger(snapshot.canvas.width) ||
    snapshot.canvas.width <= 0 ||
    !Number.isSafeInteger(snapshot.canvas.height) ||
    snapshot.canvas.height <= 0 ||
    !["bottom_center_feet_baseline", "full_canvas_fixed_camera"].includes(
      snapshot.anchor,
    ) ||
    snapshot.frames.length < 2
  ) {
    throw new PngZipExportError(
      "snapshot_invalid",
      "快照的修订、帧率、创建时间或帧数量无效。",
      false,
    );
  }

  const slots = new Set<string>();
  const revisions = new Set<string>();
  const originalFrameIds = new Set<string>();
  const originalSequenceIndexes = new Set<number>();
  snapshot.frames.forEach((frame, index) => {
    if (
      frame.outputIndex !== index ||
      !frame.slotId.trim() ||
      !frame.originalFrameId.trim() ||
      !frame.revisionId.trim() ||
      !frame.resourceRef.trim() ||
      !Number.isSafeInteger(frame.originalSequenceIndex) ||
      frame.originalSequenceIndex < 0 ||
      !["original", "retry_candidate"].includes(frame.revisionSource) ||
      !allowedImageTypes.has(frame.mimeType) ||
      frame.width !== snapshot.canvas.width ||
      frame.height !== snapshot.canvas.height ||
      !Number.isSafeInteger(frame.size) ||
      frame.size <= 0 ||
      slots.has(frame.slotId) ||
      revisions.has(frame.revisionId) ||
      originalFrameIds.has(frame.originalFrameId) ||
      originalSequenceIndexes.has(frame.originalSequenceIndex)
    ) {
      throw new PngZipExportError(
        "snapshot_invalid",
        `快照第 ${index + 1} 帧的顺序、资源元数据或唯一性无效。`,
        false,
      );
    }
    slots.add(frame.slotId);
    revisions.add(frame.revisionId);
    originalFrameIds.add(frame.originalFrameId);
    originalSequenceIndexes.add(frame.originalSequenceIndex);
  });
}

export function pngFrameFileName(outputIndex: number, frameCount: number): string {
  if (
    !Number.isSafeInteger(outputIndex) ||
    outputIndex < 0 ||
    !Number.isSafeInteger(frameCount) ||
    outputIndex >= frameCount
  ) {
    throw new PngZipExportError("snapshot_invalid", "导出帧编号无效。", false);
  }
  const width = Math.max(4, String(frameCount).length);
  return `frame-${String(outputIndex + 1).padStart(width, "0")}.png`;
}

function safeFileSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 40) || "sequence";
}

export function createPngZipExportDescriptor(
  snapshot: FrameWorkspaceSnapshot,
): PngZipExportDescriptor {
  assertExportableSnapshot(snapshot);
  const manifest: PngZipManifest = Object.freeze({
    schemaVersion: PNG_ZIP_EXPORT_SCHEMA_VERSION,
    format: "png-zip",
    sequenceId: snapshot.sourceJobId,
    sourceJobId: snapshot.sourceJobId,
    workspaceId: snapshot.workspaceId,
    snapshotId: snapshot.snapshotId,
    snapshotCreatedAt: snapshot.createdAt,
    revision: snapshot.revision,
    frameRate: snapshot.frameRate,
    loopMode: snapshot.loopMode,
    canvas: Object.freeze({ ...snapshot.canvas }),
    anchor: snapshot.anchor,
    frames: Object.freeze(
      snapshot.frames.map((frame) =>
        Object.freeze({
          outputIndex: frame.outputIndex,
          outputNumber: frame.outputIndex + 1,
          fileName: pngFrameFileName(frame.outputIndex, snapshot.frames.length),
          slotId: frame.slotId,
          originalFrameId: frame.originalFrameId,
          originalSequenceIndex: frame.originalSequenceIndex,
          revisionId: frame.revisionId,
          revisionSource: frame.revisionSource,
          resourceRef: frame.resourceRef,
          width: frame.width,
          height: frame.height,
        }),
      ),
    ),
  });

  return Object.freeze({
    snapshot,
    manifest,
    archiveFileName: `sequence-${safeFileSegment(snapshot.sourceJobId)}-snapshot-${safeFileSegment(snapshot.snapshotId)}.zip`,
  });
}

export function normalizePngZipExportError(error: unknown): PngZipExportError {
  if (error instanceof PngZipExportError) return error;
  return new PngZipExportError(
    "zip_failed",
    error instanceof Error ? error.message : "PNG ZIP 导出失败，请重试。",
    true,
    { cause: error },
  );
}
