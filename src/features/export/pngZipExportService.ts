import { zipSync } from "fflate";
import {
  createPngZipExportDescriptor,
  normalizePngZipExportError,
  PngZipExportError,
  type PngZipExportDescriptor,
} from "../../core/export";
import type {
  FrameWorkspaceSnapshot,
  FrameWorkspaceSnapshotFrame,
} from "../../core/frameWorkspace";
import {
  getFrameWorkspaceSnapshot,
  listWorkspaceFrameResources,
  type StoredWorkspaceFrameResource,
} from "../../infrastructure/storage/frameWorkspaceRepository";
import {
  listFrameResources,
  type StoredFrameResource,
} from "../../infrastructure/storage/sequenceJobRepository";

export interface ResolvedPngZipFrame {
  readonly frame: FrameWorkspaceSnapshotFrame;
  readonly blob: Blob;
}

export interface PngZipExportSource extends PngZipExportDescriptor {
  readonly resolvedFrames: readonly ResolvedPngZipFrame[];
}

export interface PngZipExportArchive {
  readonly blob: Blob;
  readonly fileName: string;
  readonly manifest: PngZipExportDescriptor["manifest"];
}

export interface PngZipExportResourceLoader {
  getSnapshot(snapshotId: string): Promise<FrameWorkspaceSnapshot | undefined>;
  listOriginalFrames(sourceJobId: string): Promise<readonly StoredFrameResource[]>;
  listCandidateFrames(workspaceId: string): Promise<readonly StoredWorkspaceFrameResource[]>;
}

export interface PngZipEncoder {
  (blob: Blob, frame: FrameWorkspaceSnapshotFrame): Promise<Blob>;
}

export interface PngZipArchiveBuilder {
  (files: Readonly<Record<string, Uint8Array>>): Promise<Blob>;
}

const defaultResourceLoader: PngZipExportResourceLoader = {
  getSnapshot: getFrameWorkspaceSnapshot,
  listOriginalFrames: listFrameResources,
  listCandidateFrames: listWorkspaceFrameResources,
};

function assertSnapshotId(snapshotId: string): void {
  if (!snapshotId.trim()) {
    throw new PngZipExportError(
      "invalid_snapshot_id",
      "缺少工作区快照 ID，无法开始导出。",
      false,
    );
  }
}

function assertBlob(
  blob: unknown,
  frame: FrameWorkspaceSnapshotFrame,
  label: string,
): asserts blob is Blob {
  if (!(blob instanceof Blob)) {
    throw new PngZipExportError("resource_missing", `${label} Blob 不存在。`);
  }
  if (
    blob.size !== frame.size ||
    (blob.type !== "" && blob.type.toLowerCase() !== frame.mimeType.toLowerCase())
  ) {
    throw new PngZipExportError(
      "resource_mismatch",
      `${label} Blob 的大小或 MIME 类型与快照不一致。`,
    );
  }
}

function resolveOriginalFrame(
  snapshot: FrameWorkspaceSnapshot,
  frame: FrameWorkspaceSnapshotFrame,
  resources: ReadonlyMap<string, StoredFrameResource>,
): ResolvedPngZipFrame {
  const resource = resources.get(frame.originalFrameId);
  const metadata = resource?.frame;
  if (
    !resource ||
    resource.id !== frame.originalFrameId ||
    resource.jobId !== snapshot.sourceJobId ||
    resource.sequenceIndex !== frame.originalSequenceIndex ||
    resource.size !== frame.size ||
    !metadata ||
    metadata.id !== frame.originalFrameId ||
    metadata.jobId !== snapshot.sourceJobId ||
    metadata.sequenceIndex !== frame.originalSequenceIndex ||
    metadata.resourceRef !== frame.resourceRef ||
    metadata.mimeType !== frame.mimeType ||
    metadata.width !== frame.width ||
    metadata.height !== frame.height ||
    metadata.size !== frame.size ||
    !metadata.readable
  ) {
    throw new PngZipExportError(
      resource ? "resource_mismatch" : "resource_missing",
      `第 ${frame.outputIndex + 1} 帧的原始资源不存在或与快照不一致。`,
    );
  }
  assertBlob(resource.blob, frame, `第 ${frame.outputIndex + 1} 帧的原始资源`);
  return Object.freeze({ frame, blob: resource.blob });
}

function resolveCandidateFrame(
  snapshot: FrameWorkspaceSnapshot,
  frame: FrameWorkspaceSnapshotFrame,
  resources: ReadonlyMap<string, StoredWorkspaceFrameResource>,
): ResolvedPngZipFrame {
  const resource = resources.get(frame.resourceRef);
  const revision = resource?.revision;
  if (
    !resource ||
    resource.id !== frame.resourceRef ||
    resource.workspaceId !== snapshot.workspaceId ||
    resource.sourceJobId !== snapshot.sourceJobId ||
    resource.mimeType !== frame.mimeType ||
    resource.width !== frame.width ||
    resource.height !== frame.height ||
    resource.size !== frame.size ||
    resource.adoptedRevision === undefined ||
    resource.adoptedRevision > snapshot.revision ||
    !revision ||
    revision.id !== frame.revisionId ||
    revision.resourceRef !== frame.resourceRef ||
    revision.mimeType !== frame.mimeType ||
    revision.width !== frame.width ||
    revision.height !== frame.height ||
    revision.size !== frame.size
  ) {
    throw new PngZipExportError(
      resource ? "resource_mismatch" : "resource_missing",
      `第 ${frame.outputIndex + 1} 帧的候选资源不存在或与快照不一致。`,
    );
  }
  assertBlob(resource.blob, frame, `第 ${frame.outputIndex + 1} 帧的候选资源`);
  return Object.freeze({ frame, blob: resource.blob });
}

