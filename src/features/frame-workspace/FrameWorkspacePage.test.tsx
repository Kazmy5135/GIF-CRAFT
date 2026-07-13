import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "../../core/sequenceGeneration";
import { FrameWorkspaceProvider } from "./FrameWorkspaceContext";
import { FrameWorkspacePage } from "./FrameWorkspacePage";
import {
  WorkspaceConflictError,
  type FrameWorkspaceAdapter,
  type WorkspaceCommand,
  type WorkspaceView,
} from "./workspaceAdapter";

function frame(index: number): Frame {
  return {
    id: `frame-${index}`,
    jobId: "job-1",
    providerIndex: index,
    sequenceIndex: index,
    resourceRef: `frame-resource:frame-${index}`,
    mimeType: "image/png",
    width: 64,
    height: 64,
    size: 1,
    readable: true,
    createdAt: "2026-07-12T00:00:00.000Z",
  };
}

function workspace(): WorkspaceView {
  return {
    id: "workspace-1",
    jobId: "job-1",
    sourceJobId: "job-1",
    sourceImageId: "source-1",
    revision: 0,
    persistedRevision: 0,
    presetName: "角色待机",
    frameRate: 8,
    sourceFrameRate: 8,
    playbackFrameRate: 8,
    loopMode: "loop",
    canvas: { width: 64, height: 64 },
    updatedAt: "2026-07-12T00:00:00.000Z",
    frames: [0, 1, 2].map((index) => ({
      id: `slot-${index}`,
      originalFrameId: `frame-${index}`,
      originalIndex: index,
      decision: "pending" as const,
      currentVersion: "original" as const,
      retryMode: "full_sequence_fallback" as const,
      frame: frame(index),
      blob: new Blob([String(index)], { type: "image/png" }),
    })),
  };
}

function applyCommand(current: WorkspaceView, command: WorkspaceCommand): WorkspaceView {
  if (command.type === "set_decision") return { ...current, revision: current.revision + 1, frames: current.frames.map((item) => item.id === command.frameId ? { ...item, decision: command.decision } : item) };
  if (command.type === "restore") return { ...current, revision: current.revision + 1, frames: current.frames.map((item) => item.id === command.frameId ? { ...item, decision: "pending" } : item) };
  if (command.type === "set_frame_rate") return { ...current, revision: current.revision + 1, frameRate: command.frameRate, playbackFrameRate: command.frameRate };
  const source = current.frames.find((item) => item.id === command.frameId);
  if (!source) return current;
  const frames = current.frames.filter((item) => item.id !== command.frameId);
  frames.splice(Math.max(0, Math.min(frames.length, command.targetIndex)), 0, source);
  return { ...current, revision: current.revision + 1, frames };
}

function adapter(initial = workspace()): FrameWorkspaceAdapter {
  let stored = initial;
  return {
    listEligibleJobs: vi.fn(async () => []),
    loadOrCreate: vi.fn(async () => structuredClone(stored)),
    apply: vi.fn(applyCommand),
    save: vi.fn(async (next) => {
      stored = { ...next, persistedRevision: next.revision };
      return stored;
    }),
    checkReadiness: vi.fn((current: WorkspaceView) => ({ ready: current.frames.filter((item) => item.decision !== "removed").every((item) => item.decision === "kept"), issues: current.frames.some((item) => item.decision === "pending") ? ["仍有待审核帧。"] : [] })),
    createSnapshot: vi.fn(async (current: WorkspaceView) => ({ id: "snapshot-1", frameCount: current.frames.filter((item) => item.decision !== "removed").length, createdAt: "2026-07-12T00:00:01.000Z" })),
    describeRetryCapability: () => "当前服务不支持原生单帧重试；可使用完整子任务降级并仅提取同一原始索引。",
    requestRetry: vi.fn(async (current: WorkspaceView) => current),
    acceptCandidate: vi.fn(async (current: WorkspaceView) => current),
    discardCandidate: vi.fn(async (current: WorkspaceView) => current),
    restoreOriginal: vi.fn(async (current: WorkspaceView) => current),
    abandonRetryTracking: vi.fn(async (current: WorkspaceView) => current),
  };
}

