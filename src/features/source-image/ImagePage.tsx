import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { compileSourceImagePrompt } from "../../core/promptTemplates";
import {
  aspectRatios,
  qualityLevels,
  type AspectRatio,
  type ProviderId,
  type QualityLevel,
  type ReferenceImageSnapshot,
  type SourceImageAsset,
  type SourceImageMode,
} from "../../core/sourceImage";
import { useSourceImages } from "./SourceImageContext";
import { ImageUpload } from "./ImageUpload";

const modeOptions: Array<{ id: SourceImageMode; label: string; description: string }> = [
  { id: "text_to_image", label: "文生图", description: "使用文字描述创建新的源图" },
  { id: "image_to_image", label: "图生图", description: "上传参考图并描述需要的变化" },
  { id: "local_upload", label: "直接使用本地图片", description: "跳过生图 API，直接确认本地图片" },
];

const qualityLabels: Record<QualityLevel, string> = {
  draft: "草稿 / 快速",
  standard: "标准",
  high: "高质量",
};

const previewScaleLimits = { minimum: 0.25, maximum: 8 } as const;

interface PreviewTransform {
  scale: number;
  x: number;
  y: number;
}

interface PreviewDragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

function fileExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

export function ImagePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedSourceId = searchParams.get("sourceId")?.trim() || null;
  const redoOfJobId = searchParams.get("redoOf")?.trim() || null;
  const {
    providers,
    providersLoading,
    history,
    historyLoading,
    currentSourceId,
    taskStatus,
    taskError,
    promptSettings,
    generate,
    addLocalImage,
    confirmSource,
    removeSourceImage,
    clearTaskError,
  } = useSourceImages();
  const [mode, setMode] = useState<SourceImageMode>("text_to_image");
  const [provider, setProvider] = useState<ProviderId>("mcp_banana");
  const [userPrompt, setUserPrompt] = useState("");
  const [referenceImage, setReferenceImage] = useState<ReferenceImageSnapshot>();
  const [changeIntent, setChangeIntent] = useState<"preserve" | "balanced" | "creative">("balanced");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("1:1");
  const [quality, setQuality] = useState<QualityLevel>("standard");
  const [count, setCount] = useState(1);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const historyStripRef = useRef<HTMLDivElement>(null);
  const historyFrameRef = useRef<HTMLDivElement>(null);
  const previewStageRef = useRef<HTMLDivElement>(null);
  const parametersPanelRef = useRef<HTMLFormElement>(null);
  const previewDragRef = useRef<PreviewDragState | null>(null);
  const [historyScrollState, setHistoryScrollState] = useState({
    position: 0,
    maximum: 0,
  });
  const [previewTransform, setPreviewTransform] = useState<PreviewTransform>({
    scale: 1,
    x: 0,
    y: 0,
  });
  const [previewDragging, setPreviewDragging] = useState(false);

  const selectedProvider = providers.find((item) => item.id === provider);
  const busy = ["validating", "submitting", "generating"].includes(taskStatus);
  const requestedAsset = useMemo(
    () => history.find((asset) => asset.id === requestedSourceId),
    [history, requestedSourceId],
  );
  const newestAssetId = history[0]?.id ?? null;
  const previewAsset = useMemo(
    () =>
      history.find((asset) => asset.id === previewAssetId) ??
      requestedAsset ??
      history[0] ??
      null,
    [history, previewAssetId, requestedAsset],
  );
  const previewConfirmed = Boolean(
    previewAsset &&
      currentSourceId === previewAsset.id &&
      previewAsset.confirmedAt &&
      previewAsset.contentSnapshotId &&
      previewAsset.availability === "available",
  );
  const compiledPrompt = useMemo(
    () =>
      mode === "local_upload"
        ? "本地图片不会调用生图提示词。"
        : compileSourceImagePrompt({
            mode,
            basePrompt: promptSettings.basePrompt,
            userPrompt,
            negativePrompt: promptSettings.negativePrompt,
            changeIntent: mode === "image_to_image" ? changeIntent : undefined,
          }),
    [mode, promptSettings, userPrompt, changeIntent],
  );

  useEffect(() => {
    if (selectedProvider && !selectedProvider.supportsMultipleImages && count !== 1) {
      setCount(1);
    }
  }, [count, selectedProvider]);

  useEffect(() => {
    setPreviewAssetId(requestedAsset?.id ?? newestAssetId);
  }, [newestAssetId, requestedAsset?.id]);

  useEffect(() => {
    if (previewAssetId && !history.some((asset) => asset.id === previewAssetId)) {
      setPreviewAssetId(requestedAsset?.id ?? newestAssetId);
    }
  }, [history, newestAssetId, previewAssetId, requestedAsset?.id]);

  useEffect(() => {
    resetPreviewTransform();
  }, [previewAsset?.id]);

  useEffect(() => {
    const element = previewStageRef.current;
    if (!element || !previewAsset) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;

      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left - bounds.width / 2;
      const pointerY = event.clientY - bounds.top - bounds.height / 2;
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setPreviewTransform((current) => {
        const scale = Math.min(
          previewScaleLimits.maximum,
          Math.max(previewScaleLimits.minimum, current.scale * factor),
        );
        if (scale === current.scale) return current;
        const ratio = scale / current.scale;
        return {
          scale,
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        };
      });
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [previewAsset]);

  useEffect(() => {
    const element = historyStripRef.current;
    const frame = historyFrameRef.current;
    if (!element) {
      setHistoryScrollState({ position: 0, maximum: 0 });
      return;
    }
    const update = () => updateHistoryScrollState();
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
      element.scrollLeft = Math.min(maximum, Math.max(0, element.scrollLeft + event.deltaY));
      update();
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    frame?.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("resize", update);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resizeObserver?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      frame?.removeEventListener("wheel", handleWheel);
      window.removeEventListener("resize", update);
      resizeObserver?.disconnect();
    };
  }, [history.length]);

  const invalidReason = useMemo(() => {
    if (mode === "local_upload") return referenceImage ? "" : "请先选择本地图片。";
    if (!selectedProvider?.configured) return "当前服务商尚未在代理端配置。";
    if (!userPrompt.trim()) return "请填写图片描述。";
    if (mode === "image_to_image" && !referenceImage) return "图生图需要参考图片。";
    return "";
  }, [mode, referenceImage, selectedProvider, userPrompt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalidReason || busy) return;
    clearTaskError();

    if (mode === "local_upload" && referenceImage) {
      await addLocalImage(referenceImage);
      return;
    }

    if (mode !== "local_upload") {
      await generate({
        provider,
        mode,
        userPrompt,
        basePrompt: promptSettings.basePrompt,
        negativePrompt: promptSettings.negativePrompt,
        changeIntent: mode === "image_to_image" ? changeIntent : undefined,
        aspectRatio,
        quality,
        count,
        clientRequestId: crypto.randomUUID(),
        referenceImage: mode === "image_to_image" ? referenceImage : undefined,
      });
    }
  }

  function reuseAsset(asset: SourceImageAsset) {
    if (asset.mode === "local_upload") {
      setMode("local_upload");
      setReferenceImage(asset.referenceImage);
    } else {
      setMode(asset.mode);
      if (asset.provider !== "local") setProvider(asset.provider);
      setUserPrompt(asset.promptSnapshot.userPrompt);
      setReferenceImage(asset.referenceImage);
      setAspectRatio(asset.effectiveParameters.aspectRatio);
      setQuality(asset.effectiveParameters.quality);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function confirmAndContinue(asset: SourceImageAsset) {
    await confirmSource(asset.id);
    const next = new URLSearchParams();
    if (redoOfJobId) next.set("redoOf", redoOfJobId);
    const query = next.toString();
    navigate(`/create/sequence${query ? `?${query}` : ""}`);
  }

  function updateHistoryScrollState() {
    const element = historyStripRef.current;
    if (!element) return;
    const next = {
      position: element.scrollLeft,
      maximum: Math.max(0, element.scrollWidth - element.clientWidth),
    };
    setHistoryScrollState((current) =>
      current.position === next.position && current.maximum === next.maximum
        ? current
        : next,
    );
  }

  function setHistoryScrollPosition(position: number) {
    const element = historyStripRef.current;
    if (!element) return;
    element.scrollLeft = Math.min(
      Math.max(0, element.scrollWidth - element.clientWidth),
      Math.max(0, position),
    );
    updateHistoryScrollState();
  }

  function focusNewImageParameters() {
    const panel = parametersPanelRef.current;
    panel?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    panel?.querySelector<HTMLElement>("textarea, input:not([type='hidden']), select, button")?.focus({
      preventScroll: true,
    });
  }

  function resetPreviewTransform() {
    previewDragRef.current = null;
    setPreviewDragging(false);
    setPreviewTransform({ scale: 1, x: 0, y: 0 });
  }

  function handlePreviewPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 1 || !previewAsset) return;
    event.preventDefault();
    previewDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: previewTransform.x,
      originY: previewTransform.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPreviewDragging(true);
  }

  function handlePreviewPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = previewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPreviewTransform((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  }

  function finishPreviewDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = previewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    previewDragRef.current = null;
    setPreviewDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  }

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>新生成</h1>
        <p>步骤 1/2：生成新图或从库存选择，并确认本次序列使用的静态图。</p>
      </header>

      {redoOfJobId && (
        <div className="alert info workflow-notice">
          <strong>从序列 {redoOfJobId} 发起重做</strong>
          <p>请重新确认对应静态图；继续后会创建新的序列帧 ID，不覆盖原序列。</p>
        </div>
      )}
      {requestedSourceId && !history.some((asset) => asset.id === requestedSourceId) && !historyLoading && (
        <div className="alert error workflow-notice" role="alert">
          对应静态图不存在或已被清理，请从图库选择其他静态图。
        </div>
      )}

      <div className="source-image-workspace">
        <form
          className="panel controls-panel source-image-parameters"
          ref={parametersPanelRef}
          onSubmit={(event) => void submit(event)}
        >
          <h2>输入与参数</h2>

          <fieldset className="mode-switcher">
            <legend>输入方式</legend>
            {modeOptions.map((option) => (
              <label className={`mode-option${mode === option.id ? " selected" : ""}`} key={option.id}>
                <input
                  type="radio"
                  name="mode"
                  value={option.id}
                  checked={mode === option.id}
                  onChange={() => setMode(option.id)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </fieldset>

          {mode !== "text_to_image" && (
            <label className="field">
              <span>{mode === "image_to_image" ? "参考图片" : "本地源图"}</span>
              <ImageUpload value={referenceImage} onChange={setReferenceImage} />
            </label>
          )}

          {mode !== "local_upload" && (
            <>
              <label className="field">
                <span>API 服务商</span>
                <select value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)}>
                  {providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} {item.configured ? "" : "（未配置）"}
                    </option>
                  ))}
                </select>
                {providersLoading && <small>正在读取服务状态…</small>}
                {!selectedProvider?.configured && !providersLoading && (
                  <small className="status-warning">
                    请先在 <Link to="/settings">设置</Link> 中检查代理配置。
                  </small>
                )}
              </label>

              <label className="field">
                <span>{mode === "image_to_image" ? "改动描述" : "图片描述"}</span>
                <textarea
                  rows={5}
                  value={userPrompt}
                  onChange={(event) => setUserPrompt(event.target.value)}
                  placeholder={
                    mode === "image_to_image"
                      ? "例如：保留角色身份和服装，将姿势改为正面站立"
                      : "例如：一个全身像素风女骑士，正面站立，干净背景"
                  }
                />
              </label>

              {mode === "image_to_image" && (
                <label className="field">
                  <span>改动意图</span>
                  <select value={changeIntent} onChange={(event) => setChangeIntent(event.target.value as typeof changeIntent)}>
                    <option value="preserve">尽量保留原图</option>
                    <option value="balanced">适度调整</option>
                    <option value="creative">自由重绘</option>
                  </select>
                  {provider === "openai" && <small>GPT Image 2 始终使用高保真图片输入，此选项通过提示词表达。</small>}
                </label>
              )}

              <div className="field-row">
                <label className="field">
                  <span>宽高比</span>
                  <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}>
                    {aspectRatios.map((ratio) => <option key={ratio}>{ratio}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>质量</span>
                  <select value={quality} onChange={(event) => setQuality(event.target.value as QualityLevel)}>
                    {qualityLevels.map((level) => <option key={level} value={level}>{qualityLabels[level]}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>候选数量</span>
                  <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                    {(selectedProvider?.supportsMultipleImages ? [1, 2, 3, 4] : [1]).map((value) => <option key={value}>{value}</option>)}
                  </select>
                </label>
              </div>

              <details className="prompt-preview">
                <summary>最终提示词预览 · 模板 v{promptSettings.version}</summary>
                <pre>{compiledPrompt}</pre>
              </details>
            </>
          )}

          {invalidReason && <p className="form-hint">{invalidReason}</p>}
          <button className="button primary wide" type="submit" disabled={Boolean(invalidReason) || busy}>
            {busy ? "生成处理中…" : mode === "local_upload" ? "加入结果并等待确认" : "生成图片"}
          </button>

          {taskError && (
            <div className="alert error" role="alert">
              <strong>{taskStatus === "status_unknown" ? "请求状态未知" : "生成失败"}</strong>
              <p>{taskError}</p>
            </div>
          )}
        </form>

        <section className="panel source-image-preview-panel" aria-label="图片预览">
          <div className="section-heading">
            <div>
              <h2>图片预览</h2>
              <p>生成结果会自动进入图库；确认后才会成为本次序列的静态图。</p>
            </div>
            <div className="button-row"><span className="badge">{history.length} 项</span><Link className="button" to="/library/images">打开图库</Link></div>
          </div>

          {historyLoading ? (
            <div className="source-image-preview-stage source-image-preview-empty" aria-busy="true">
              <p>正在读取图片记录…</p>
            </div>
          ) : previewAsset ? (
            <div
              ref={previewStageRef}
              className={`source-image-preview-stage source-image-preview-interactive${previewDragging ? " dragging" : ""}`}
              onPointerDown={handlePreviewPointerDown}
              onPointerMove={handlePreviewPointerMove}
              onPointerUp={finishPreviewDrag}
              onPointerCancel={finishPreviewDrag}
              onAuxClick={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
            >
              <img
                src={previewAsset.dataUrl}
                alt={`当前预览：${previewAsset.sourceName || previewAsset.model}`}
                draggable={false}
                style={{
                  transform: `translate3d(${previewTransform.x}px, ${previewTransform.y}px, 0) scale(${previewTransform.scale})`,
                }}
              />
              <div className="source-image-preview-controls">
                <button
                  className="source-image-preview-reset"
                  type="button"
                  aria-label="复位图片预览"
                  title="恢复完整适配和初始位置"
                  onClick={resetPreviewTransform}
                >
                  ↺
                </button>
                <span>{Math.round(previewTransform.scale * 100)}%</span>
              </div>
              <div className="source-image-preview-badges">
                {previewConfirmed && <span className="badge success">当前源图</span>}
                {requestedSourceId === previewAsset.id && <span className="badge">重做指定图</span>}
              </div>
            </div>
          ) : (
            <div className="source-image-preview-stage source-image-preview-empty">
              <p>还没有图片结果。</p>
              <small>完成生成或上传后，结果会保存在浏览器 IndexedDB 中。</small>
            </div>
          )}

          <section className="source-image-history" aria-labelledby="source-image-history-title">
            <div className="source-image-history-heading">
              <div>
                <h3 id="source-image-history-title">当前结果与历史记录</h3>
                <p>选择缩略图切换上方预览。</p>
              </div>
              <span className="form-hint">{history.length} 张</span>
            </div>

            <div className="source-image-history-frame" ref={historyFrameRef}>
              <div className="source-image-history-carousel">
                <div
                  className="source-image-history-strip"
                  ref={historyStripRef}
                  role="list"
                  aria-label="当前结果与历史缩略图"
                  onScroll={updateHistoryScrollState}
                >
                  {history.map((asset) => {
                    const confirmed =
                      currentSourceId === asset.id &&
                      Boolean(asset.confirmedAt && asset.contentSnapshotId) &&
                      asset.availability === "available";
                    const selected = previewAsset?.id === asset.id;
                    return (
                      <div role="listitem" key={asset.id}>
                        <button
                          className={`source-image-history-thumb${selected ? " selected" : ""}${confirmed ? " confirmed" : ""}${requestedSourceId === asset.id ? " requested" : ""}`}
                          type="button"
                          aria-label={`预览图片：${asset.sourceName || asset.model}，${new Date(asset.createdAt).toLocaleString()}`}
                          aria-pressed={selected}
                          onClick={() => setPreviewAssetId(asset.id)}
                        >
                          <span className="source-image-history-thumb-image">
                            <img src={asset.dataUrl} alt="" />
                            {confirmed && <span className="source-image-history-thumb-status">当前</span>}
                            {!confirmed && requestedSourceId === asset.id && <span className="source-image-history-thumb-status">指定</span>}
                          </span>
                          <span className="source-image-history-thumb-label">
                            {asset.provider === "local" ? "本地上传" : asset.model}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                  <div role="listitem">
                    <button
                      className="source-image-history-thumb source-image-history-new"
                      type="button"
                      aria-label="新建图片"
                      onClick={focusNewImageParameters}
                    >
                      <span className="source-image-history-new-icon" aria-hidden="true">＋</span>
                      <span className="source-image-history-thumb-label">新建图片</span>
                    </button>
                  </div>
                </div>
              </div>
              <input
                className="source-image-history-slider"
                type="range"
                min="0"
                max={historyScrollState.maximum}
                step="1"
                value={Math.min(historyScrollState.position, historyScrollState.maximum)}
                disabled={historyScrollState.maximum === 0}
                aria-label="历史图片横向滚动位置"
                onChange={(event) => setHistoryScrollPosition(Number(event.target.value))}
              />
            </div>
          </section>

          {previewAsset && (
            <section className="source-image-preview-details" aria-label="当前预览图片信息">
              <div className="result-title">
                <strong>{previewAsset.provider === "local" ? "本地上传" : previewAsset.model}</strong>
                <span className="form-hint">图片 ID：{previewAsset.id}</span>
              </div>
              <small>
                {previewAsset.width && previewAsset.height ? `${previewAsset.width} × ${previewAsset.height} · ` : ""}
                {previewAsset.effectiveParameters.quality} · {new Date(previewAsset.createdAt).toLocaleString()}
              </small>
              {previewAsset.promptSnapshot.userPrompt && (
                <p title={previewAsset.promptSnapshot.compiledPrompt}>{previewAsset.promptSnapshot.userPrompt}</p>
              )}
              <details className="template-details">
                <summary>查看生成元数据</summary>
                <small>
                  任务：{previewAsset.jobId}<br />
                  模式：{previewAsset.mode}<br />
                  规格：{previewAsset.effectiveParameters.providerSize}<br />
                  模板：v{previewAsset.promptSnapshot.templateVersion}
                </small>
                {previewAsset.promptSnapshot.compiledPrompt && <pre>{previewAsset.promptSnapshot.compiledPrompt}</pre>}
              </details>
              <div className="button-row source-image-preview-actions">
                <button className="button primary" type="button" onClick={() => void confirmAndContinue(previewAsset).catch(() => undefined)}>
                  {previewConfirmed ? "使用此图继续" : requestedSourceId === previewAsset.id ? "确认对应静态图并继续" : "确认并进入序列生成"}
                </button>
                <a
                  className="button"
                  href={previewAsset.dataUrl}
                  download={`gif-craft-${previewAsset.id}.${fileExtension(previewAsset.mimeType)}`}
                >
                  下载
                </a>
                <button className="button" type="button" onClick={() => reuseAsset(previewAsset)}>
                  复用参数
                </button>
                <button className="button danger" type="button" onClick={() => void removeSourceImage(previewAsset.id).catch(() => undefined)}>
                  删除记录
                </button>
              </div>
            </section>
          )}
        </section>
      </div>
    </main>
  );
}
