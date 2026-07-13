import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPngZipExportDescriptor, PngZipExportError } from "../../core/export";
import type { FrameWorkspaceSnapshot } from "../../core/frameWorkspace";
import { ExportPage } from "./ExportPage";
import type { PngZipExportArchive, PngZipExportSource } from "./pngZipExportService";

function source(): PngZipExportSource {
  const snapshot: FrameWorkspaceSnapshot = {
    snapshotId: "snapshot-route",
    workspaceId: "workspace-1",
    schemaVersion: 1,
    revision: 2,
    sourceJobId: "job-1",
    createdAt: "2026-07-13T04:00:00.000Z",
    frameRate: 8,
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
      resourceRef: `resource-${index}`,
      mimeType: "image/png",
      width: 64,
      height: 64,
      size: 8,
    })),
  };
  const descriptor = createPngZipExportDescriptor(snapshot);
  return {
    ...descriptor,
    resolvedFrames: snapshot.frames.map((frame) => ({
      frame,
      blob: new Blob([new Uint8Array(8)], { type: "image/png" }),
    })),
  };
}

function renderPage(props: React.ComponentProps<typeof ExportPage>) {
  return render(
    <MemoryRouter initialEntries={["/export/snapshot-route"]}>
      <Routes>
        <Route path="/export/:snapshotId" element={<ExportPage {...props} />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("ExportPage", () => {
  it("reads the route snapshot ID and exposes loading, ready, exporting and downloaded states", async () => {
    const value = source();
    const loadSource = vi.fn(async () => value);
    let finishArchive: ((archive: PngZipExportArchive) => void) | undefined;
    const createArchive = vi.fn(
      () =>
        new Promise<PngZipExportArchive>((resolve) => {
          finishArchive = resolve;
        }),
    );
    const downloadArchive = vi.fn();
    renderPage({ loadSource, createArchive, downloadArchive });

    expect(screen.getByText(/正在读取不可变工作区快照/)).toBeInTheDocument();
    expect(await screen.findByText("snapshot-route")).toBeInTheDocument();
    expect(loadSource).toHaveBeenCalledWith("snapshot-route");
    expect(screen.getByRole("link", { name: "返回工作区" })).toHaveAttribute(
      "href",
      "/workspace/job-1",
    );

    fireEvent.click(screen.getByRole("button", { name: "下载 PNG ZIP" }));
    expect(screen.getByRole("button", { name: /正在生成 PNG ZIP/ })).toBeDisabled();
    finishArchive?.({
      blob: new Blob(),
      fileName: "sequence-job-1.zip",
      manifest: value.manifest,
    });
    await waitFor(() => expect(downloadArchive).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("sequence-job-1.zip");
  });

  it("offers a recoverable reload after snapshot preparation fails", async () => {
    const loadSource = vi
      .fn<(snapshotId: string) => Promise<PngZipExportSource>>()
      .mockRejectedValueOnce(
        new PngZipExportError("resource_missing", "帧资源暂时不可用。", true),
      )
      .mockResolvedValueOnce(source());
    renderPage({ loadSource });

    expect(await screen.findByRole("alert")).toHaveTextContent("帧资源暂时不可用");
    expect(screen.getByRole("link", { name: "返回序列帧库" })).toHaveAttribute(
      "href",
      "/library/sequences",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("snapshot-route")).toBeInTheDocument();
    expect(loadSource).toHaveBeenCalledTimes(2);
  });

  it("retains the validated source and retries an archive failure", async () => {
    const value = source();
    const createArchive = vi
      .fn<(input: PngZipExportSource) => Promise<PngZipExportArchive>>()
      .mockRejectedValueOnce(new PngZipExportError("zip_failed", "压缩失败。", true))
      .mockResolvedValueOnce({
        blob: new Blob(),
        fileName: "retry.zip",
        manifest: value.manifest,
      });
    const downloadArchive = vi.fn();
    renderPage({ loadSource: vi.fn(async () => value), createArchive, downloadArchive });

    await screen.findByText("snapshot-route");
    fireEvent.click(screen.getByRole("button", { name: "下载 PNG ZIP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("压缩失败");
    fireEvent.click(screen.getByRole("button", { name: "重试导出" }));
    await waitFor(() => expect(downloadArchive).toHaveBeenCalledTimes(1));
    expect(createArchive).toHaveBeenCalledTimes(2);
  });
});
