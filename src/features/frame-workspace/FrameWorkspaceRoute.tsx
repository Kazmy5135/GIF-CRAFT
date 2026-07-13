import { useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { FrameWorkspaceProvider } from "./FrameWorkspaceContext";
import { FrameWorkspacePage } from "./FrameWorkspacePage";
import { createDefaultWorkspaceAdapter } from "./defaultWorkspaceAdapter";

export function FrameWorkspaceRoute() {
  const [searchParams] = useSearchParams();
  const { jobId: routeJobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const adapter = useMemo(() => createDefaultWorkspaceAdapter(), []);
  const jobId = routeJobId?.trim() || searchParams.get("jobId")?.trim() || null;
  return (
    <FrameWorkspaceProvider
      adapter={adapter}
      jobId={jobId}
      onChooseJob={(nextJobId) => navigate(`/workspace/${encodeURIComponent(nextJobId)}`)}
    >
      <FrameWorkspacePage />
    </FrameWorkspaceProvider>
  );
}
