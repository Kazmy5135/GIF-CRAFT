import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCapabilities,
  SourceImageAsset,
} from "../../core/sourceImage";
import { ImagePage } from "./ImagePage";
import {
  SourceImageContext,
  type SourceImageContextValue,
} from "./SourceImageContext";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const provider: ProviderCapabilities = {
  id: "mcp_banana",
  name: "Gorilla Banana",
  configured: true,
  model: "banana-model",
  supportsTextToImage: true,
  supportsImageToImage: true,
  supportsMultipleImages: true,
  supportsTransparentBackground: false,
  supportsCancellation: false,
  aspectRatios: ["1:1", "16:9"],
  qualityLevels: ["draft", "standard", "high"],
};

function asset(id: string, createdAt: string, overrides: Partial<SourceImageAsset> = {}): SourceImageAsset {
  return {
    id,
    jobId: `job-${id}`,
    provider: "mcp_banana",
    model: `model-${id}`,
    mode: "text_to_image",
    createdAt,
    dataUrl: `data:image/png;base64,${id === "latest" ? "bmV3" : "b2xk"}`,
    mimeType: "image/png",
    width: 512,
    height: 512,
    size: 3,
    availability: "unknown",
    promptSnapshot: {
      userPrompt: `prompt-${id}`,
      basePrompt: "base",
      negativePrompt: "negative",
      compiledPrompt: `compiled-${id}`,
      templateVersion: 1,
    },
    effectiveParameters: {
      aspectRatio: "1:1",
      quality: "standard",
      providerSize: "512x512",
    },
    ...overrides,
  };
}

function contextValue(
  history: SourceImageAsset[],
  overrides: Partial<SourceImageContextValue> = {},
): SourceImageContextValue {
  const currentSourceId = overrides.currentSourceId ?? null;
  return {
    providers: [provider],
    providersLoading: false,
    refreshProviders: vi.fn().mockResolvedValue(undefined),
    history,
    historyLoading: false,
    currentSourceId,
    currentSource: history.find((item) => item.id === currentSourceId) ?? null,
    taskStatus: "idle",
    taskError: "",
    promptSettings: { basePrompt: "base", negativePrompt: "negative", version: 1 },
    updatePromptSettings: vi.fn(),
    resetPromptSettings: vi.fn(),
    generate: vi.fn().mockResolvedValue(undefined),
    addLocalImage: vi.fn().mockResolvedValue(undefined),
    confirmSource: vi.fn().mockResolvedValue(undefined),
    removeSourceImage: vi.fn().mockResolvedValue(undefined),
    clearTaskError: vi.fn(),
    ...overrides,
  };
}

function tree(value: SourceImageContextValue, entry = "/create") {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <SourceImageContext.Provider value={value}>
        <Routes>
          <Route path="/create" element={<ImagePage />} />
          <Route path="/create/sequence" element={<h1>序列生成目标页</h1>} />
        </Routes>
      </SourceImageContext.Provider>
    </MemoryRouter>
  );
}

