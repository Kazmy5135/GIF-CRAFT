import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { ImageLibraryPage, SequenceLibraryPage } from "../features/asset-library";
import { ExportPage } from "../features/export";
import { FrameWorkspaceRoute } from "../features/frame-workspace";
import { ImagePage } from "../features/source-image/ImagePage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { SequencePage } from "../features/sequence/SequencePage";
import { ErrorBoundary } from "./ErrorBoundary";

export function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>GIF CRAFT</strong>
          <span>序列帧生产工具</span>
        </div>
        <nav aria-label="主要功能">
          <div className="nav-group">
            <NavLink
              to="/create"
              className={({ isActive }) => `nav-tab${isActive ? " active" : ""}`}
            >
              新生成
            </NavLink>
            <div className="nav-subtabs" aria-label="新生成二级功能">
              <NavLink end to="/create">静态图生成</NavLink>
              <NavLink to="/create/sequence">序列帧生成</NavLink>
            </div>
          </div>
          <div className="nav-group">
            <NavLink
              to="/library"
              className={({ isActive }) => `nav-tab${isActive ? " active" : ""}`}
            >
              库存
            </NavLink>
            <div className="nav-subtabs" aria-label="库存二级功能">
              <NavLink to="/library/images">图库</NavLink>
              <NavLink to="/library/sequences">序列帧库</NavLink>
            </div>
          </div>
          <NavLink
            to="/settings"
            className={({ isActive }) => `nav-tab${isActive ? " active" : ""}`}
          >
            设置
          </NavLink>
        </nav>
      </aside>
      <section className="page-shell">
        <ErrorBoundary>
          <Routes>
            <Route path="/create" element={<ImagePage />} />
            <Route path="/create/sequence" element={<SequencePage />} />
            <Route path="/library" element={<Navigate to="/library/images" replace />} />
            <Route path="/library/images" element={<ImageLibraryPage />} />
            <Route path="/library/sequences" element={<SequenceLibraryPage />} />
            <Route path="/workspace/:jobId" element={<FrameWorkspaceRoute />} />
            <Route path="/export/:snapshotId" element={<ExportPage />} />
            <Route path="/image" element={<Navigate to="/create" replace />} />
            <Route path="/sequence" element={<Navigate to="/create/sequence" replace />} />
            <Route path="/frames" element={<FrameWorkspaceRoute />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/" element={<Navigate to="/create" replace />} />
            <Route path="*" element={<Navigate to="/create" replace />} />
          </Routes>
        </ErrorBoundary>
      </section>
    </div>
  );
}
