import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  WorkspaceConflictError,
  type EligibleJobView,
  type FrameDecisionView,
  type FrameWorkspaceAdapter,
  type ReadinessView,
  type SaveState,
  type SnapshotView,
  type WorkspaceCommand,
  type WorkspaceFilter,
  type WorkspaceFrameView,
  type WorkspaceView,
} from "./workspaceAdapter";

type LoadState = "loading" | "select_job" | "ready" | "error";

interface FrameWorkspaceContextValue {
  loadState: LoadState;
  loadError: string;
  jobs: EligibleJobView[];
  workspace: WorkspaceView | null;
  visibleFrames: WorkspaceFrameView[];
  activeFrames: WorkspaceFrameView[];
  selectedFrame: WorkspaceFrameView | null;
  selectedId: string | null;
  filter: WorkspaceFilter;
  saveState: SaveState;
  saveError: string;
  readiness: ReadinessView | null;
  snapshot: SnapshotView | null;
  retryActionFrameId: string | null;
  retryActionError: string;
  setFilter: (filter: WorkspaceFilter) => void;
  selectFrame: (frameId: string) => void;
  chooseJob: (jobId: string) => void;
  decide: (frameId: string, decision: FrameDecisionView) => void;
  restore: (frameId: string) => void;
  move: (frameId: string, targetIndex: number) => void;
  setFrameRate: (frameRate: number) => void;
  reloadLatest: () => Promise<void>;
  retrySave: () => void;
  createSnapshot: () => Promise<void>;
  retryCapability: (frame: WorkspaceFrameView) => string;
  requestRetry: (frameId: string) => Promise<void>;
  acceptCandidate: (frameId: string) => Promise<void>;
  discardCandidate: (frameId: string) => Promise<void>;
  restoreOriginal: (frameId: string) => Promise<void>;
  abandonRetryTracking: (frameId: string) => Promise<void>;
}

const FrameWorkspaceContext = createContext<FrameWorkspaceContextValue | null>(null);

