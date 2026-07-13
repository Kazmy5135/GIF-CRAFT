import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SequenceProviderCapabilitySummary } from "../../infrastructure/api/sequenceApi";
import type { Frame, GenerationJob } from "../../core/sequenceGeneration";
import type { SourceImageAsset } from "../../core/sourceImage";
import {
  SourceImageContext,
  type SourceImageContextValue,
} from "../source-image/SourceImageContext";
import * as imageFile from "../source-image/imageFile";
import {
  SequenceContext,
  type SequenceContextValue,
} from "./SequenceContext";
import { SequencePage } from "./SequencePage";

function sourceAsset(overrides: Partial<SourceImageAsset> = {}): SourceImageAsset {
  return {
    id: "source-1",
    jobId: "source-job-1",
    provider: "local",
    model: "local-upload",
    mode: "local_upload",
    createdAt: "2026-07-11T10:00:00.000Z",
    confirmedAt: "2026-07-11T10:01:00.000Z",
    contentSnapshotId: `sha256:${"a".repeat(64)}`,
    dataUrl: "data:image/png;base64,AA==",
    mimeType: "image/png",
    width: 512,
    height: 512,
    size: 1,
    availability: "available",
    sourceName: "hero.png",
    promptSnapshot: {
      userPrompt: "",
      basePrompt: "",
      negativePrompt: "",
      compiledPrompt: "",
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

const sequenceProvider: SequenceProviderCapabilitySummary = {
  provider: "gorilla_seedance",
  configured: true,
  model: "bytedance/doubao-seedance-2-0-fast",
  supportsImageToSequence: true,
  supportsAsyncQuery: false,
  supportsLocalJobQuery: true,
  proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  supportsCancellation: false,
  supportsRandomSeed: false,
  supportsRealProgress: false,
  frameRetryMode: "full_sequence_fallback",
  inputMimeTypes: ["image/png"],
  frameCounts: [8, 12],
  frameRates: [8, 12],
  aspectRatios: ["1:1"],
  providerDurationSeconds: [4],
  providerResolutions: ["480p"],
  outputMimeTypes: ["video/mp4"],
  outputShape: "video" as const,
  canNormalizeLosslessly: false,
};

function sourceContext(overrides: Partial<SourceImageContextValue> = {}): SourceImageContextValue {
  const source = sourceAsset();
  return {
    providers: [],
    providersLoading: false,
    refreshProviders: vi.fn(),
    history: [source],
    historyLoading: false,
    currentSourceId: source.id,
    currentSource: source,
    taskStatus: "idle",
    taskError: "",
    promptSettings: { basePrompt: "", negativePrompt: "", version: 1 },
    updatePromptSettings: vi.fn(),
    resetPromptSettings: vi.fn(),
    generate: vi.fn(),
    addLocalImage: vi.fn(),
    confirmSource: vi.fn(),
    removeSourceImage: vi.fn(),
    clearTaskError: vi.fn(),
    ...overrides,
  };
}

function sequenceContext(overrides: Partial<SequenceContextValue> = {}): SequenceContextValue {
  return {
    providers: [sequenceProvider],
    providersLoading: false,
    jobsLoading: false,
    currentJob: null,
    frames: [],
    resultStorageStatus: null,
    submitting: false,
    reconciling: false,
    error: "",
    refreshProviders: vi.fn(),
    submit: vi.fn(),
    retryFailed: vi.fn(),
    reconcile: vi.fn(),
    abandonTracking: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  };
}

function renderPage(
  sourceValue = sourceContext(),
  sequenceValue = sequenceContext(),
) {
  return render(
    <MemoryRouter initialEntries={["/sequence"]}>
      <SourceImageContext.Provider value={sourceValue}>
        <SequenceContext.Provider value={sequenceValue}>
          <SequencePage />
        </SequenceContext.Provider>
      </SourceImageContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(imageFile, "getImageDimensions").mockResolvedValue({ width: 512, height: 512 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SequencePage", () => {
  it.each([
    [sourceContext({ historyLoading: true }), "正在读取已确认源图"],
    [sourceContext({ currentSourceId: "missing", currentSource: null }), "当前源图记录已丢失"],
    [sourceContext({ currentSource: sourceAsset({ confirmedAt: undefined }) }), "需要重新确认"],
    [sourceContext({ currentSource: sourceAsset({ availability: "unavailable" }) }), "当前不可读取"],
  ])("distinguishes source guard state %#", (sourceValue, expectedText) => {
    renderPage(sourceValue);
    expect(screen.getAllByText(new RegExp(expectedText)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "开始生成" })).toBeDisabled();
  });

  it("loads all four approved presets and requires other loop choice", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("请填写动作或场景运动描述。")).toBeInTheDocument());

    expect(screen.getByLabelText("帧数")).toHaveValue("8");
    expect(screen.getByLabelText("帧率")).toHaveValue("8");
    expect(screen.getByLabelText("循环方式")).toHaveValue("循环");

    fireEvent.change(screen.getByLabelText("动作预设"), { target: { value: "attack" } });
    expect(screen.getByLabelText("帧数")).toHaveValue("8");
    expect(screen.getByLabelText("帧率")).toHaveValue("12");
    expect(screen.getByLabelText("循环方式")).toHaveValue("单次");

    fireEvent.change(screen.getByPlaceholderText(/轻微呼吸/), { target: { value: "jump" } });
    fireEvent.change(screen.getByLabelText("动作预设"), { target: { value: "other" } });
    expect(screen.getByLabelText("帧数")).toHaveValue("12");
    expect(screen.getByLabelText("帧率")).toHaveValue("12");
    expect(screen.getByLabelText("循环方式")).toHaveValue("");
    expect(screen.getByText("请选择循环或单次播放。")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("资产类型"), { target: { value: "scene" } });
    expect(screen.queryByLabelText("动作预设")).not.toBeInTheDocument();
    expect(screen.getByLabelText("帧数")).toHaveValue("12");
    expect(screen.getByLabelText("帧率")).toHaveValue("8");
    expect(screen.getByLabelText("循环方式")).toHaveValue("循环");
  });

  it("shows mapping and privacy notice before submitting exactly on explicit action", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    renderPage(sourceContext(), sequenceContext({ submit }));
    await waitFor(() => expect(screen.getByText(/canvas.width/)).toBeInTheDocument());
    expect(screen.getAllByText(/512 → 480/)).toHaveLength(2);
    expect(screen.getByText(/只有点击“开始生成”后/)).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/轻微呼吸/), {
      target: { value: "subtle breathing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const [request, sourceData] = submit.mock.calls[0];
    expect(sourceData).toBe("data:image/png;base64,AA==");
    expect(request.parameterMappings.map((item: { field: string }) => item.field)).toEqual([
      "canvas.width",
      "canvas.height",
    ]);
  });

  it("does not expose a fake cancellation action", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/源图外发提示/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /取消/ })).not.toBeInTheDocument();
  });

  it("blocks a new submission while another task is active", async () => {
    const submit = vi.fn();
    renderPage(
      sourceContext(),
      sequenceContext({ currentJob: jobWithStatus("generating"), submit }),
    );
    await waitFor(() => expect(screen.getByText("已有任务正在处理，请等待任务结束。")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "开始生成" })).toBeDisabled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("offers only reconciliation for status_unknown", async () => {
    const reconcile = vi.fn();
    const abandonTracking = vi.fn();
    renderPage(
      sourceContext(),
      sequenceContext({ currentJob: jobWithStatus("status_unknown"), reconcile, abandonTracking }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "查询 / 对账" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /重试/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查询 / 对账" }));
    expect(reconcile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "放弃跟踪" }));
    expect(abandonTracking).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh draft id after a completed task instead of overwriting history", async () => {
    const ids = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
    ];
    vi.stubGlobal("crypto", { ...crypto, randomUUID: vi.fn(() => ids.shift()!) });
    const submit = vi.fn().mockResolvedValue(undefined);
    renderPage(
      sourceContext(),
      sequenceContext({ currentJob: jobWithStatus("completed"), submit }),
    );
    fireEvent.change(screen.getByPlaceholderText(/轻微呼吸/), { target: { value: "idle" } });
    const button = screen.getByRole("button", { name: "开始生成" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    const first = submit.mock.calls[0][0];
    const second = submit.mock.calls[1][0];
    expect(second.draftId).not.toBe(first.draftId);
    expect(second.clientRequestId).not.toBe(first.clientRequestId);
  });

  it("shows frame handoff only for a complete persisted result", async () => {
    const frame = { id: "frame-0" } as Frame;
    const { rerender } = renderPage(
      sourceContext(),
      sequenceContext({ currentJob: jobWithStatus("processing"), frames: [frame], resultStorageStatus: "available" }),
    );
    await waitFor(() => expect(screen.queryByRole("link", { name: "进入序列帧工作区" })).not.toBeInTheDocument());

    rerender(
      <MemoryRouter initialEntries={["/sequence"]}>
        <SourceImageContext.Provider value={sourceContext()}>
          <SequenceContext.Provider value={sequenceContext({ currentJob: jobWithStatus("completed"), frames: [frame], resultStorageStatus: "available" })}>
            <SequencePage />
          </SequenceContext.Provider>
        </SourceImageContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "进入序列帧工作区" })).toHaveAttribute(
      "href",
      "/workspace/job-1",
    );
  });

  it("records a full-sequence redo without reusing the original sequence id", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryRouter initialEntries={["/create/sequence?redoOf=job-original"]}>
        <SourceImageContext.Provider value={sourceContext()}>
          <SequenceContext.Provider value={sequenceContext({ submit })}>
            <SequencePage />
          </SequenceContext.Provider>
        </SourceImageContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText("正在重做序列 job-original")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/轻微呼吸/), { target: { value: "redo idle" } });
    const button = screen.getByRole("button", { name: "开始生成" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][2]).toEqual({ redoOfJobId: "job-original" });
  });

  it("normalizes a historical completed record whose persisted stage is stale", () => {
    const historical = { ...jobWithStatus("completed"), stage: "provider_generation" };
    renderPage(
      sourceContext(),
      sequenceContext({ currentJob: historical, frames: [], resultStorageStatus: "purged" }),
    );
    const stageRow = screen.getByText("阶段").parentElement;
    expect(stageRow?.querySelector("dd")).toHaveTextContent("completed");
    expect(stageRow?.querySelector("dd")).not.toHaveTextContent("provider_generation");
  });

  it("does not hand off a completed result whose local frames were purged", async () => {
    renderPage(
      sourceContext(),
      sequenceContext({
        currentJob: jobWithStatus("completed"),
        frames: [],
        resultStorageStatus: "purged",
      }),
    );
    expect(await screen.findByText("本地结果已清理")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "进入序列帧工作区" })).not.toBeInTheDocument();
  });
});

