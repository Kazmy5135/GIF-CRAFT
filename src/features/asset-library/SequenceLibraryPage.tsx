import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GenerationJob } from "../../core/sequenceGeneration";
import {
  listGenerationJobs,
  type StoredGenerationJob,
} from "../../infrastructure/storage/sequenceJobRepository";
import { useSourceImages } from "../source-image/SourceImageContext";
import {
  allSequenceStatuses,
  buildSequenceLibraryItems,
  filterSequenceLibraryItems,
  sequenceResourceStatusLabels,
  sequenceStatusLabels,
  type SequenceLibraryFilter,
} from "./readModels";

export interface SequenceLibraryDependencies {
  listJobs: typeof listGenerationJobs;
}

export interface SequenceLibraryPageProps {
  dependencies?: Partial<SequenceLibraryDependencies>;
  onOpenWorkspace?: (jobId: string) => void;
  onRedo?: (sourceId: string, jobId: string) => void;
}

const defaultDependencies: SequenceLibraryDependencies = {
  listJobs: listGenerationJobs,
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function SequenceLibraryPage({
  dependencies,
  onOpenWorkspace,
  onRedo,
}: SequenceLibraryPageProps = {}) {
  const navigate = useNavigate();
  const deps = useMemo(() => ({ ...defaultDependencies, ...dependencies }), [dependencies]);
  const { history: sources, historyLoading: sourcesLoading } = useSourceImages();
  const [records, setRecords] = useState<StoredGenerationJob<GenerationJob>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<SequenceLibraryFilter>("usable");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRecords(await deps.listJobs<GenerationJob>());
    } catch (loadError) {
      setRecords([]);
      setError(loadError instanceof Error ? loadError.message : "无法读取序列帧库。");
    } finally {
      setLoading(false);
    }
  }, [deps]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(
    () => buildSequenceLibraryItems(records, sources),
    [records, sources],
  );
  const visibleItems = useMemo(
    () => filterSequenceLibraryItems(items, filter),
    [filter, items],
  );

  function openWorkspace(jobId: string) {
    if (onOpenWorkspace) onOpenWorkspace(jobId);
    else navigate(`/workspace/${encodeURIComponent(jobId)}`);
  }

  function redo(sourceId: string, jobId: string) {
    if (onRedo) {
      onRedo(sourceId, jobId);
      return;
    }
    const query = new URLSearchParams({ sourceId, redoOf: jobId });
    navigate(`/create?${query.toString()}`);
  }

  return (
    <main className="page-content asset-library-page">
      <header className="page-header section-heading">
        <div>
          <h1>序列帧库</h1>
          <p>按序列 ID 查看任务、来源和本地资源状态。</p>
        </div>
        <button className="button" type="button" disabled={loading} onClick={() => void load()}>
          {loading ? "读取中…" : "刷新"}
        </button>
      </header>

      <section className="panel asset-library-toolbar" aria-label="序列帧库筛选">
        <label className="field">
          <span>任务状态</span>
          <select
            aria-label="序列任务状态"
            value={filter}
            onChange={(event) => setFilter(event.target.value as SequenceLibraryFilter)}
          >
            <option value="usable">成功且资源可用</option>
            <option value="all">全部任务</option>
            {allSequenceStatuses.map((status) => (
              <option key={status} value={status}>{sequenceStatusLabels[status]}</option>
            ))}
          </select>
        </label>
        <p className="form-hint">显示 {visibleItems.length} / {items.length} 条序列记录。</p>
      </section>

      {error && <div className="alert error" role="alert">{error}</div>}

      {loading || sourcesLoading ? (
        <section className="panel empty-state" aria-busy="true">
          <p>正在读取序列帧库…</p>
        </section>
      ) : error ? null : visibleItems.length === 0 ? (
        <section className="panel empty-state">
          <p>{items.length === 0 ? "还没有序列任务。" : "没有符合当前筛选的序列。"}</p>
        </section>
      ) : (
        <section className="sequence-library-list" aria-label="序列帧记录">
          {visibleItems.map((item) => {
            const parameters = item.job.request.effectiveParameters;
            return (
              <article className="panel sequence-library-card" key={item.job.id}>
                <div className="sequence-library-source">
                  {item.source?.dataUrl ? (
                    <img
                      src={item.source.dataUrl}
                      alt={item.source.sourceName || `序列 ${item.job.id} 的来源图`}
                      loading="lazy"
                    />
                  ) : (
                    <div className="sequence-library-source-missing">来源图缺失</div>
                  )}
                </div>
                <div className="sequence-library-summary">
                  <div className="section-heading">
                    <div>
                      <h2>{item.presetLabel}</h2>
                      <p>序列 ID：{item.job.id}</p>
                    </div>
                    <span className={`badge${item.usable ? " success" : ""}`}>
                      {sequenceStatusLabels[item.job.status]}
                    </span>
                  </div>
                  <dl className="parameter-summary">
                    <div><dt>来源图</dt><dd>{item.source?.sourceName || item.job.request.source.id}</dd></div>
                    <div><dt>预设</dt><dd>{item.presetLabel}</dd></div>
                    <div><dt>帧数</dt><dd>{parameters.frameCount} 帧</dd></div>
                    <div><dt>帧率</dt><dd>{parameters.frameRate} FPS</dd></div>
                    <div><dt>资源状态</dt><dd>{sequenceResourceStatusLabels[item.resourceStatus]}</dd></div>
                    <div><dt>更新时间</dt><dd><time dateTime={item.record.updatedAt}>{formatDate(item.record.updatedAt)}</time></dd></div>
                  </dl>
                </div>
                <div className="button-row sequence-library-actions">
                  <button
                    className="button primary"
                    type="button"
                    disabled={!item.usable}
                    title={item.usable ? "打开序列帧工作区" : "只有完整且本地资源可用的序列能进入工作区"}
                    onClick={() => openWorkspace(item.job.id)}
                  >
                    进入工作区
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={!item.sourceAvailable}
                    title={item.sourceAvailable ? "使用同一来源图创建新的序列 ID" : "来源图不可用，不能重做"}
                    onClick={() => redo(item.job.request.source.id, item.job.id)}
                  >
                    整序列重做
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