function renderPage(testAdapter = adapter(), autosaveDelayMs = 0) {
  return render(<MemoryRouter><FrameWorkspaceProvider adapter={testAdapter} jobId="job-1" onChooseJob={() => undefined} autosaveDelayMs={autosaveDelayMs}><FrameWorkspacePage /></FrameWorkspaceProvider></MemoryRouter>);
}

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${Math.random()}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => cleanup());

describe("FrameWorkspacePage", () => {
  it("审核、非破坏性移除与恢复会同步筛选和自动保存", async () => {
    const testAdapter = adapter();
    renderPage(testAdapter);
    await screen.findByText("角色待机 · 序列帧 ID job-1");

    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await waitFor(() => expect(testAdapter.save).toHaveBeenCalled());
    expect(screen.getByText("1 保留 · 2 待审核 · 0 移除")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(screen.getByText("确认非破坏性移除？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(screen.getByText("0 保留 · 2 待审核 · 1 移除")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("筛选"), { target: { value: "removed" } });
    expect(screen.getByText("已移除", { selector: ".frame-thumb-meta small:last-child" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复到原位置" }));
    expect(screen.getByText("当前筛选没有帧。")).toBeInTheDocument();
  });

  it("按钮和键盘排序调用同一 move 命令", async () => {
    const testAdapter = adapter();
    renderPage(testAdapter);
    await screen.findByText("角色待机 · 序列帧 ID job-1");
    fireEvent.click(screen.getByRole("button", { name: "向后移动" }));
    expect(testAdapter.apply).toHaveBeenCalledWith(expect.anything(), { type: "move", frameId: "slot-0", targetIndex: 1 });
    fireEvent.keyDown(within(screen.getByRole("listbox", { name: "工作区帧顺序" })).getByRole("option", { selected: true }), { key: "ArrowLeft", altKey: true });
    expect(testAdapter.apply).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: "move", targetIndex: 0 }));
  });

  it("全部审核并保存后才允许生成快照", async () => {
    const base = workspace();
    const ready: WorkspaceView = { ...base, frames: base.frames.map((item) => ({ ...item, decision: "kept" })) };
    const testAdapter = adapter(ready);
    renderPage(testAdapter);
    await screen.findByText("所有纳入帧均已保留且资源可读，可以生成不可变快照并导出。");
    fireEvent.click(screen.getByRole("button", { name: "生成工作区快照" }));
    expect(await screen.findByText("快照 snapshot-1 已生成，共 3 帧。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "导出 PNG ZIP" })).toHaveAttribute("href", "/export/snapshot-1");
  });

  it("非破坏性修改播放帧率并提供整序列重做入口", async () => {
    const testAdapter = adapter();
    renderPage(testAdapter);
    await screen.findByText("角色待机 · 序列帧 ID job-1");
    expect(screen.getByText(/原始生成任务保持 8 FPS/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("播放帧率"), { target: { value: "12" } });
    expect(testAdapter.apply).toHaveBeenCalledWith(expect.anything(), { type: "set_frame_rate", frameRate: 12 });
    expect(screen.getByRole("link", { name: "重做此序列" })).toHaveAttribute(
      "href",
      "/create?sourceId=source-1&redoOf=job-1",
    );
  });

  it("revision 冲突不会静默覆盖并提供显式重新加载", async () => {
    const testAdapter = adapter();
    vi.mocked(testAdapter.save).mockRejectedValueOnce(new WorkspaceConflictError());
    renderPage(testAdapter);
    await screen.findByText("角色待机 · 序列帧 ID job-1");
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(await screen.findByText("检测到多标签页冲突")).toBeInTheDocument();
    await act(async () => screen.getByRole("button", { name: /加载最新版本/ }).click());
    await waitFor(() => expect(testAdapter.loadOrCreate).toHaveBeenCalledTimes(2));
  });

  it("快速连续编辑按 revision 顺序排队保存", async () => {
    const testAdapter = adapter();
    renderPage(testAdapter, 20);
    await screen.findByText("角色待机 · 序列帧 ID job-1");
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    fireEvent.click(screen.getByRole("button", { name: "向后移动" }));
    await waitFor(() => expect(testAdapter.save).toHaveBeenCalledTimes(2));
    expect(vi.mocked(testAdapter.save).mock.calls.map((call) => call[1])).toEqual([0, 1]);
  });

  it("完整重生成成功后显示原版/候选对比并显式接受", async () => {
    const testAdapter = adapter();
    vi.mocked(testAdapter.requestRetry).mockImplementationOnce(async (current) => ({
      ...current,
      revision: current.revision + 1,
      persistedRevision: current.revision + 1,
      frames: current.frames.map((item, index) => index === 0 ? {
        ...item,
        retryStatus: "candidate_ready",
        candidate: {
          attemptId: "attempt-1",
          frame: { ...item.frame, id: "candidate-1", resourceRef: "workspace-frame-resource:candidate-1" },
          blob: new Blob(["candidate"], { type: "image/png" }),
        },
      } : item),
    }));
    vi.mocked(testAdapter.acceptCandidate).mockImplementationOnce(async (current) => ({
      ...current,
      frames: current.frames.map((item, index) => index === 0 ? { ...item, currentVersion: "candidate", retryStatus: "idle", candidate: undefined } : item),
    }));
    renderPage(testAdapter);
    await screen.findByText("角色待机 · 序列帧 ID job-1");
    fireEvent.click(screen.getByRole("button", { name: "完整重生成并提取此帧" }));
    expect(await screen.findByAltText("重试候选帧")).toBeInTheDocument();
    expect(screen.getByText(/不会自动替换/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "接受候选" }));
    await waitFor(() => expect(testAdapter.acceptCandidate).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "恢复原版" })).toBeEnabled();
  });

  it("支持放弃候选与恢复已采用帧的原版", async () => {
    const candidateBase = workspace();
    const candidateWorkspace: WorkspaceView = {
      ...candidateBase,
      frames: candidateBase.frames.map((item, index) => index === 0 ? {
        ...item,
        retryStatus: "candidate_ready",
        candidate: {
          attemptId: "attempt-1",
          frame: { ...item.frame, id: "candidate-1", resourceRef: "workspace-frame-resource:candidate-1" },
          blob: new Blob(["candidate"], { type: "image/png" }),
        },
      } : item),
    };
    const discardAdapter = adapter(candidateWorkspace);
    renderPage(discardAdapter);
    await screen.findByAltText("重试候选帧");
    fireEvent.click(screen.getByRole("button", { name: "放弃候选" }));
    await waitFor(() => expect(discardAdapter.discardCandidate).toHaveBeenCalledTimes(1));
    cleanup();

    const acceptedBase = workspace();
    const acceptedWorkspace: WorkspaceView = { ...acceptedBase, frames: acceptedBase.frames.map((item, index) => index === 0 ? { ...item, currentVersion: "candidate" } : item) };
    const restoreAdapter = adapter(acceptedWorkspace);
    renderPage(restoreAdapter);
    await screen.findByRole("button", { name: "恢复原版" });
    fireEvent.click(screen.getByRole("button", { name: "恢复原版" }));
    await waitFor(() => expect(restoreAdapter.restoreOriginal).toHaveBeenCalledTimes(1));
  });

  it("显示失败/未知状态，未知再次操作走同一对账入口", async () => {
    const unknownBase = workspace();
    const unknown: WorkspaceView = { ...unknownBase, frames: unknownBase.frames.map((item, index) => index === 0 ? { ...item, retryStatus: "status_unknown", retryCanReconcile: true, retryCanAbandon: true } : item) };
    const testAdapter = adapter(unknown);
    renderPage(testAdapter);
    expect(await screen.findByText("重试状态未知")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查询 / 对账" }));
    await waitFor(() => expect(testAdapter.requestRetry).toHaveBeenCalledTimes(1));
    cleanup();

    const failedBase = workspace();
    const failed: WorkspaceView = { ...failedBase, frames: failedBase.frames.map((item, index) => index === 0 ? { ...item, retryStatus: "failed", retryError: "配额不足" } : item) };
    renderPage(adapter(failed));
    expect(await screen.findByText("配额不足")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新发起重试" })).toBeEnabled();
  });

  it("重复点击只启动一个重试操作", async () => {
    const testAdapter = adapter();
    let resolveRetry!: (value: WorkspaceView) => void;
    vi.mocked(testAdapter.requestRetry).mockImplementationOnce((current) => new Promise((resolve) => {
      resolveRetry = resolve;
    }));
    renderPage(testAdapter);
    await screen.findByText("角色待机 · 序列帧 ID job-1");
    const retryButton = screen.getByRole("button", { name: "完整重生成并提取此帧" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(testAdapter.requestRetry).toHaveBeenCalledTimes(1);
    await act(async () => resolveRetry(workspace()));
  });

  it("自动保存单飞 drain：保存中编辑不会并发保存同一队首", async () => {
    const testAdapter = adapter();
    let resolveFirst!: (value: WorkspaceView) => void;
    vi.mocked(testAdapter.save)
      .mockImplementationOnce((current) => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async (current) => ({ ...current, persistedRevision: current.revision }));
    renderPage(testAdapter, 0);
    await screen.findByText("角色待机 · 序列帧 ID job-1");
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await waitFor(() => expect(testAdapter.save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "向后移动" }));
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(testAdapter.save).toHaveBeenCalledTimes(1);
    const firstInput = vi.mocked(testAdapter.save).mock.calls[0][0];
    await act(async () => resolveFirst({ ...firstInput, persistedRevision: firstInput.revision }));
    await waitFor(() => expect(testAdapter.save).toHaveBeenCalledTimes(2));
    expect(vi.mocked(testAdapter.save).mock.calls.map((call) => call[1])).toEqual([0, 1]);
  });

  it("pagehide 会尽力立即 flush 尚未到防抖时间的保存", async () => {
    const testAdapter = adapter();
    renderPage(testAdapter, 60_000);
    await screen.findByText("角色待机 · 序列帧 ID job-1");
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(testAdapter.save).toHaveBeenCalledTimes(1));
  });

  it("重试动作 revision 冲突进入强制 reload 状态", async () => {
    const testAdapter = adapter();
    const conflict = Object.assign(new Error("conflict"), { name: "FrameWorkspaceRevisionConflictError" });
    vi.mocked(testAdapter.requestRetry).mockRejectedValueOnce(conflict);
    renderPage(testAdapter);
    await screen.findByText("角色待机 · 序列帧 ID job-1");
    fireEvent.click(screen.getByRole("button", { name: "完整重生成并提取此帧" }));
    expect(await screen.findByText("检测到多标签页冲突")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /加载最新版本/ })).toBeEnabled();
  });

  it("浏览器真实 img 解码失败时切换为坏图状态", async () => {
    renderPage(adapter());
    const image = await screen.findByAltText("当前帧，原始索引 0");
    fireEvent.error(image);
    expect(await screen.findByText("当前帧资源损坏或无法解码")).toBeInTheDocument();
  });

  it("未知且无 childJobId 时只允许放弃跟踪，冲突后强制 reload", async () => {
    const base = workspace();
    const unknown: WorkspaceView = { ...base, frames: base.frames.map((item, index) => index === 0 ? { ...item, retryStatus: "status_unknown", retryCanReconcile: false, retryCanAbandon: true } : item) };
    const testAdapter = adapter(unknown);
    const conflict = Object.assign(new Error("conflict"), { name: "FrameWorkspaceRevisionConflictError" });
    vi.mocked(testAdapter.abandonRetryTracking).mockRejectedValueOnce(conflict);
    renderPage(testAdapter);
    await screen.findByText("重试状态未知");
    expect(screen.queryByRole("button", { name: "查询 / 对账" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放弃跟踪" }));
    expect(await screen.findByText("检测到多标签页冲突")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /加载最新版本/ })).toBeEnabled();
  });

  it("刷新后的 running+childId 显示可用查询/对账并复用 requestRetry", async () => {
    const base = workspace();
    const running: WorkspaceView = { ...base, frames: base.frames.map((item, index) => index === 0 ? { ...item, retryStatus: "running", retryCanReconcile: true, retryCanAbandon: true } : item) };
    const testAdapter = adapter(running);
    renderPage(testAdapter);
    await screen.findByText(/正在完整重生成序列/);
    const reconcile = screen.getByRole("button", { name: "查询 / 对账" });
    expect(reconcile).toBeEnabled();
    fireEvent.click(reconcile);
    await waitFor(() => expect(testAdapter.requestRetry).toHaveBeenCalledTimes(1));
  });
});