describe("ImagePage preview workspace", () => {
  it("renders the preview on the left, keeps the parameter form, and submits the original fields", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "request-1" });
    const latest = asset("latest", "2026-07-14T09:00:00.000Z");
    const older = asset("older", "2026-07-13T09:00:00.000Z");
    const value = contextValue([latest, older]);
    const view = render(tree(value));

    const workspace = view.container.querySelector(".source-image-workspace");
    expect(workspace?.querySelector(".source-image-preview-panel")).toBeInTheDocument();
    expect(workspace?.querySelector(".source-image-parameters")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "当前预览：model-latest" })).toHaveAttribute(
      "src",
      latest.dataUrl,
    );
    expect(screen.getByRole("radio", { name: /文生图/ })).toBeChecked();
    expect(screen.getByLabelText("API 服务商")).toBeInTheDocument();
    expect(screen.getByLabelText("宽高比")).toBeInTheDocument();
    expect(screen.getByLabelText("质量")).toBeInTheDocument();
    expect(screen.getByLabelText("候选数量")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("图片描述"), { target: { value: "new hero" } });
    fireEvent.click(screen.getByRole("button", { name: "生成图片" }));

    await waitFor(() => expect(value.generate).toHaveBeenCalledTimes(1));
    expect(value.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "mcp_banana",
        mode: "text_to_image",
        userPrompt: "new hero",
        aspectRatio: "1:1",
        quality: "standard",
        count: 1,
        clientRequestId: "request-1",
      }),
    );
  });

  it("prioritizes the requested source, switches by thumbnail, and targets actions at the previewed asset", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const latest = asset("latest", "2026-07-14T09:00:00.000Z");
    const requested = asset("older", "2026-07-13T09:00:00.000Z", {
      confirmedAt: "2026-07-13T09:01:00.000Z",
      contentSnapshotId: `sha256:${"a".repeat(64)}`,
      availability: "available",
    });
    const value = contextValue([latest, requested], { currentSourceId: requested.id });
    render(tree(value, "/create?sourceId=older&redoOf=sequence-old"));

    expect(screen.getByRole("img", { name: "当前预览：model-older" })).toHaveAttribute(
      "src",
      requested.dataUrl,
    );
    expect(screen.getByText("重做指定图")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /预览图片：model-latest/ }));
    expect(screen.getByRole("img", { name: "当前预览：model-latest" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载" })).toHaveAttribute(
      "download",
      "gif-craft-latest.png",
    );

    fireEvent.click(screen.getByRole("button", { name: "复用参数" }));
    expect(screen.getByLabelText("图片描述")).toHaveValue("prompt-latest");
    fireEvent.click(screen.getByRole("button", { name: "删除记录" }));
    expect(value.removeSourceImage).toHaveBeenCalledWith("latest");

    fireEvent.click(screen.getByRole("button", { name: "确认并进入序列生成" }));
    await waitFor(() => expect(value.confirmSource).toHaveBeenCalledWith("latest"));
    expect(await screen.findByRole("heading", { name: "序列生成目标页" })).toBeInTheDocument();
  });

  it("selects a newly prepended result and falls back when the selected history item is removed", async () => {
    const older = asset("older", "2026-07-13T09:00:00.000Z");
    const firstValue = contextValue([older]);
    const view = render(tree(firstValue));
    expect(screen.getByRole("img", { name: "当前预览：model-older" })).toBeInTheDocument();

    const latest = asset("latest", "2026-07-14T09:00:00.000Z");
    view.rerender(tree(contextValue([latest, older])));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "当前预览：model-latest" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /预览图片：model-older/ }));
    expect(screen.getByRole("img", { name: "当前预览：model-older" })).toBeInTheDocument();
    view.rerender(tree(contextValue([latest])));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "当前预览：model-latest" })).toBeInTheDocument(),
    );
  });

  it("maps vertical wheel input to the thumbnail strip and synchronizes the bottom slider", async () => {
    const history = Array.from({ length: 6 }, (_, index) =>
      asset(index === 0 ? "latest" : `older-${index}`, `2026-07-${String(14 - index).padStart(2, "0")}T09:00:00.000Z`),
    );
    const view = render(tree(contextValue(history)));
    const strip = screen.getByRole("list", { name: "当前结果与历史缩略图" });
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 240 },
      scrollWidth: { configurable: true, value: 720 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    fireEvent(window, new Event("resize"));

    const frame = view.container.querySelector(".source-image-history-frame");
    const slider = screen.getByRole("slider", { name: "历史图片横向滚动位置" });
    await waitFor(() => expect(slider).toHaveAttribute("max", "480"));
    expect(screen.queryByRole("button", { name: "向左浏览历史图片" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "向右浏览历史图片" })).not.toBeInTheDocument();

    const pageScrollCanceled = fireEvent.wheel(frame as HTMLElement, { deltaY: 120 });
    expect(pageScrollCanceled).toBe(false);
    expect(strip.scrollLeft).toBe(120);
    expect(slider).toHaveValue("120");

    fireEvent.change(slider, { target: { value: "300" } });
    expect(strip.scrollLeft).toBe(300);
    expect(slider).toHaveValue("300");
  });

  it("adds a new-image thumbnail after history and focuses the parameter panel", () => {
    const latest = asset("latest", "2026-07-14T09:00:00.000Z");
    const view = render(tree(contextValue([latest])));
    const items = screen.getAllByRole("listitem");
    const newImage = screen.getByRole("button", { name: "新建图片" });
    const panel = view.container.querySelector(".source-image-parameters") as HTMLFormElement;
    const scrollIntoView = vi.fn();
    Object.defineProperty(panel, "scrollIntoView", { configurable: true, value: scrollIntoView });

    expect(items.at(-1)).toContainElement(newImage);
    fireEvent.click(newImage);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(screen.getByRole("radio", { name: /文生图/ })).toHaveFocus();
  });

  it("zooms with Ctrl plus wheel, pans with the middle button, and resets the preview", async () => {
    const latest = asset("latest", "2026-07-14T09:00:00.000Z");
    const older = asset("older", "2026-07-13T09:00:00.000Z");
    const view = render(tree(contextValue([latest, older])));
    const stage = view.container.querySelector(".source-image-preview-stage");
    const preview = stage?.querySelector("img");
    const reset = view.container.querySelector(".source-image-preview-reset");

    expect(stage).toBeInstanceOf(HTMLElement);
    expect(preview).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1)",
    });
    expect(reset).toHaveAttribute("title", "恢复完整适配和初始位置");

    const regularWheelAllowed = fireEvent.wheel(stage as HTMLElement, { deltaY: -100 });
    expect(regularWheelAllowed).toBe(true);
    expect(preview).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1)",
    });

    const previewZoomCanceled = fireEvent.wheel(stage as HTMLElement, {
      ctrlKey: true,
      deltaY: -100,
      clientX: 0,
      clientY: 0,
    });
    expect(previewZoomCanceled).toBe(false);
    expect(preview?.style.transform).toContain("scale(1.1)");
    expect(view.container.querySelector(".source-image-preview-controls > span")).toHaveTextContent("110%");

    fireEvent.click(reset as HTMLElement);
    expect(preview).toHaveStyle({
      transform: "translate3d(0px, 0px, 0) scale(1)",
    });

    fireEvent.pointerDown(stage as HTMLElement, {
      button: 1,
      pointerId: 7,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(stage as HTMLElement, {
      buttons: 4,
      pointerId: 7,
      clientX: 140,
      clientY: 130,
    });
    expect(preview).toHaveStyle({
      transform: "translate3d(40px, 30px, 0) scale(1)",
    });
    expect(stage).toHaveClass("dragging");
    fireEvent.pointerUp(stage as HTMLElement, { pointerId: 7 });
    expect(stage).not.toHaveClass("dragging");

    const thumbnails = view.container.querySelectorAll(".source-image-history-thumb");
    fireEvent.click(thumbnails[1]);
    await waitFor(() =>
      expect(stage?.querySelector("img")).toHaveStyle({
        transform: "translate3d(0px, 0px, 0) scale(1)",
      }),
    );
  });

  it("shows distinct loading and empty preview states", () => {
    const view = render(tree(contextValue([], { historyLoading: true })));
    expect(screen.getByText("正在读取图片记录…")).toBeInTheDocument();

    view.rerender(tree(contextValue([])));
    expect(screen.getByText("还没有图片结果。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建图片" })).toBeInTheDocument();
  });
});
