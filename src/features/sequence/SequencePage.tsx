import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  compileSequencePrompt,
  diffSequenceParameters,
  guardSourceImageForSequence,
  sequencePresets,
  validateSequenceParameters,
  type CharacterAction,
  type GenerationJob,
  type SequenceEffectiveParameters,
  type SequenceGenerationRequest,
  type SequencePresetId,
  type SequenceRequestedParameters,
} from "../../core/sequenceGeneration";
import type { AspectRatio } from "../../core/sourceImage";
import { getImageDimensions } from "../source-image/imageFile";
import { useSourceImages } from "../source-image/SourceImageContext";
import { useSequenceGeneration } from "./SequenceContext";

const statusLabels = {
  draft: "草稿",
  validating: "正在校验",
  ready: "等待提交",
  retrying: "正在准备重试",
  submitting: "正在提交",
  queued: "服务商排队中",
  generating: "正在生成",
  processing: "正在处理帧",
  cancelling: "正在取消",
  completed: "已完成",
  failed: "生成失败",
  status_unknown: "状态未知",
  abandoned: "已放弃跟踪",
  cancelled: "已取消",
} as const;

const terminalDisplayStatuses = new Set([
  "completed",
  "failed",
  "status_unknown",
  "abandoned",
  "cancelled",
]);

function displayStage(job: GenerationJob): string {
  return terminalDisplayStatuses.has(job.status) ? job.status : job.stage || statusLabels[job.status];
}

function nearestSupported(value: number, supported: readonly number[]): number {
  if (supported.length === 0) return value;
  return supported.reduce((best, item) =>
    Math.abs(item - value) < Math.abs(best - value) ? item : best,
  );
}

function resolutionPixels(resolutions: readonly string[]): number | null {
  const match = /^(\d+)p$/.exec(resolutions[0] ?? "");
  return match ? Number(match[1]) : null;
}

