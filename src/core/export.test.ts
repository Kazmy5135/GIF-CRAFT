import { describe, expect, it } from "vitest";
import type { FrameWorkspaceSnapshot } from "./frameWorkspace";
import {
  createPngZipExportDescriptor,
  PngZipExportError,
  pngFrameFileName,
} from "./export";

function snapshot(): FrameWorkspaceSnapshot {
  return {
    snapshotId: "snapshot-1",
    workspaceId: "workspace-1",
    schemaVersion: 1,
    revision: 4,
    sourceJobId: "job-1",
    createdAt: "2026-07-13T04:00:00.000Z",
    frameRate: 12,
    loopMode: "loop",
    canvas: { mode: "source", aspectRatio: "1:1", width: 64, height: 64 },
    anchor: "bottom_center_feet_baseline",
    frames: [0, 1].map((index) => ({
      outputIndex: index,
      slotId: `slot-${index}`,
      originalFrameId: `frame-${index}`,
      originalSequenceIndex: index,
      revisionId: `revision-${index}`,
      revisionSource: "original" as const,
      resourceRef: `frame-resource:${index}`,
      mimeType: "image/png",
      width: 64,
      height: 64,
      size: 8,
    })),
  };
}

describe("PNG ZIP export contract", () => {
  it("creates continuous PNG names and freezes all reproducibility metadata", () => {
    const descriptor = createPngZipExportDescriptor(snapshot());

    expect(descriptor.archiveFileName).toBe("sequence-job-1-snapshot-snapshot-1.zip");
    expect(descriptor.manifest).toMatchObject({
      schemaVersion: 1,
      format: "png-zip",
      sequenceId: "job-1",
      sourceJobId: "job-1",
      workspaceId: "workspace-1",
      snapshotId: "snapshot-1",
      revision: 4,
      frameRate: 12,
      loopMode: "loop",
      canvas: { width: 64, height: 64, aspectRatio: "1:1" },
      anchor: "bottom_center_feet_baseline",
    });
    expect(descriptor.manifest.frames.map((frame) => frame.fileName)).toEqual([
      "frame-0001.png",
      "frame-0002.png",
    ]);
    expect(Object.isFrozen(descriptor.manifest.frames)).toBe(true);
    expect(Object.isFrozen(descriptor.manifest.canvas)).toBe(true);
  });

  it("rejects gaps in snapshot output order", () => {
    const invalid: FrameWorkspaceSnapshot = {
      ...snapshot(),
      frames: snapshot().frames.map((frame, index) =>
        index === 1 ? { ...frame, outputIndex: 3 } : frame,
      ),
    };

    expect(() => createPngZipExportDescriptor(invalid)).toThrow(PngZipExportError);
    expect(() => pngFrameFileName(2, 2)).toThrow(PngZipExportError);
  });
});
