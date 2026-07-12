import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ObjectUrlPool } from "./objectUrlPool";
import { useFrameWorkspace } from "./FrameWorkspaceContext";
import { usePreviewPlayback } from "./usePreviewPlayback";
import type { WorkspaceFrameView } from "./workspaceAdapter";

const decisionLabels = { pending: "待审核", kept: "已保留", removed: "已移除" } as const;
const saveLabels = { idle: "等待加载", dirty: "有未保存修改", saving: "正在保存…", saved: "已保存", conflict: "保存冲突", failed: "保存失败" } as const;
const noFrames: readonly WorkspaceFrameView[] = [];

function useFrameObjectUrls(workspaceId: string | undefined, frames: readonly WorkspaceFrameView[]) {
  const pool = useMemo(() => new ObjectUrlPool(24), []);
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const frame of frames) {
      if (frame.blob) next[frame.id] = pool.acquire(frame.id, frame.blob);
      if (frame.candidate?.blob) next[`${frame.id}:candidate`] = pool.acquire(`${frame.id}:candidate`, frame.candidate.blob);
    }
    setUrls(next);
  }, [frames, pool]);

  useEffect(() => () => pool.clear(), [pool, workspaceId]);
  return urls;
}

function JobSelector() {
  const { jobs, chooseJob } = useFrameWorkspace();
  return (
    <main className="page-content">
      <header className="page-header"><h1>序列帧工作区</h1><p>选择一个已完成且本地帧资源可读的任务。</p></header>
      <section className="panel frame-job-picker">
        <h2>可用生成任务</h2>
        {jobs.length === 0 ? (
          <div className="empty-state"><p>当前没有可进入工作区的完整任务。</p><Link className="button primary" to="/sequence">去生成序列帧</Link></div>
        ) : jobs.map((job) => (
          <button className="frame-job-option" key={job.id} type="button" onClick={() => chooseJob(job.id)}>
            <span><strong>{job.presetName}</strong><small>{job.id}</small></span>
            <span>{job.frameCount} 帧 · {job.frameRate} FPS · {job.loopMode === "loop" ? "循环" : "单次"}</span>
            <time>{new Date(job.createdAt).toLocaleString()}</time>
          </button>
        ))}
      </section>
    </main>
  );
}

function WorkspaceError({ message }: { message: string }) {
  return (
    <main className="page-content">
      <header className="page-header"><h1>无法打开序列帧工作区</h1><p>当前入口未通过完整性与本地资源检查。</p></header>
      <section className="panel"><div className="alert error" role="alert"><strong>工作区不可用</strong><p>{message}</p></div><div className="button-row frame-recovery-actions"><Link className="button" to="/frames">选择其他任务</Link><Link className="button primary" to="/sequence">返回生成页</Link></div></section>
    </main>
  );
}

