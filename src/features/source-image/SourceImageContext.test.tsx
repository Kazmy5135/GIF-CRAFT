import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceImageAsset } from "../../core/sourceImage";
import * as sourceImageRepository from "../../infrastructure/storage/sourceImageRepository";
import { SourceImageInUseError } from "../../infrastructure/storage/sourceImageRepository";
import * as imageFile from "./imageFile";
import { SourceImageProvider, useSourceImages } from "./SourceImageContext";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const candidate: SourceImageAsset = {
  id: "source-1",
  jobId: "source-job",
  provider: "local",
  model: "local",
  mode: "local_upload",
  createdAt: "2026-07-11T10:00:00.000Z",
  dataUrl: "data:image/png;base64,AA==",
  mimeType: "image/png",
  width: 512,
  height: 512,
  sourceName: "hero.png",
  availability: "unknown",
  promptSnapshot: { userPrompt: "", basePrompt: "", negativePrompt: "", compiledPrompt: "", templateVersion: 1 },
  effectiveParameters: { aspectRatio: "1:1", quality: "standard", providerSize: "512x512" },
};

function Probe() {
  const context = useSourceImages();
  return (
    <div>
      <span data-testid="loading">{String(context.historyLoading)}</span>
      <span data-testid="current">{context.currentSourceId ?? "none"}</span>
      <span data-testid="availability">{context.currentSource?.availability ?? "none"}</span>
      <span data-testid="error">{context.taskError}</span>
      <span data-testid="count">{context.history.length}</span>
      <button type="button" onClick={() => void context.confirmSource("source-1")}>confirm</button>
      <button type="button" onClick={() => void context.removeSourceImage("source-1")}>remove</button>
    </div>
  );
}

describe("SourceImageContext confirmation", () => {
  it("decodes and fingerprints the exact bytes before persisting confirmation", async () => {
    const save = vi.spyOn(sourceImageRepository, "saveSourceImage").mockResolvedValue(undefined);
    vi.spyOn(sourceImageRepository, "listSourceImages").mockResolvedValue([candidate]);
    vi.spyOn(imageFile, "getImageDimensions").mockResolvedValue({ width: 512, height: 512 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ providers: [] }), { status: 200 })));
    vi.stubGlobal("crypto", {
      randomUUID: () => "uuid",
      subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) },
    });

    render(<SourceImageProvider><Probe /></SourceImageProvider>);
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("current")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await waitFor(() => expect(screen.getByTestId("current")).toHaveTextContent("source-1"));
    expect(screen.getByTestId("availability")).toHaveTextContent("available");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "source-1",
        confirmedAt: expect.any(String),
        contentSnapshotId: `sha256:${"00".repeat(32)}`,
        size: 1,
        availability: "available",
      }),
    );
    expect(localStorage.getItem("gif-craft.current-source-image-id")).toBe("source-1");
  });

  it("keeps source history and reports a referenced-source deletion failure", async () => {
    vi.spyOn(sourceImageRepository, "listSourceImages").mockResolvedValue([candidate]);
    vi.spyOn(sourceImageRepository, "deleteSourceImage").mockRejectedValue(new SourceImageInUseError("source-1"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ providers: [] }), { status: 200 })));
    render(<SourceImageProvider><Probe /></SourceImageProvider>);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    fireEvent.click(screen.getByRole("button", { name: "remove" }));
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("已被序列任务引用"));
    expect(screen.getByTestId("count")).toHaveTextContent("1");
  });
});
