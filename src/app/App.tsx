import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ImageLibraryPage, SequenceLibraryPage } from "../features/asset-library";
import { ExportPage } from "../features/export";
import { FrameWorkspaceRoute } from "../features/frame-workspace";
import { ImagePage } from "../features/source-image/ImagePage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { SequencePage } from "../features/sequence/SequencePage";
import { ErrorBoundary } from "./ErrorBoundary";

const tabs = [
  { to: "/create", label: "新生成" },
  { to: "/library", label: "库存" },
  { to: "/settings", label: "设置" },
];

export function App() {
  const location = useLocation();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>GIF CRAFT</strong>
          <span>序列帧生产工具</span>
        </div>
        <nav aria-label="主要功能">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) => `nav-tab${isActive ? " active" : ""}`}
            >
              {tab.label}
            </NavLink>
          ))}
          {location.pathname.startsWith("/create") && (
            <div className="nav-subtabs" aria-label="新生成步骤">
              <NavLink end to="/create">1 静态图</NavLink>
              <NavLink to="/create/sequence">2 序列生成</NavLink>
            </div>
          )}
          {location.pathname.startsWith("/library") && (
            <div className="nav-subtabs" aria-label="库存分类">
              <NavLink to="/library/images">图库</NavLink>
              <NavLink to="/library/sequences">序列帧库</NavLink>
            </div>
          )}
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
