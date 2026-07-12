import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FrameWorkspaceProvider } from "./FrameWorkspaceContext";
import { FrameWorkspacePage } from "./FrameWorkspacePage";
import { createDefaultWorkspaceAdapter } from "./defaultWorkspaceAdapter";

export function FrameWorkspaceRoute() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const adapter = useMemo(() => createDefaultWorkspaceAdapter(), []);
  const jobId = searchParams.get("jobId")?.trim() || null;
  return (
    <FrameWorkspaceProvider
      adapter={adapter}
      jobId={jobId}
      onChooseJob={(nextJobId) => navigate(`/frames?jobId=${encodeURIComponent(nextJobId)}`)}
    >
      <FrameWorkspacePage />
    </FrameWorkspaceProvider>
  );
}