function formatElapsed(createdAt: string, now: number): string {
  const elapsed = Math.max(0, now - new Date(createdAt).getTime());
  const seconds = Math.floor(elapsed / 1_000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function SequencePage() {
  const [searchParams] = useSearchParams();
  const redoOfJobId = searchParams.get("redoOf")?.trim() || undefined;
  const { historyLoading, currentSourceId, currentSource } = useSourceImages();
  const {
    providers,
    providersLoading,
    jobsLoading,
    currentJob,
    frames,
    resultStorageStatus,
    submitting,
    reconciling,
    error,
    submit,
    retryFailed,
    reconcile,
    abandonTracking,
  } = useSequenceGeneration();
  const [presetId, setPresetId] = useState<SequencePresetId>("character.idle.v1");
  const preset = sequencePresets[presetId];
  const [description, setDescription] = useState("");
  const [frameCount, setFrameCount] = useState(preset.defaults.frameCount);
  const [frameRate, setFrameRate] = useState(preset.defaults.frameRate);
  const [loopMode, setLoopMode] = useState(preset.defaults.loopMode);
  const [providerId, setProviderId] = useState("");
  const [runtimeReadability, setRuntimeReadability] = useState<
    "idle" | "loading" | "readable" | "unreadable"
  >("idle");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!providerId && providers[0]) setProviderId(providers[0].provider);
  }, [providerId, providers]);

  useEffect(() => {
    if (!currentSource?.dataUrl) {
      setRuntimeReadability("idle");
      return;
    }
    let active = true;
    setRuntimeReadability("loading");
    void getImageDimensions(currentSource.dataUrl)
      .then((dimensions) => {
        if (!active) return;
        setRuntimeReadability(
          dimensions.width === currentSource.width && dimensions.height === currentSource.height
            ? "readable"
            : "unreadable",
        );
      })
      .catch(() => active && setRuntimeReadability("unreadable"));
    return () => {
      active = false;
    };
  }, [currentSource]);

  useEffect(() => {
    if (!currentJob || ["completed", "failed", "status_unknown", "cancelled"].includes(currentJob.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [currentJob]);

  const selectedProvider = providers.find((item) => item.provider === providerId);
  const sourceGuard = useMemo(
    () => guardSourceImageForSequence(currentSource, currentSourceId),
    [currentSource, currentSourceId],
  );

  const requestedParameters = useMemo<SequenceRequestedParameters | null>(() => {
    if (!currentSource?.width || !currentSource.height) return null;
    return {
      frameCount,
      frameRate,
      loopMode,
      canvas: {
        mode: "source",
        aspectRatio: currentSource.effectiveParameters.aspectRatio,
        width: currentSource.width,
        height: currentSource.height,
      },
      anchor: preset.defaults.anchor,
      randomSeed: null,
    };
  }, [currentSource, frameCount, frameRate, loopMode, preset.defaults.anchor]);

  const effectiveParameters = useMemo<SequenceEffectiveParameters | null>(() => {
    if (!requestedParameters?.loopMode || !selectedProvider) return null;
    const aspectRatio = (selectedProvider.aspectRatios.includes(requestedParameters.canvas.aspectRatio)
      ? requestedParameters.canvas.aspectRatio
      : selectedProvider.aspectRatios[0] ?? requestedParameters.canvas.aspectRatio) as AspectRatio;
    const pixels = resolutionPixels(selectedProvider.providerResolutions);
    return {
      frameCount: nearestSupported(requestedParameters.frameCount, selectedProvider.frameCounts),
      frameRate: nearestSupported(requestedParameters.frameRate, selectedProvider.frameRates),
      loopMode: requestedParameters.loopMode,
      canvas: {
        mode: "source",
        aspectRatio,
        width: pixels ?? requestedParameters.canvas.width,
        height: pixels ?? requestedParameters.canvas.height,
      },
      anchor: requestedParameters.anchor,
      randomSeed: selectedProvider.supportsRandomSeed ? requestedParameters.randomSeed : null,
    };
  }, [requestedParameters, selectedProvider]);

  const mappings = useMemo(
    () =>
      requestedParameters && effectiveParameters
        ? diffSequenceParameters(requestedParameters, effectiveParameters, {
            frameCount: "服务商支持的最近帧数",
            frameRate: "服务商支持的最近帧率",
            "canvas.aspectRatio": "服务商输出宽高比限制",
            "canvas.width": "服务商输出分辨率限制",
            "canvas.height": "服务商输出分辨率限制",
            randomSeed: "服务商不支持随机种子",
          })
        : [],
    [requestedParameters, effectiveParameters],
  );

  const parameterIssues = useMemo(
    () => (requestedParameters ? validateSequenceParameters(preset, requestedParameters) : []),
    [preset, requestedParameters],
  );

  const promptSnapshot = useMemo(() => {
    if (!effectiveParameters || !description.trim()) return null;
    try {
      return compileSequencePrompt({ preset, userDescription: description, effectiveParameters });
    } catch {
      return null;
    }
  }, [description, effectiveParameters, preset]);

  const sourceProblem = useMemo(() => {
    if (historyLoading) return { kind: "loading", message: "正在读取已确认源图…" };
    if (!currentSourceId) return { kind: "missing", message: "还没有选择当前源图。" };
    if (!currentSource) return { kind: "dangling", message: "当前源图记录已丢失，请重新确认。" };
    if (!sourceGuard.ok) {
      if (sourceGuard.code === "source_not_confirmed") {
        return { kind: "unconfirmed", message: "该源图需要重新确认后才能生成序列。" };
      }
      return { kind: "invalid", message: sourceGuard.message };
    }
    if (runtimeReadability === "loading") return { kind: "loading", message: "正在复核源图可读性…" };
    if (runtimeReadability !== "readable") return { kind: "unreadable", message: "源图字节已损坏或无法解码。" };
    return null;
  }, [currentSource, currentSourceId, historyLoading, runtimeReadability, sourceGuard]);

  const invalidReason = useMemo(() => {
    if (sourceProblem) return sourceProblem.message;
    if (providersLoading) return "正在读取序列服务能力。";
    if (!selectedProvider) return "没有可用的序列服务商。";
    if (!selectedProvider.configured) return selectedProvider.unavailabilityReason || "序列服务商尚未配置。";
    if (currentJob && (["submitting", "queued", "generating", "processing"].includes(currentJob.status) || currentJob.status === "status_unknown")) {
      return currentJob.status === "status_unknown"
        ? "当前任务状态未知，必须先查询或对账。"
        : "已有任务正在处理，请等待任务结束。";
    }
    if (!description.trim()) return "请填写动作或场景运动描述。";
    if (description.trim().length > 2_000) return "描述不能超过 2000 个字符。";
    if (parameterIssues.length > 0) return parameterIssues[0].message;
    if (!promptSnapshot || !effectiveParameters) return "请完成所有生成参数。";
    return "";
  }, [currentJob, description, effectiveParameters, parameterIssues, promptSnapshot, providersLoading, selectedProvider, sourceProblem]);

  function loadPreset(nextPresetId: SequencePresetId) {
    const nextPreset = sequencePresets[nextPresetId];
    setPresetId(nextPresetId);
    setFrameCount(nextPreset.defaults.frameCount);
    setFrameRate(nextPreset.defaults.frameRate);
    setLoopMode(nextPreset.defaults.loopMode);
  }

  function selectAssetType(assetType: "character" | "scene") {
    loadPreset(assetType === "scene" ? "scene.default.v1" : "character.idle.v1");
  }

  function selectAction(action: CharacterAction) {
    loadPreset(`character.${action}.v1` as SequencePresetId);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (invalidReason || submitting || !sourceGuard.ok || !promptSnapshot || !requestedParameters || !effectiveParameters || !selectedProvider || !currentSource) return;
    const request: SequenceGenerationRequest = {
      draftId: crypto.randomUUID(),
      clientRequestId: crypto.randomUUID(),
      provider: selectedProvider.provider,
      source: sourceGuard.snapshot,
      presetId: preset.id,
      presetVersion: preset.version,
      promptSnapshot,
      requestedParameters,
      effectiveParameters,
      parameterMappings: mappings,
      providerExtensions: { proxyInstanceId: selectedProvider.proxyInstanceId },
    };
    await submit(request, currentSource.dataUrl, { redoOfJobId }).catch(() => undefined);
  }

  const frameOptions = selectedProvider?.frameCounts.length ? selectedProvider.frameCounts : [8, 12];
  const frameRateOptions = selectedProvider?.frameRates.length ? selectedProvider.frameRates : [8, 12];
  const complete = currentJob?.status === "completed" && currentJob.resultIntegrity.status === "complete" && resultStorageStatus === "available" && frames.length > 0;

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>生成序列帧</h1>
        <p>新生成 · 步骤 2/2：使用已确认静态图创建一个独立的序列帧 ID。</p>
      </header>

      {redoOfJobId && (
        <div className="alert info workflow-notice">
          <strong>正在重做序列 {redoOfJobId}</strong>
          <p>本次提交会创建新的序列帧 ID，原序列和原工作区保持不变。</p>
        </div>
      )}

      <div className="sequence-grid">
        <form className="panel sequence-controls" onSubmit={(event) => void onSubmit(event)}>
          <section className="source-summary">
            <div className="section-heading">
              <div><h2>已确认源图</h2><p>提交任务时会冻结这份输入。</p></div>
              <Link className="button" to={redoOfJobId ? `/create?redoOf=${encodeURIComponent(redoOfJobId)}` : "/create"}>返回替换</Link>
            </div>
            {currentSource && !historyLoading ? (
              <div className="source-card">
                <img src={currentSource.dataUrl} alt="当前已确认源图" />
                <div>
                  <strong>{currentSource.sourceName || currentSource.model}</strong>
                  <small>{currentSource.width} × {currentSource.height} · {currentSource.mimeType}</small>
                  <small>来源：{currentSource.provider === "local" ? "本地上传" : currentSource.provider}</small>
                </div>
              </div>
            ) : null}
            {sourceProblem && <div className={`alert ${sourceProblem.kind === "loading" ? "info" : "error"}`} role="status">{sourceProblem.message}</div>}
          </section>

          <section className="sequence-form-section">
            <h2>预设与参数</h2>
            <div className="field-row two-columns">
              <label className="field">
                <span>资产类型</span>
                <select value={preset.assetType} onChange={(event) => selectAssetType(event.target.value as "character" | "scene")}>
                  <option value="character">角色</option>
                  <option value="scene">场景</option>
                </select>
              </label>
              {preset.assetType === "character" && (
                <label className="field">
                  <span>动作预设</span>
                  <select value={preset.action ?? "idle"} onChange={(event) => selectAction(event.target.value as CharacterAction)}>
                    <option value="idle">待机</option>
                    <option value="attack">攻击</option>
                    <option value="other">其他</option>
                  </select>
                </label>
              )}
            </div>

            <label className="field">
              <span>{preset.assetType === "scene" ? "场景运动描述" : "动作描述"}</span>
              <textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={preset.assetType === "scene" ? "例如：树叶和旗帜轻微摆动，镜头保持固定" : "例如：轻微呼吸，披风随动作自然摆动"} />
              <small>{description.length} / 2000；文字不能覆盖固定画布、锚点和镜头约束。</small>
            </label>

            <div className="field-row three-columns">
              <label className="field">
                <span>帧数</span>
                <select value={frameCount} onChange={(event) => setFrameCount(Number(event.target.value))}>
                  {frameOptions.map((value) => <option key={value} value={value}>{value} 帧</option>)}
                </select>
              </label>
              <label className="field">
                <span>帧率</span>
                <select value={frameRate} onChange={(event) => setFrameRate(Number(event.target.value))}>
                  {frameRateOptions.map((value) => <option key={value} value={value}>{value} FPS</option>)}
                </select>
              </label>
              <label className="field">
                <span>循环方式</span>
                {preset.id === "character.other.v1" ? (
                  <select value={loopMode ?? ""} onChange={(event) => setLoopMode(event.target.value as "loop" | "once")}>
                    <option value="">请选择</option>
                    <option value="loop">循环</option>
                    <option value="once">单次</option>
                  </select>
                ) : <input value={loopMode === "loop" ? "循环" : "单次"} readOnly />}
              </label>
            </div>

            <label className="field">
              <span>序列服务商</span>
              <select value={providerId} onChange={(event) => setProviderId(event.target.value)} disabled={providersLoading}>
                {providers.length === 0 && <option value="">没有可用服务</option>}
                {providers.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.model}{provider.configured ? "" : "（不可用）"}</option>)}
              </select>
              {selectedProvider && !selectedProvider.supportsRandomSeed && <small>当前服务不支持随机种子；不会伪造或提交该参数。</small>}
            </label>
          </section>

          {invalidReason && <p className="form-hint">{invalidReason}</p>}
          <button className="button primary wide" type="submit" disabled={Boolean(invalidReason) || submitting}>
            {submitting ? "正在提交…" : "开始生成"}
          </button>
        </form>

        <section className="sequence-side">
          <div className="panel request-preview">
            <h2>请求预览</h2>
            <dl className="parameter-summary">
              <div><dt>预设</dt><dd>{preset.displayName} · v{preset.version}</dd></div>
              <div><dt>画布</dt><dd>继承源图</dd></div>
              <div><dt>锚点</dt><dd>{preset.defaults.anchor === "bottom_center_feet_baseline" ? "底部中心 / 脚底基线" : "完整画布 / 固定镜头"}</dd></div>
              <div><dt>预计输出</dt><dd>{effectiveParameters ? `${effectiveParameters.frameCount} 帧 · ${effectiveParameters.frameRate} FPS · ${effectiveParameters.canvas.width}×${effectiveParameters.canvas.height}` : "等待有效参数"}</dd></div>
            </dl>
            {mappings.length > 0 ? (
              <div className="mapping-list">
                <strong>请求值 → 最终有效值</strong>
                {mappings.map((mapping) => <p key={mapping.field}><code>{mapping.field}</code>：{String(mapping.requested)} → {String(mapping.effective)} <small>{mapping.reason}</small></p>)}
              </div>
            ) : <p className="status-ok">当前结构化参数无需映射。</p>}
            <div className="alert warning"><strong>源图外发提示</strong><p>只有点击“开始生成”后，源图才会发送给 {selectedProvider?.model || "所选服务商"}。</p></div>
            {promptSnapshot && <details className="prompt-preview"><summary>编译提示词摘要 · {preset.id}</summary><pre>{promptSnapshot.compiledText}</pre></details>}
          </div>

          <div className="panel task-panel">
            <h2>当前任务</h2>
            {jobsLoading ? <p>正在恢复本地任务…</p> : !currentJob ? <div className="empty-state"><p>尚未提交序列任务。</p></div> : (
              <div className="task-status">
                <div className="section-heading"><div><strong>{statusLabels[currentJob.status]}</strong><p>任务 {currentJob.id}</p></div><span className={`badge ${complete ? "success" : ""}`}>{currentJob.status}</span></div>
                <dl className="parameter-summary">
                  <div><dt>阶段</dt><dd>{displayStage(currentJob)}</dd></div>
                  <div><dt>耗时</dt><dd>{formatElapsed(currentJob.timestamps.createdAt, now)}</dd></div>
                  {currentJob.progress !== null && <div><dt>真实进度</dt><dd>{Math.round(currentJob.progress * 100)}%</dd></div>}
                </dl>
                {currentJob.progress === null && ["submitting", "queued", "generating", "processing"].includes(currentJob.status) && <p className="form-hint">服务商未提供真实百分比，当前只显示阶段和耗时。</p>}
                {currentJob.status === "status_unknown" && <div className="alert warning"><strong>必须先查询或对账</strong><p>状态未知不等于失败；不会自动创建新任务。</p><div className="button-row"><button className="button" type="button" disabled={reconciling} onClick={() => void reconcile()}>{reconciling ? "正在对账…" : "查询 / 对账"}</button><button className="button danger" type="button" disabled={reconciling} onClick={() => void abandonTracking()}>放弃跟踪</button></div></div>}
                {currentJob.status === "abandoned" && <div className="alert warning"><strong>已放弃跟踪（远端状态未知）</strong><p>现在可以创建新任务，但原远端任务仍可能继续运行。</p></div>}
                {currentJob.status === "failed" && currentJob.lastError?.retryable !== false && <button className="button" type="button" disabled={submitting} onClick={() => void retryFailed().catch(() => undefined)}>使用原快照重试</button>}
                {currentJob.stage === "storage_failed" && <button className="button" type="button" onClick={() => void reconcile()}>再次保存结果</button>}
                {complete && (
                  <div className="result-handoff">
                    <p>{frames.length} 帧 · {currentJob.request.effectiveParameters.frameRate} FPS · {currentJob.request.effectiveParameters.loopMode === "loop" ? "循环" : "单次"}</p>
                    <Link className="button primary" to={`/workspace/${encodeURIComponent(currentJob.id)}`}>进入序列帧工作区</Link>
                  </div>
                )}
                {currentJob.status === "completed" && resultStorageStatus === "purged" && (
                  <div className="alert warning"><strong>本地结果已清理</strong><p>任务元数据仍保留，但帧资源已按保留策略清理；需要重新生成后才能进入工作区。</p></div>
                )}
                {currentJob.status === "completed" && resultStorageStatus === "invalid" && (
                  <div className="alert error"><strong>本地结果已损坏</strong><p>帧数量、索引、尺寸或 Blob 元数据不一致；需要重新生成。</p></div>
                )}
              </div>
            )}
            {error && <div className="alert error" role="alert">{error}</div>}
          </div>
        </section>
      </div>
    </main>
  );
}