export async function loadPngZipExportSource(
  snapshotId: string,
  loader: PngZipExportResourceLoader = defaultResourceLoader,
): Promise<PngZipExportSource> {
  assertSnapshotId(snapshotId);
  const snapshot = await loader.getSnapshot(snapshotId);
  if (!snapshot) {
    throw new PngZipExportError(
      "snapshot_not_found",
      "工作区快照不存在或已被清理，请返回工作区重新生成快照。",
    );
  }
  const descriptor = createPngZipExportDescriptor(snapshot);
  const [originalFrames, candidateFrames] = await Promise.all([
    loader.listOriginalFrames(snapshot.sourceJobId),
    loader.listCandidateFrames(snapshot.workspaceId),
  ]);
  const originalsById = new Map(originalFrames.map((resource) => [resource.id, resource]));
  const candidatesById = new Map(candidateFrames.map((resource) => [resource.id, resource]));
  const resolvedFrames = snapshot.frames.map((frame) =>
    frame.revisionSource === "original"
      ? resolveOriginalFrame(snapshot, frame, originalsById)
      : resolveCandidateFrame(snapshot, frame, candidatesById),
  );
  return Object.freeze({ ...descriptor, resolvedFrames: Object.freeze(resolvedFrames) });
}

interface DecodedImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}

async function decodeWithImageBitmap(blob: Blob): Promise<DecodedImage | undefined> {
  if (typeof globalThis.createImageBitmap !== "function") return undefined;
  const bitmap = await globalThis.createImageBitmap(blob);
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    close: () => bitmap.close(),
  };
}

function decodeWithImageElement(blob: Blob): Promise<DecodedImage> {
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return Promise.reject(new Error("当前环境不支持图片解码。"));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const release = () => URL.revokeObjectURL(url);
    image.onload = () => {
      release();
      resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => undefined,
      });
    };
    image.onerror = () => {
      release();
      reject(new Error("图片无法解码。"));
    };
    image.src = url;
  });
}

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  return (await decodeWithImageBitmap(blob)) ?? decodeWithImageElement(blob);
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("浏览器未能编码 PNG。"));
      else resolve(blob);
    }, "image/png");
  });
}

export const browserPngEncoder: PngZipEncoder = async (blob, frame) => {
  let decoded: DecodedImage | undefined;
  try {
    decoded = await decodeImage(blob);
    if (decoded.width !== frame.width || decoded.height !== frame.height) {
      throw new Error("解码后的图片尺寸与快照不一致。");
    }
    if (frame.mimeType === "image/png") {
      return blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });
    }
    if (typeof document === "undefined") throw new Error("当前环境不支持 PNG 编码。");
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建图片编码画布。");
    context.drawImage(decoded.source, 0, 0, frame.width, frame.height);
    return await canvasToPngBlob(canvas);
  } catch (error) {
    throw new PngZipExportError(
      "image_decode_failed",
      `第 ${frame.outputIndex + 1} 帧无法解码或转换为 PNG。`,
      true,
      { cause: error },
    );
  } finally {
    decoded?.close();
  }
};

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function assertPngBytes(blob: Blob, outputIndex: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length || signature.some((value, index) => bytes[index] !== value)) {
    throw new PngZipExportError(
      "image_decode_failed",
      `第 ${outputIndex + 1} 帧的编码结果不是有效 PNG。`,
    );
  }
  return bytes;
}

export const fflatePngZipArchiveBuilder: PngZipArchiveBuilder = async (files) => {
  try {
    const entries = Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, [bytes, { level: 0 }]]),
    ) as Record<string, [Uint8Array, { level: 0 }]>;
    const archive = zipSync(entries);
    return new Blob([copyToArrayBuffer(archive)], { type: "application/zip" });
  } catch (error) {
    throw new PngZipExportError("zip_failed", "无法生成 PNG ZIP 文件，请重试。", true, {
      cause: error,
    });
  }
};

export async function createPngZipArchive(
  source: PngZipExportSource,
  encoder: PngZipEncoder = browserPngEncoder,
  archiveBuilder: PngZipArchiveBuilder = fflatePngZipArchiveBuilder,
): Promise<PngZipExportArchive> {
  try {
    const files: Record<string, Uint8Array> = {};
    for (const resolved of source.resolvedFrames) {
      const mapping = source.manifest.frames[resolved.frame.outputIndex];
      if (!mapping || mapping.outputIndex !== resolved.frame.outputIndex) {
        throw new PngZipExportError(
          "snapshot_invalid",
          "快照帧与导出清单的连续顺序不一致。",
          false,
        );
      }
      files[mapping.fileName] = await assertPngBytes(
        await encoder(resolved.blob, resolved.frame),
        resolved.frame.outputIndex,
      );
    }
    const manifestJson = `${JSON.stringify(source.manifest, null, 2)}\n`;
    files["manifest.json"] = new Uint8Array(
      await new Blob([manifestJson], { type: "application/json" }).arrayBuffer(),
    );
    return Object.freeze({
      blob: await archiveBuilder(files),
      fileName: source.archiveFileName,
      manifest: source.manifest,
    });
  } catch (error) {
    throw normalizePngZipExportError(error);
  }
}

export function downloadPngZipArchive(archive: PngZipExportArchive): void {
  let url: string | undefined;
  try {
    url = URL.createObjectURL(archive.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = archive.fileName;
    anchor.rel = "noopener";
    anchor.click();
    const downloadUrl = url;
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    throw new PngZipExportError(
      "download_failed",
      "ZIP 已生成，但浏览器未能开始下载，请重试。",
      true,
      { cause: error },
    );
  }
}
