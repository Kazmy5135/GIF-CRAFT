import { useEffect, useState } from "react";
import {
  BUILT_IN_BASE_PROMPT,
  BUILT_IN_NEGATIVE_PROMPT,
  BUILT_IN_PROMPT_VERSION,
} from "../../core/promptTemplates";
import { useSourceImages } from "../source-image/SourceImageContext";

export function SettingsPage() {
  const {
    providers,
    providersLoading,
    refreshProviders,
    promptSettings,
    updatePromptSettings,
    resetPromptSettings,
  } = useSourceImages();
  const [basePrompt, setBasePrompt] = useState(promptSettings.basePrompt);
  const [negativePrompt, setNegativePrompt] = useState(promptSettings.negativePrompt);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBasePrompt(promptSettings.basePrompt);
    setNegativePrompt(promptSettings.negativePrompt);
  }, [promptSettings]);

  function saveTemplates() {
    updatePromptSettings({
      basePrompt,
      negativePrompt,
      version: promptSettings.version + 1,
    });
    setSaved(true);
  }

  function resetTemplates() {
    resetPromptSettings();
    setSaved(false);
  }

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>设置</h1>
        <p>API 通过服务端代理调用，密钥不会发送到 H5 页面。</p>
      </header>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>API 服务状态</h2>
            <p>在服务端 `.env` 中配置密钥，然后刷新状态。</p>
          </div>
          <button className="button" onClick={() => void refreshProviders()}>
            刷新状态
          </button>
        </div>
        {providersLoading ? (
          <p>正在读取服务状态…</p>
        ) : (
          <div className="provider-grid">
            {providers.map((provider) => (
              <article className="provider-card" key={provider.id}>
                <h3>{provider.name}</h3>
                <dl>
                  <div>
                    <dt>模型</dt>
                    <dd>{provider.model}</dd>
                  </div>
                  <div>
                    <dt>代理配置</dt>
                    <dd className={provider.configured ? "status-ok" : "status-warning"}>
                      {provider.configured ? "已配置" : "未配置"}
                    </dd>
                  </div>
                  <div>
                    <dt>文生图 / 图生图</dt>
                    <dd>支持 / 支持</dd>
                  </div>
                  <div>
                    <dt>透明背景</dt>
                    <dd>{provider.supportsTransparentBackground ? "支持" : "不支持"}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>基础提示词模板</h2>
            <p>
              内置版本 v{BUILT_IN_PROMPT_VERSION} 保持不变；保存会创建新的本地覆盖版本。
            </p>
          </div>
          <span className="badge">当前覆盖 v{promptSettings.version}</span>
        </div>

        <label className="field">
          <span>基础提示词</span>
          <textarea rows={6} value={basePrompt} onChange={(event) => setBasePrompt(event.target.value)} />
        </label>
        <label className="field">
          <span>负向约束</span>
          <textarea
            rows={5}
            value={negativePrompt}
            onChange={(event) => setNegativePrompt(event.target.value)}
          />
        </label>
        <div className="button-row">
          <button className="button primary" onClick={saveTemplates} disabled={!basePrompt.trim()}>
            保存覆盖版本
          </button>
          <button className="button" onClick={resetTemplates}>
            重置为内置模板
          </button>
          {saved && <span className="status-ok">已保存</span>}
        </div>

        <details className="template-details">
          <summary>查看内置模板</summary>
          <h3>基础提示词</h3>
          <pre>{BUILT_IN_BASE_PROMPT}</pre>
          <h3>负向约束</h3>
          <pre>{BUILT_IN_NEGATIVE_PROMPT}</pre>
        </details>
      </section>
    </main>
  );
}
