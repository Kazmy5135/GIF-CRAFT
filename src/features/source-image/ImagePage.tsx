import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
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

function fileExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

export function ImagePage() {
  const {
    providers,
    providersLoading,
    history,
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
  const [provider, setProvider] = useState<ProviderId>("mcp");
  const [userPrompt, setUserPrompt] = useState("");
  const [referenceImage, setReferenceImage] = useState<ReferenceImageSnapshot>();
  const [changeIntent, setChangeIntent] = useState<"preserve" | "balanced" | "creative">("balanced");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("1:1");
  const [quality, setQuality] = useState<QualityLevel>("standard");
  const [count, setCount] = useState(1);

  const selectedProvider = providers.find((item) => item.id === provider);
  const busy = ["validating", "submitting", "generating"].includes(taskStatus);
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

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>生图</h1>
        <p>先生成或确认一张源图，再进入序列帧生成。</p>
      </header>

      <div className="workspace-grid">
        <form className="panel controls-panel" onSubmit={(event) => void submit(event)}>
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
                    {[1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}
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

        <section className="panel results-panel">
          <div className="section-heading">
            <div>
              <h2>结果与历史</h2>
              <p>生成结果不会自动成为序列帧源图。</p>
            </div>
            <span className="badge">{history.length} 项</span>
          </div>

          {history.length === 0 ? (
            <div className="empty-state">
              <p>还没有图片结果。</p>
              <small>完成生成或上传后，结果会保存在浏览器 IndexedDB 中。</small>
            </div>
          ) : (
            <div className="result-grid">
              {history.map((asset) => {
                const confirmed = currentSourceId === asset.id;
                return (
                  <article className={`result-card${confirmed ? " confirmed" : ""}`} key={asset.id}>
                    <a href={asset.dataUrl} target="_blank" rel="noreferrer" title="打开原图">
                      <img src={asset.dataUrl} alt={`由 ${asset.model} 创建的源图候选`} />
                    </a>
                    <div className="result-meta">
                      <div className="result-title">
                        <strong>{asset.provider === "local" ? "本地上传" : asset.model}</strong>
                        {confirmed && <span className="badge success">当前源图</span>}
                      </div>
                      <small>
                        {asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ""}
                        {asset.effectiveParameters.quality} · {new Date(asset.createdAt).toLocaleString()}
                      </small>
                      {asset.promptSnapshot.userPrompt && <p title={asset.promptSnapshot.compiledPrompt}>{asset.promptSnapshot.userPrompt}</p>}
                      <details>
                        <summary>查看生成元数据</summary>
                        <small>
                          任务：{asset.jobId}<br />
                          模式：{asset.mode}<br />
                          规格：{asset.effectiveParameters.providerSize}<br />
                          模板：v{asset.promptSnapshot.templateVersion}
                        </small>
                        {asset.promptSnapshot.compiledPrompt && <pre>{asset.promptSnapshot.compiledPrompt}</pre>}
                      </details>
                    </div>
                    <div className="button-row card-actions">
                      <button className="button primary" type="button" onClick={() => confirmSource(asset.id)} disabled={confirmed}>
                        {confirmed ? "已确认" : "确认为源图"}
                      </button>
                      <a
                        className="button"
                        href={asset.dataUrl}
                        download={`gif-craft-${asset.id}.${fileExtension(asset.mimeType)}`}
                      >
                        下载
                      </a>
                      <button className="button" type="button" onClick={() => reuseAsset(asset)}>
                        复用参数
                      </button>
                      <button className="button danger" type="button" onClick={() => void removeSourceImage(asset.id)}>
                        删除记录
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
