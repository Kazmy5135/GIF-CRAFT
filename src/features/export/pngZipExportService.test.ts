import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { PngZipExportError } from "../../core/export";
import type {
  FrameRevision,
  FrameWorkspaceSnapshot,
  FrameWorkspaceSnapshotFrame,
} from "../../core/frameWorkspace";
import type { Frame } from "../../core/sequenceGeneration";
import type { StoredWorkspaceFrameResource } from "../../infrastructure/storage/frameWorkspaceRepository";
import type { StoredFrameResource } from "../../infrastructure/storage/sequenceJobRepository";
import {
  createPngZipArchive,
  loadPngZipExportSource,
  type PngZipExportResourceLoader,
} from "./pngZipExportService";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const createdAt = "2026-07-13T04:00:00.000Z";

function snapshot(): FrameWorkspaceSnapshot {
  const base = {
    mimeType: "image/png",
    width: 64,
    height: 64,
    size: PNG_BYTES.byteLength,
  } as const;
  return {
    snapshotId: "snapshot-1",
    workspaceId: "workspace-1",
    schemaVersion: 1,
    revision: 3,
    sourceJobId: "job-1",
    createdAt,
    frameRate: 8,
    loopMode: "once",
    canvas: { mode: "source", aspectRatio: "1:1", width: 64, height: 64 },
    anchor: "full_canvas_fixed_camera",
    frames: [
      {
        ...base,
        outputIndex: 0,
        slotId: "slot-0",
        originalFrameId: "frame-0",
        originalSequenceIndex: 0,
        revisionId: "revision-original",
        revisionSource: "original",
        resourceRef: "original-ref",
      },
      {
        ...base,
        outputIndex: 1,
        slotId: "slot-1",
        originalFrameId: "frame-1",
        originalSequenceIndex: 1,
        revisionId: "revision-candidate",
        revisionSource: "retry_candidate",
        resourceRef: "candidate-1",
      },
    ],
  };
}

function originalResource(frame: FrameWorkspaceSnapshotFrame): StoredFrameResource {
  const metadata: Frame = {
    id: frame.originalFrameId,
    jobId: "job-1",
    providerIndex: frame.originalSequenceIndex,
    sequenceIndex: frame.originalSequenceIndex,
    resourceRef: frame.resourceRef,
    mimeType: frame.mimeType,
    width: frame.width,
    height: frame.height,
    size: frame.size,
    readable: true,
    createdAt,
  };
  return {
    id: frame.originalFrameId,
    jobId: "job-1",
    sequenceIndex: frame.originalSequenceIndex,
    createdAt,
    frame: metadata,
    blob: new Blob([PNG_BYTES], { type: "image/png" }),
    size: frame.size,
  };
}

function candidateResource(frame: FrameWorkspaceSnapshotFrame): StoredWorkspaceFrameResource {
  const revision: FrameRevision = {
    id: frame.revisionId,
    workspaceId: "workspace-1",
    slotId: frame.slotId,
    source: "retry_candidate",
    retryAttemptId: "attempt-1",
    resourceRef: frame.resourceRef,
    mimeType: frame.mimeType,
    width: frame.width,
    height: frame.height,
    size: frame.size,
    readable: true,
    createdAt,
    isCurrent: true,
  };
  return {
    id: frame.resourceRef,
    workspaceId: "workspace-1",
    slotId: frame.slotId,
    attemptId: "attempt-1",
    sourceJobId: "job-1",
    mimeType: frame.mimeType,
    width: frame.width,
    height: frame.height,
    size: frame.size,
    createdAt,
    adoptedAt: createdAt,
    adoptedRevision: 3,
    revision,
    blob: new Blob([PNG_BYTES], { type: "image/png" }),
  };
}

function loader(overrides: Partial<PngZipExportResourceLoader> = {}): PngZipExportResourceLoader {
  const value = snapshot();
  return {
    getSnapshot: vi.fn(async () => value),
    listOriginalFrames: vi.fn(async () => [originalResource(value.frames[0]!)]),
    listCandidateFrames: vi.fn(async () => [candidateResource(value.frames[1]!)]),
    ...overrides,
  };
}

describe("PNG ZIP export service", () => {
  it("resolves original and adopted candidate blobs, then writes PNG files and manifest", async () => {
    const source = await loadPngZipExportSource("snapshot-1", loader());
    expect(source.resolvedFrames.map((item) => item.frame.revisionSource)).toEqual([
      "original",
      "retry_candidate",
    ]);

    const archive = await createPngZipArchive(source, async (blob) => blob);
    const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual([
      "frame-0001.png",
      "frame-0002.png",
      "manifest.json",
    ]);
    expect([...files["frame-0001.png"]!]).toEqual([...PNG_BYTES]);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    expect(manifest).toMatchObject({
      sequenceId: "job-1",
      sourceJobId: "job-1",
      workspaceId: "workspace-1",
      snapshotId: "snapshot-1",
      revision: 3,
      frameRate: 8,
      loopMode: "once",
      frames: [
        { outputIndex: 0, fileName: "frame-0001.png", revisionSource: "original" },
        { outputIndex: 1, fileName: "frame-0002.png", revisionSource: "retry_candidate" },
      ],
    });
  });

  it("reports a recoverable resource mismatch without producing a partial archive", async () => {
    const value = snapshot();
    const invalid = originalResource(value.frames[0]!);
    invalid.frame = { ...invalid.frame, width: 32 };

    await expect(
      loadPngZipExportSource(
        "snapshot-1",
        loader({ listOriginalFrames: vi.fn(async () => [invalid]) }),
      ),
    ).rejects.toMatchObject({ code: "resource_mismatch", recoverable: true });
  });

  it("rejects missing snapshots and non-PNG encoder output with typed errors", async () => {
    await expect(
      loadPngZipExportSource(
        "missing",
        loader({ getSnapshot: vi.fn(async () => undefined) }),
      ),
    ).rejects.toMatchObject({ code: "snapshot_not_found" });

    const source = await loadPngZipExportSource("snapshot-1", loader());
    await expect(
      createPngZipArchive(source, async () => new Blob([new Uint8Array([1, 2, 3])])),
    ).rejects.toBeInstanceOf(PngZipExportError);
  });
});