export function FrameWorkspacePage() {
  const model = useFrameWorkspace();
  const [removeConfirmation, setRemoveConfirmation] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());
  const detailsRef = useRef<HTMLElement>(null);
  const urls = useFrameObjectUrls(model.workspace?.id, model.workspace?.frames ?? noFrames);
  const activeIds = model.activeFrames.map((frame) => frame.id);
  const playback = usePreviewPlayback({
    frameIds: activeIds,
    frameRate: model.workspace?.frameRate ?? 8,
    loopMode: model.workspace?.loopMode ?? "loop",
    selectedId: model.selectedId,
    onSelect: model.selectFrame,
  });

  useEffect(() => setBrokenImages(new Set()), [model.workspace?.id]);

  function markImageBroken(id: string) {
    setBrokenImages((current) => new Set(current).add(id));
  }

  useEffect(() => {
    if (model.selectedFrame?.decision === "removed" && playback.playing) playback.pause();
  }, [model.selectedFrame?.decision, playback]);

  if (model.loadState === "loading") return <main className="page-content"><div className="panel empty-state" role="status">正在校验任务和本地帧资源…</div></main>;
  if (model.loadState === "select_job") return <JobSelector />;
  if (model.loadState === "error" || !model.workspace) return <WorkspaceError message={model.loadError || "工作区数据缺失。"} />;

  const { workspace, selectedFrame } = model;
  const selectedActiveIndex = selectedFrame ? model.activeFrames.findIndex((frame) => frame.id === selectedFrame.id) : -1;
  const selectedWorkspaceIndex = selectedFrame ? workspace.frames.findIndex((frame) => frame.id === selectedFrame.id) : -1;
  const selectedUrl = selectedFrame ? urls[selectedFrame.id] : undefined;
  const candidateUrl = selectedFrame ? urls[`${selectedFrame.id}:candidate`] : undefined;
  const counts = workspace.frames.reduce((result, frame) => ({ ...result, [frame.decision]: result[frame.decision] + 1 }), { pending: 0, kept: 0, removed: 0 });

  function onDrop(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const targetIndex = workspace.frames.findIndex((frame) => frame.id === targetId);
    model.move(draggedId, targetIndex);
    model.selectFrame(draggedId);
    setDraggedId(null);
  }

  function onFrameKeyDown(event: React.KeyboardEvent, frame: WorkspaceFrameView) {
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const index = workspace.frames.findIndex((item) => item.id === frame.id);
      model.move(frame.id, index + (event.key === "ArrowLeft" ? -1 : 1));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      model.selectFrame(frame.id);
      detailsRef.current?.focus();
    }
  }

  return (
    <main className="page-content frame-workspace-page">
      <header className="page-header frame-workspace-header">
        <div><h1>序列帧工作区</h1><p>{workspace.presetName} · 任务 {workspace.jobId}</p></div>
        <span className={`save-indicator ${model.saveState}`} role="status">{saveLabels[model.saveState]} · r{workspace.revision}</span>
      </header>

      {model.saveState === "conflict" && <div className="alert warning frame-alert"><strong>检测到多标签页冲突</strong><p>{model.saveError}</p><button className="button" type="button" onClick={() => void model.reloadLatest()}>放弃本页未保存动作并加载最新版本</button></div>}
      {model.saveState === "failed" && <div className="alert error frame-alert" role="alert"><span>{model.saveError}</span><button className="button" type="button" onClick={model.retrySave}>重试保存</button></div>}

      <section className="panel frame-workspace-summary" aria-label="工作区摘要">
        <dl className="parameter-summary">
          <div><dt>纳入帧</dt><dd>{model.activeFrames.length} / {workspace.frames.length}</dd></div>
          <div><dt>播放</dt><dd>{workspace.frameRate} FPS · {workspace.loopMode === "loop" ? "循环" : "单次"}</dd></div>
          <div><dt>画布</dt><dd>{workspace.canvas.width} × {workspace.canvas.height}</dd></div>
          <div><dt>审核</dt><dd>{counts.kept} 保留 · {counts.pending} 待审核 · {counts.removed} 移除</dd></div>
        </dl>
      </section>

      <div className="frame-editor-grid">
        <section className="panel frame-preview-panel" aria-label="连续预览">
          <div className="section-heading"><div><h2>连续预览</h2><p>只播放当前纳入的帧，排序和移除会立即同步。</p></div>{selectedActiveIndex >= 0 && <span className="badge">{selectedActiveIndex + 1} / {model.activeFrames.length}</span>}</div>
          <div className="frame-main-preview" style={{ aspectRatio: `${workspace.canvas.width} / ${workspace.canvas.height}` }}>
            {selectedFrame && selectedUrl && !brokenImages.has(selectedFrame.id) ? <img src={selectedUrl} alt={`当前帧，原始索引 ${selectedFrame.originalIndex}`} onError={() => markImageBroken(selectedFrame.id)} /> : <div className="frame-broken-state">{selectedFrame ? "当前帧资源损坏或无法解码" : "没有可预览的帧"}</div>}
          </div>
          <div className="button-row frame-playback-controls" aria-label="播放控制">
            <button className="button" type="button" onClick={() => playback.restart()} disabled={!activeIds.length}>重开</button>
            <button className="button" type="button" onClick={() => playback.step(-1)} disabled={selectedActiveIndex <= 0}>上一帧</button>
            {playback.playing ? <button className="button primary" type="button" onClick={playback.pause}>暂停</button> : <button className="button primary" type="button" onClick={playback.play} disabled={activeIds.length < 2}>播放</button>}
            <button className="button" type="button" onClick={() => playback.step(1)} disabled={selectedActiveIndex < 0 || selectedActiveIndex >= activeIds.length - 1}>下一帧</button>
          </div>
        </section>

        <section className="panel frame-detail-panel" ref={detailsRef} tabIndex={-1} aria-label="逐帧详情">
          <h2>逐帧详情</h2>
          {!selectedFrame ? <p className="form-hint">请选择一帧查看详情。</p> : <>
            <dl className="parameter-summary">
              <div><dt>当前顺序</dt><dd>{selectedWorkspaceIndex + 1}</dd></div>
              <div><dt>原始索引</dt><dd>{selectedFrame.originalIndex}</dd></div>
              <div><dt>当前版本</dt><dd>{selectedFrame.currentVersion === "original" ? "原始帧" : "重试候选"}</dd></div>
              <div><dt>尺寸</dt><dd>{selectedFrame.frame.width} × {selectedFrame.frame.height}</dd></div>
              <div><dt>格式 / 大小</dt><dd>{selectedFrame.frame.mimeType} · {(selectedFrame.frame.size / 1024).toFixed(1)} KB</dd></div>
              <div><dt>审核状态</dt><dd>{decisionLabels[selectedFrame.decision]}</dd></div>
            </dl>
            <div className="button-row frame-review-actions">
              <button className="button primary" type="button" disabled={selectedFrame.decision === "kept"} onClick={() => model.decide(selectedFrame.id, "kept")}>保留</button>
              <button className="button" type="button" disabled={selectedFrame.decision === "pending"} onClick={() => model.decide(selectedFrame.id, "pending")}>设为待审核</button>
              {selectedFrame.decision === "removed" ? <button className="button" type="button" onClick={() => model.restore(selectedFrame.id)}>恢复到原位置</button> : <button className="button danger" type="button" onClick={() => setRemoveConfirmation(selectedFrame.id)}>移除</button>}
            </div>
            {removeConfirmation === selectedFrame.id && <div className="alert warning frame-remove-confirm"><strong>确认非破坏性移除？</strong><p>原始 Blob 会保留，可从“已移除”筛选中恢复。</p><div className="button-row"><button className="button danger" type="button" onClick={() => { model.decide(selectedFrame.id, "removed"); setRemoveConfirmation(null); }}>确认移除</button><button className="button" type="button" onClick={() => setRemoveConfirmation(null)}>取消</button></div></div>}
            <div className="frame-retry-capability">
              <strong>指定帧重试</strong>
              <p>{model.retryCapability(selectedFrame)}</p>
              {model.retryActionError && model.retryActionFrameId === null && <div className="alert error" role="alert">{model.retryActionError}</div>}
              {selectedFrame.retryStatus === "running" && <div className="alert info" role="status">正在完整重生成序列；完成后只采用原始索引 {selectedFrame.originalIndex} 作为候选。</div>}
              {selectedFrame.retryStatus === "status_unknown" && <div className="alert warning"><strong>重试状态未知</strong><p>不会重新提交；再次操作只会查询/对账已有子任务。</p></div>}
              {selectedFrame.retryStatus === "failed" && <div className="alert error"><strong>重试失败</strong><p>{selectedFrame.retryError || "候选未生成，当前帧保持不变。"}</p></div>}
              {selectedFrame.candidate ? (
                <div className="frame-candidate-comparison">
                  <figure><figcaption>当前原版</figcaption>{selectedUrl && !brokenImages.has(selectedFrame.id) ? <img src={selectedUrl} alt="当前原版帧" onError={() => markImageBroken(selectedFrame.id)} /> : <span>原版资源损坏或无法解码</span>}</figure>
                  <figure><figcaption>重试候选</figcaption>{candidateUrl && !brokenImages.has(`${selectedFrame.id}:candidate`) ? <img src={candidateUrl} alt="重试候选帧" onError={() => markImageBroken(`${selectedFrame.id}:candidate`)} /> : <span>候选资源损坏或无法解码</span>}</figure>
                  <p>候选来自完整子任务的原始索引 {selectedFrame.originalIndex}；不会自动替换。</p>
                  <div className="button-row">
                    <button className="button primary" type="button" disabled={Boolean(model.retryActionFrameId) || model.saveState !== "saved" || !candidateUrl || brokenImages.has(`${selectedFrame.id}:candidate`)} onClick={() => void model.acceptCandidate(selectedFrame.id)}>接受候选</button>
                    <button className="button" type="button" disabled={Boolean(model.retryActionFrameId) || model.saveState !== "saved"} onClick={() => void model.discardCandidate(selectedFrame.id)}>放弃候选</button>
                  </div>
                </div>
              ) : selectedFrame.currentVersion === "candidate" ? (
                <button className="button" type="button" disabled={Boolean(model.retryActionFrameId) || model.saveState !== "saved"} onClick={() => void model.restoreOriginal(selectedFrame.id)}>恢复原版</button>
              ) : selectedFrame.retryStatus === "status_unknown" && !selectedFrame.retryCanReconcile ? null
              : (
                <button className="button" type="button" disabled={Boolean(model.retryActionFrameId) || model.saveState !== "saved" || selectedFrame.decision === "removed" || (selectedFrame.retryStatus === "running" && !selectedFrame.retryCanReconcile) || selectedFrame.retryMode !== "full_sequence_fallback"} onClick={() => void model.requestRetry(selectedFrame.id)}>
                  {model.retryActionFrameId === selectedFrame.id ? "正在处理重试…" : selectedFrame.retryCanReconcile ? "查询 / 对账" : selectedFrame.retryStatus === "failed" ? "重新发起重试" : "完整重生成并提取此帧"}
                </button>
              )}
              {selectedFrame.retryCanAbandon && <div className="alert warning frame-abandon-retry"><strong>放弃本地跟踪</strong><p>放弃后工作区可继续验收，但远端任务仍可能运行并产生费用；不会删除任何原始帧或候选资源。</p><button className="button danger" type="button" disabled={Boolean(model.retryActionFrameId) || model.saveState !== "saved"} onClick={() => void model.abandonRetryTracking(selectedFrame.id)}>放弃跟踪</button></div>}
            </div>
            <div className="button-row frame-order-actions"><button className="button" type="button" disabled={selectedWorkspaceIndex <= 0} onClick={() => model.move(selectedFrame.id, selectedWorkspaceIndex - 1)}>向前移动</button><button className="button" type="button" disabled={selectedWorkspaceIndex >= workspace.frames.length - 1} onClick={() => model.move(selectedFrame.id, selectedWorkspaceIndex + 1)}>向后移动</button></div>
          </>}
        </section>
      </div>

      <section className="panel frame-strip-panel">
        <div className="section-heading"><div><h2>帧带</h2><p>拖拽、按钮或 Alt + 左右方向键均可排序。</p></div><label className="frame-filter">筛选<select value={model.filter} onChange={(event) => model.setFilter(event.target.value as typeof model.filter)}><option value="all">全部（{workspace.frames.length}）</option><option value="pending">待审核（{counts.pending}）</option><option value="kept">已保留（{counts.kept}）</option><option value="removed">已移除（{counts.removed}）</option></select></label></div>
        {model.visibleFrames.length === 0 ? <div className="empty-state frame-filter-empty">当前筛选没有帧。</div> : <div className="frame-strip" role="listbox" aria-label="工作区帧顺序">{model.visibleFrames.map((frame) => {
          const index = workspace.frames.findIndex((item) => item.id === frame.id);
          return <button key={frame.id} className={`frame-thumbnail ${model.selectedId === frame.id ? "selected" : ""} ${frame.decision}`} type="button" role="option" aria-selected={model.selectedId === frame.id} draggable onDragStart={() => setDraggedId(frame.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => onDrop(frame.id)} onClick={() => model.selectFrame(frame.id)} onKeyDown={(event) => onFrameKeyDown(event, frame)}>
            <span className="frame-thumb-image">{urls[frame.id] && !brokenImages.has(frame.id) ? <img src={urls[frame.id]} alt="" onError={() => markImageBroken(frame.id)} /> : <span>资源损坏</span>}</span>
            <span className="frame-thumb-meta"><strong>#{index + 1}</strong><small>原始 {frame.originalIndex}</small><small>{decisionLabels[frame.decision]}</small></span>
          </button>;
        })}</div>}
      </section>

      <section className="panel frame-readiness-panel">
        <div><h2>交接就绪检查</h2>{model.readiness?.ready ? <p className="status-ok">所有纳入帧均已保留且资源可读，可以生成不可变快照。</p> : <ul>{model.readiness?.issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul>}</div>
        <div><button className="button primary" type="button" disabled={!model.readiness?.ready || model.saveState !== "saved"} onClick={() => void model.createSnapshot()}>生成工作区快照</button>{model.snapshot && <p className="status-ok" role="status">快照 {model.snapshot.id} 已生成，共 {model.snapshot.frameCount} 帧。</p>}</div>
      </section>
    </main>
  );
}