function jobWithStatus(status: GenerationJob["status"]): GenerationJob {
  const completed = status === "completed";
  return {
    id: "job-1",
    clientRequestId: "request-1",
    provider: "gorilla_seedance",
    request: {
      draftId: "draft-1",
      clientRequestId: "request-1",
      provider: "gorilla_seedance",
      source: {
        id: "source-1",
        confirmedAt: "2026-07-11T10:01:00.000Z",
        contentSnapshotId: `sha256:${"a".repeat(64)}`,
        resourceRef: "source-image:source-1",
        mimeType: "image/png",
        width: 512,
        height: 512,
        size: 1,
      },
      presetId: "character.idle.v1",
      presetVersion: 1,
      promptSnapshot: { layerRefs: [], userDescription: "idle", compiledText: "idle" },
      requestedParameters: {
        frameCount: 8,
        frameRate: 8,
        loopMode: "loop",
        canvas: { mode: "source", aspectRatio: "1:1", width: 512, height: 512 },
        anchor: "bottom_center_feet_baseline",
        randomSeed: null,
      },
      effectiveParameters: {
        frameCount: 8,
        frameRate: 8,
        loopMode: "loop",
        canvas: { mode: "source", aspectRatio: "1:1", width: 480, height: 480 },
        anchor: "bottom_center_feet_baseline",
        randomSeed: null,
      },
      parameterMappings: [],
      providerExtensions: { proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    },
    status,
    progress: null,
    stage: status,
    timestamps: { createdAt: "2026-07-11T10:02:00.000Z", updatedAt: "2026-07-11T10:03:00.000Z" },
    retryCount: 0,
    frameIds: completed ? ["frame-0"] : [],
    resultIntegrity: {
      status: completed ? "complete" : "pending",
      expectedFrameCount: completed ? 1 : 8,
      actualFrameCount: completed ? 1 : 0,
      issues: [],
    },
  };
}
