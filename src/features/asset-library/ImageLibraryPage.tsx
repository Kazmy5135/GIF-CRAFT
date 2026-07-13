import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSourceImages } from "../source-image/SourceImageContext";
import {
  buildSourceImageLibraryItems,
  filterSourceImageLibraryItems,
  sourceAvailabilityLabels,
  type SourceImageLibraryFilter,
} from "./readModels";

export interface ImageLibraryPageProps {
  onUseSource?: (sourceId: string) => void;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function ImageLibraryPage({ onUseSource }: ImageLibraryPageProps = {}) {
  const navigate = useNavigate();
  const {
    history,
    historyLoading,
    currentSourceId,
    taskError,
    confirmSource,
    clearTaskError,
  } = useSourceImages();
  const [filter, setFilter] = useState<SourceImageLibraryFilter>("all");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmationError, setConfirmationError] = useState("");

  const items = useMemo(
    () => buildSourceImageLibraryItems(history, currentSourceId),
    [currentSourceId, history],
  );
  const visibleItems = useMemo(
    () => filterSourceImageLibraryItems(items, filter),
    [filter, items],
  );

  async function useSource(sourceId: string) {
    if (confirmingId) return;
    clearTaskError();
    setConfirmationError("");
    setConfirmingId(sourceId);
    try {
      await confirmSource(sourceId);
      if (onUseSource) onUseSource(sourceId);
      else navigate("/create/sequence");
    } catch (error) {
      setConfirmationError(
        error instanceof Error ? error.message : "源图确认失败，请检查资源后重试。",
      );
    } finally {
      setConfirmingId(null);
    }
  }

  return (
    <main className="page-content asset-library-page">
      <header className="page-header section-heading">
        <div>
          <h1>图库</h1>
          <p>查看本地保存的生成图和上传图，确认后可创建新的序列帧 ID。</p>
        </div>
        <Link className="button primary" to="/create">
          新生成
        </Link>
      </header>

      <section className="panel asset-library-toolbar" aria-label="图库筛选">
        <label className="field">
          <span>可用状态</span>
          <select
            aria-label="图库可用状态"
            value={filter}
            onChange={(event) => setFilter(event.target.value as SourceImageLibraryFilter)}
          >
            <option value="all">全部图片</option>
            <option value="available">可用</option>
            <option value="unconfirmed">待确认</option>
            <option value="unavailable">不可用</option>
          </select>
        </label>
        <p className="form-hint">共 {visibleItems.length} 张；图片原始数据只保存在本地。</p>
      </section>

      {(confirmationError || taskError) && (
        <div className="alert error" role="alert">
          {confirmationError || taskError}
        </div>
      )}

      {historyLoading ? (
        <section className="panel empty-state" aria-busy="true">
          <p>正在读取图库…</p>
        </section>
      ) : visibleItems.length === 0 ? (
        <section className="panel empty-state">
          <p>{history.length === 0 ? "图库还没有图片。" : "没有符合当前筛选的图片。"}</p>
          {history.length === 0 && (
            <Link className="button primary" to="/create">
              创建第一张图片
            </Link>
          )}
        </section>
      ) : (
        <section className="result-grid asset-library-grid" aria-label="图库图片">
          {visibleItems.map((item) => (
            <article
              className={`result-card${item.isCurrent ? " confirmed" : ""}`}
              key={item.asset.id}
            >
              <a href={item.asset.dataUrl} target="_blank" rel="noreferrer" aria-label="查看原图">
                <img
                  src={item.asset.dataUrl}
                  alt={item.asset.sourceName || `源图 ${item.asset.id}`}
                  loading="lazy"
                />
              </a>
              <div className="result-meta">
                <div className="result-title">
                  <strong>{item.asset.sourceName || item.asset.model}</strong>
                  <span className={`badge${item.availability === "available" ? " success" : ""}`}>
                    {sourceAvailabilityLabels[item.availability]}
                  </span>
                </div>
                <p>{item.sourceLabel}</p>
                <small>
                  {item.dimensionsLabel} · {item.asset.mimeType}
                </small>
                <small>创建于 {formatDate(item.asset.createdAt)}</small>
                {item.isCurrent && <small className="status-ok">当前新生成流程正在使用</small>}
                <details className="template-details">
                  <summary>查看记录</summary>
                  <dl className="parameter-summary">
                    <div><dt>图片 ID</dt><dd>{item.asset.id}</dd></div>
                    <div><dt>生成记录</dt><dd>{item.asset.jobId}</dd></div>
                    <div><dt>规格</dt><dd>{item.asset.effectiveParameters.aspectRatio} · {item.asset.effectiveParameters.quality}</dd></div>
                  </dl>
                </details>
              </div>
              <div className="card-actions button-row">
                <button
                  className="button primary"
                  type="button"
                  disabled={Boolean(confirmingId)}
                  onClick={() => void useSource(item.asset.id)}
                >
                  {confirmingId === item.asset.id
                    ? "正在确认…"
                    : item.availability === "available"
                      ? "使用此图创建序列"
                      : "确认并创建序列"}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
