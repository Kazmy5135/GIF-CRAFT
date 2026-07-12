import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { FrameWorkspaceRoute } from "../features/frame-workspace";
import { ImagePage } from "../features/source-image/ImagePage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { SequencePage } from "../features/sequence/SequencePage";
import { ErrorBoundary } from "./ErrorBoundary";

const tabs = [
  { to: "/image", label: "生图" },
  { to: "/sequence", label: "生成序列帧" },
  { to: "/frames", label: "序列帧工作区" },
  { to: "/settings", label: "设置" },
];

export function App() {
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
        </nav>
      </aside>
      <section className="page-shell">
        <ErrorBoundary>
          <Routes>
            <Route path="/image" element={<ImagePage />} />
            <Route path="/sequence" element={<SequencePage />} />
            <Route path="/frames" element={<FrameWorkspaceRoute />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/" element={<Navigate to="/image" replace />} />
            <Route path="*" element={<Navigate to="/image" replace />} />
          </Routes>
        </ErrorBoundary>
      </section>
    </div>
  );
}