export function FrameWorkspaceProvider({
  children,
  adapter,
  jobId,
  onChooseJob,
  autosaveDelayMs = 450,
}: PropsWithChildren<{
  adapter: FrameWorkspaceAdapter;
  jobId: string | null;
  onChooseJob: (jobId: string) => void;
  autosaveDelayMs?: number;
}>) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [jobs, setJobs] = useState<EligibleJobView[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const workspaceRef = useRef<WorkspaceView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorkspaceFilter>("all");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [retryActionFrameId, setRetryActionFrameId] = useState<string | null>(null);
  const [retryActionError, setRetryActionError] = useState("");
  const saveQueue = useRef<WorkspaceView[]>([]);
  const persistedRevision = useRef(0);
  const savingRef = useRef(false);

  const assignWorkspace = useCallback((next: WorkspaceView | null) => {
    workspaceRef.current = next;
    setWorkspace(next);
  }, []);

  const load = useCallback(async () => {
    setLoadState("loading");
    setLoadError("");
    setSnapshot(null);
    try {
      if (!jobId) {
        const available = await adapter.listEligibleJobs();
        setJobs(available);
        assignWorkspace(null);
        setLoadState("select_job");
        return;
      }
      const next = await adapter.loadOrCreate(jobId);
      saveQueue.current = [];
      persistedRevision.current = next.persistedRevision;
      assignWorkspace(next);
      setSelectedId((current) => next.frames.some((frame) => frame.id === current) ? current : next.frames.find((frame) => frame.decision !== "removed")?.id ?? next.frames[0]?.id ?? null);
      setSaveState("saved");
      setLoadState("ready");
    } catch (error) {
      assignWorkspace(null);
      setLoadError(error instanceof Error ? error.message : "无法打开序列帧工作区。");
      setLoadState("error");
    }
  }, [adapter, assignWorkspace, jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runCommand = useCallback((command: WorkspaceCommand) => {
    const current = workspaceRef.current;
    if (!current || saveState === "conflict") return;
    try {
      const next = adapter.apply(current, command);
      if (next === current) return;
      const queued = saveQueue.current.at(-1);
      if (queued?.revision === next.revision) saveQueue.current[saveQueue.current.length - 1] = next;
      else saveQueue.current.push(next);
      assignWorkspace(next);
      setSaveState("dirty");
      setSaveError("");
      setSnapshot(null);
    } catch (error) {
      setSaveState("failed");
      setSaveError(error instanceof Error ? error.message : "无法应用编辑动作。");
    }
  }, [adapter, assignWorkspace, saveState]);

  const drainSaves = useCallback(async () => {
    if (savingRef.current || saveQueue.current.length === 0) return;
    savingRef.current = true;
    setSaveState("saving");
    try {
      while (saveQueue.current.length > 0) {
        const captured = saveQueue.current[0];
        const saved = await adapter.save(captured, persistedRevision.current);
        if (saveQueue.current[0] === captured) saveQueue.current.shift();
        persistedRevision.current = saved.persistedRevision;
        setWorkspace((current) => {
          if (!current) return saved;
          if (current.revision === saved.revision) {
            workspaceRef.current = saved;
            return saved;
          }
          const rebased = { ...current, persistedRevision: saved.persistedRevision, updatedAt: saved.updatedAt };
          workspaceRef.current = rebased;
          return rebased;
        });
      }
      setSaveState("saved");
      setSaveError("");
    } catch (error) {
      if (error instanceof WorkspaceConflictError || (error as { name?: string })?.name === "FrameWorkspaceRevisionConflictError") {
        setSaveState("conflict");
        setSaveError("工作区已在另一个页面更新。本页修改尚未覆盖远端版本，请重新加载最新状态。");
      } else {
        setSaveState("failed");
        setSaveError(error instanceof Error ? error.message : "自动保存失败。");
      }
    } finally {
      savingRef.current = false;
    }
  }, [adapter]);

  useEffect(() => {
    if (saveState !== "dirty" || !workspace || savingRef.current) return;
    const timer = window.setTimeout(() => void drainSaves(), autosaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [autosaveDelayMs, drainSaves, saveState, workspace]);

  useEffect(() => {
    const flush = () => {
      if (saveQueue.current.length > 0) void drainSaves();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
    };
  }, [drainSaves]);

  const reloadLatest = useCallback(async () => {
    if (!jobId) return;
    setSaveState("saving");
    try {
      const latest = await adapter.loadOrCreate(jobId);
      saveQueue.current = [];
      persistedRevision.current = latest.persistedRevision;
      assignWorkspace(latest);
      setSelectedId(latest.frames.find((frame) => frame.decision !== "removed")?.id ?? latest.frames[0]?.id ?? null);
      setSaveState("saved");
      setSaveError("");
    } catch (error) {
      setSaveState("failed");
      setSaveError(error instanceof Error ? error.message : "无法重新加载工作区。");
    }
  }, [adapter, assignWorkspace, jobId]);

  const decide = useCallback((frameId: string, decision: FrameDecisionView) => {
    const current = workspaceRef.current;
    const included = current?.frames.filter((frame) => frame.decision !== "removed") ?? [];
    const currentIndex = included.findIndex((frame) => frame.id === frameId);
    runCommand({ type: "set_decision", frameId, decision });
    if (decision === "removed" && selectedId === frameId) {
      setSelectedId(included[currentIndex + 1]?.id ?? included[currentIndex - 1]?.id ?? null);
    }
  }, [runCommand, selectedId]);

  const readiness = useMemo(() => workspace ? adapter.checkReadiness(workspace) : null, [adapter, workspace]);
  const visibleFrames = useMemo(() => workspace?.frames.filter((frame) => filter === "all" || frame.decision === filter) ?? [], [filter, workspace]);
  const activeFrames = useMemo(() => workspace?.frames.filter((frame) => frame.decision !== "removed") ?? [], [workspace]);
  const selectedFrame = workspace?.frames.find((frame) => frame.id === selectedId) ?? null;

  const changeFilter = useCallback((nextFilter: WorkspaceFilter) => {
    setFilter(nextFilter);
    const current = workspaceRef.current;
    if (!current) return;
    const matches = current.frames.filter((frame) => nextFilter === "all" || frame.decision === nextFilter);
    if (!matches.some((frame) => frame.id === selectedId)) setSelectedId(matches[0]?.id ?? null);
  }, [selectedId]);

  const createSnapshot = useCallback(async () => {
    const current = workspaceRef.current;
    if (!current || !adapter.checkReadiness(current).ready || saveState !== "saved") return;
    setSaveError("");
    try {
      setSnapshot(await adapter.createSnapshot(current));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "无法生成工作区快照。");
    }
  }, [adapter, saveState]);

  const runRetryAction = useCallback(async (
    action: "requestRetry" | "acceptCandidate" | "discardCandidate" | "restoreOriginal" | "abandonRetryTracking",
    frameId: string,
  ) => {
    if (retryActionFrameId || saveState !== "saved") return;
    const current = workspaceRef.current;
    if (!current) return;
    setRetryActionFrameId(frameId);
    setRetryActionError("");
    try {
      const next = await adapter[action](current, frameId);
      saveQueue.current = [];
      persistedRevision.current = next.persistedRevision;
      assignWorkspace(next);
      setSaveState("saved");
      setSnapshot(null);
    } catch (error) {
      const recovered = (error as { workspaceView?: WorkspaceView })?.workspaceView;
      if (recovered) {
        persistedRevision.current = recovered.persistedRevision;
        assignWorkspace(recovered);
      }
      if (error instanceof WorkspaceConflictError || (error as { name?: string })?.name === "FrameWorkspaceRevisionConflictError") {
        setSaveState("conflict");
        setSaveError("工作区已在另一个页面更新。重试操作没有覆盖最新版本，请重新加载。");
      }
      setRetryActionError(error instanceof Error ? error.message : "指定帧重试操作失败。");
    } finally {
      setRetryActionFrameId(null);
    }
  }, [adapter, assignWorkspace, retryActionFrameId, saveState]);

  const value = useMemo<FrameWorkspaceContextValue>(() => ({
    loadState,
    loadError,
    jobs,
    workspace,
    visibleFrames,
    activeFrames,
    selectedFrame,
    selectedId,
    filter,
    saveState,
    saveError,
    readiness,
    snapshot,
    retryActionFrameId,
    retryActionError,
    setFilter: changeFilter,
    selectFrame: setSelectedId,
    chooseJob: onChooseJob,
    decide,
    restore: (frameId) => runCommand({ type: "restore", frameId }),
    move: (frameId, targetIndex) => runCommand({ type: "move", frameId, targetIndex }),
    setFrameRate: (frameRate) => runCommand({ type: "set_frame_rate", frameRate }),
    reloadLatest,
    retrySave: () => {
      if (saveQueue.current.length > 0) setSaveState("dirty");
    },
    createSnapshot,
    retryCapability: adapter.describeRetryCapability,
    requestRetry: (frameId) => runRetryAction("requestRetry", frameId),
    acceptCandidate: (frameId) => runRetryAction("acceptCandidate", frameId),
    discardCandidate: (frameId) => runRetryAction("discardCandidate", frameId),
    restoreOriginal: (frameId) => runRetryAction("restoreOriginal", frameId),
    abandonRetryTracking: (frameId) => runRetryAction("abandonRetryTracking", frameId),
  }), [activeFrames, adapter.describeRetryCapability, changeFilter, createSnapshot, decide, filter, jobs, loadError, loadState, onChooseJob, readiness, reloadLatest, retryActionError, retryActionFrameId, runCommand, runRetryAction, saveError, saveState, selectedFrame, selectedId, snapshot, visibleFrames, workspace]);

  return <FrameWorkspaceContext.Provider value={value}>{children}</FrameWorkspaceContext.Provider>;
}

export function useFrameWorkspace() {
  const context = useContext(FrameWorkspaceContext);
  if (!context) throw new Error("useFrameWorkspace 必须在 FrameWorkspaceProvider 内使用。");
  return context;
}
