import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  normalizePngZipExportError,
  type PngZipExportError,
} from "../../core/export";
import {
  createPngZipArchive,
  downloadPngZipArchive,
  loadPngZipExportSource,
  type PngZipExportArchive,
  type PngZipExportSource,
} from "./pngZipExportService";

export type ExportPageState =
  | { readonly status: "loading" }
  | {
      readonly status: "error";
      readonly stage: "loading" | "exporting";
      readonly error: PngZipExportError;
      readonly source?: PngZipExportSource;
    }
  | {
      readonly status: "ready";
      readonly source: PngZipExportSource;
      readonly downloadedFileName?: string;
    }
  | { readonly status: "exporting"; readonly source: PngZipExportSource };

export interface ExportPageProps {
  /** Tests and embedded callers may provide an ID; the route normally supplies it. */
  readonly snapshotId?: string;
  readonly loadSource?: (snapshotId: string) => Promise<PngZipExportSource>;
  readonly createArchive?: (source: PngZipExportSource) => Promise<PngZipExportArchive>;
  readonly downloadArchive?: (archive: PngZipExportArchive) => void;
}

export function ExportPage({
  snapshotId: explicitSnapshotId,
  loadSource = loadPngZipExportSource,
  createArchive = createPngZipArchive,
  downloadArchive = downloadPngZipArchive,
}: ExportPageProps = {}) {
  const route = useParams<{ snapshotId: string }>();
  const snapshotId = explicitSnapshotId ?? route.snapshotId ?? "";
  const [reloadVersion, setReloadVersion] = useState(0);
  const [state, setState] = useState<ExportPageState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void loadSource(snapshotId).then(
      (source) => {
        if (!cancelled) setState({ status: "ready", source });
      },
      (error) => {
        if (!cancelled) {
          setState({
            status: "error",
            stage: "loading",
            error: normalizePngZipExportError(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadSource, reloadVersion, snapshotId]);

  const runExport = useCallback(
    async (source: PngZipExportSource) => {
      setState({ status: "exporting", source });
      try {
        const archive = await createArchive(source);
        downloadArchive(archive);
        setState({
          status: "ready",
          source,
          downloadedFileName: archive.fileName,
        });
      } catch (error) {
        setState({
          status: "error",
          stage: "exporting",
          error: normalizePngZipExportError(error),
          source,
        });
      }
    },
    [createArchive, downloadArchive],
  );

  if (state.status === "loading") {
    return (
      <main className="page-content" aria-busy="true">
        <header className="page-header">
          <h1>导出 PNG ZIP</h1>
          <p>正在读取不可变工作区快照并校验帧资源……</p>
        </header>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="page-content">
        <header className="page-header">
          <h1>导出 PNG ZIP</h1>
          <p>导出未完成，已有工作区和快照不会被修改。</p>
        </header>
        <section className="panel">
          <div className="alert error" role="alert">
            <strong>{state.stage === "loading" ? "无法准备导出" : "导出失败"}</strong>
            <p>{state.error.message}</p>
          </div>
          <div className="button-row">
            {state.error.recoverable && (
              <button
                className="button primary"
                type="button"
                onClick={() => {
                  if (state.source) void runExport(state.source);
                  else setReloadVersion((value) => value + 1);
                }}
              >
                {state.stage === "loading" ? "重新加载" : "重试导出"}
              </button>
            )}
            <Link className="button" to="/library/sequences">
              返回序列帧库
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const source = state.source;
  return (
    <main className="page-content" aria-busy={state.status === "exporting"}>
      <header className="page-header">
        <h1>导出 PNG ZIP</h1>
        <p>从不可变快照生成连续编号 PNG 与可复现清单。</p>
      </header>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>导出快照</h2>
            <p>{source.snapshot.snapshotId}</p>
          </div>
          <span className="badge">{source.manifest.frames.length} 帧</span>
        </div>
        <dl className="parameter-summary">
          <div>
            <dt>序列帧 ID</dt>
            <dd>{source.manifest.sequenceId}</dd>
          </div>
          <div>
            <dt>工作区修订</dt>
            <dd>{source.manifest.revision}</dd>
          </div>
          <div>
            <dt>播放参数</dt>
            <dd>
              {source.manifest.frameRate} FPS · {source.manifest.loopMode === "loop" ? "循环" : "单次"}
            </dd>
          </div>
          <div>
            <dt>画布</dt>
            <dd>
              {source.manifest.canvas.width} × {source.manifest.canvas.height} · {source.manifest.canvas.aspectRatio}
            </dd>
          </div>
        </dl>
        <p>
          ZIP 包含 {source.manifest.frames[0]?.fileName} 至{" "}
          {source.manifest.frames.at(-1)?.fileName}，以及 manifest.json。
        </p>
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            disabled={state.status === "exporting"}
            onClick={() => void runExport(source)}
          >
            {state.status === "exporting" ? "正在生成 PNG ZIP……" : "下载 PNG ZIP"}
          </button>
          <Link className="button" to={`/workspace/${encodeURIComponent(source.manifest.sourceJobId)}`}>
            返回工作区
          </Link>
        </div>
        {state.status === "ready" && state.downloadedFileName && (
          <p className="status-ok" role="status">
            已开始下载 {state.downloadedFileName}。
          </p>
        )}
      </section>
    </main>
  );
}
