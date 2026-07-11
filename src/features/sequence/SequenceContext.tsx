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
  canTransitionGenerationJob,
  createRetryChildJob,
  transitionGenerationJob,
  validateSequenceResult,
  type Frame,
  type GenerationJob,
  type SequenceGenerationError,
  type SequenceGenerationRequest,
} from "../../core/sequenceGeneration";
import {
  fetchSequenceJob,
  fetchSequenceProviders,
  fetchSequenceResult,
  SequenceApiError,
  submitSequenceJob,
  type SequenceProviderCapabilitySummary,
} from "../../infrastructure/api/sequenceApi";
import {
  checkSequenceStorageCapacity,
  cleanupSequenceStorage,
  frameResourceStorageRecord,
  generationJobStorageRecord,
  listFrameResources,
  listGenerationJobs,
  saveCompletedGenerationResult,
  saveGenerationJob,
  type StoredFrameResource,
  type StoredGenerationJob,
} from "../../infrastructure/storage/sequenceJobRepository";
import { getSourceImage } from "../../infrastructure/storage/sourceImageRepository";

const activeStatuses = new Set(["submitting", "queued", "generating", "processing"]);

export interface SequenceDependencies {
  fetchProviders: typeof fetchSequenceProviders;
  submitJob: typeof submitSequenceJob;
  fetchJob: typeof fetchSequenceJob;
  fetchResult: typeof fetchSequenceResult;
  listJobs: typeof listGenerationJobs;
  listFrames: typeof listFrameResources;
  saveJob: typeof saveGenerationJob;
  saveCompletedResult: typeof saveCompletedGenerationResult;
  checkCapacity: typeof checkSequenceStorageCapacity;
  cleanupStorage: typeof cleanupSequenceStorage;
  now: () => string;
  createId: () => string;
  pollIntervalMs: number;
  maxPollingWindowMs: number;
  hiddenPollMultiplier: number;
  random: () => number;
  materializeFrame: (frame: Frame) => Promise<{ frame: Frame; blob: Blob }>;
  getSourceImage: typeof getSourceImage;
}

async function defaultMaterializeFrame(frame: Frame): Promise<{ frame: Frame; blob: Blob }> {
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(frame.resourceRef)) {
    throw new Error("服务商结果没有提供可持久化的图片帧。" );
  }
  const response = await fetch(frame.resourceRef);
  const blob = await response.blob();
  if (blob.size !== frame.size || blob.type !== frame.mimeType) {
    throw new Error("帧资源字节与结果元数据不一致。" );
  }
  return {
    frame: { ...frame, resourceRef: `frame-resource:${frame.id}` },
    blob,
  };
}

const defaultDependencies: SequenceDependencies = {
  fetchProviders: fetchSequenceProviders,
  submitJob: submitSequenceJob,
  fetchJob: fetchSequenceJob,
  fetchResult: fetchSequenceResult,
  listJobs: listGenerationJobs,
  listFrames: listFrameResources,
  saveJob: saveGenerationJob,
  saveCompletedResult: saveCompletedGenerationResult,
  checkCapacity: checkSequenceStorageCapacity,
  cleanupStorage: cleanupSequenceStorage,
  now: () => new Date().toISOString(),
  createId: () => crypto.randomUUID(),
  pollIntervalMs: 1_500,
  maxPollingWindowMs: 15 * 60 * 1_000,
  hiddenPollMultiplier: 4,
  random: Math.random,
  materializeFrame: defaultMaterializeFrame,
  getSourceImage,
};

export interface SequenceContextValue {
  providers: SequenceProviderCapabilitySummary[];
  providersLoading: boolean;
  jobsLoading: boolean;
  currentJob: GenerationJob | null;
  frames: Frame[];
  resultStorageStatus: "available" | "purged" | "invalid" | null;
  submitting: boolean;
  reconciling: boolean;
  error: string;
  refreshProviders: () => Promise<void>;
  submit: (request: SequenceGenerationRequest, sourceImageDataUrl: string) => Promise<void>;
  retryFailed: () => Promise<void>;
  reconcile: () => Promise<void>;
  abandonTracking: () => Promise<void>;
  clearError: () => void;
}

export const SequenceContext = createContext<SequenceContextValue | null>(null);

function submittingJob(
  request: SequenceGenerationRequest,
  createdAt: string,
): GenerationJob {
  return {
    id: request.draftId,
    clientRequestId: request.clientRequestId,
    provider: request.provider,
    request,
    status: "submitting",
    progress: null,
    stage: "persisted_before_submit",
    timestamps: {
      createdAt,
      updatedAt: createdAt,
    },
    recovery: { canQuery: false, limitation: "等待代理任务收据" },
    retryCount: 0,
    frameIds: [],
    resultIntegrity: {
      status: "pending",
      expectedFrameCount: request.effectiveParameters.frameCount,
      actualFrameCount: 0,
      issues: [],
    },
  };
}

function sourceMatchesRequest(job: GenerationJob, source: Awaited<ReturnType<typeof getSourceImage>>): source is NonNullable<typeof source> {
  return Boolean(
    source &&
      source.id === job.request.source.id &&
      source.contentSnapshotId === job.request.source.contentSnapshotId &&
      source.dataUrl &&
      source.availability === "available",
  );
}

function restoredResultIsComplete(
  job: GenerationJob,
  resources: readonly StoredFrameResource<Frame>[],
  validatedAt: string,
): boolean {
  const ordered = [...resources].sort((left, right) => left.sequenceIndex - right.sequenceIndex);
  const frames = ordered.map((resource) => resource.frame);
  const integrity = validateSequenceResult(
    frames,
    job.request.effectiveParameters.frameCount,
    validatedAt,
    undefined,
    job.id,
  );
  return integrity.status === "complete" &&
    job.resultIntegrity.status === "complete" &&
    job.frameIds.length === ordered.length &&
    job.frameIds.every((id, index) => id === ordered[index]?.id) &&
    ordered.every((resource) =>
      resource.jobId === job.id &&
      resource.blob.size === resource.size &&
      resource.frame.size === resource.size &&
      resource.blob.type === resource.frame.mimeType,
    );
}

function apiDomainError(error: SequenceApiError): SequenceGenerationError {
  return {
    code: error.code === "status_unknown" ? "timeout_unknown" : error.code,
    message: error.message,
    retryable: error.retryable,
    recoveryAction: error.recoveryAction,
  };
}

export function SequenceProvider({
  children,
  dependencies,
}: PropsWithChildren<{ dependencies?: Partial<SequenceDependencies> }>) {
  const deps = useMemo(() => ({ ...defaultDependencies, ...dependencies }), [dependencies]);
  const [providers, setProviders] = useState<SequenceProviderCapabilitySummary[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [currentJob, setCurrentJob] = useState<GenerationJob | null>(null);
  const currentJobRef = useRef<GenerationJob | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [resultStorageStatus, setResultStorageStatus] = useState<"available" | "purged" | "invalid" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const reconcilingRef = useRef(false);
  const [reconciling, setReconciling] = useState(false);
  const jobEpochRef = useRef(0);
  const pollAttemptRef = useRef(0);
  const pollStartedAtRef = useRef<number | null>(null);
  const [pollTick, setPollTick] = useState(0);
  const providersRef = useRef<SequenceProviderCapabilitySummary[]>([]);
  const [error, setError] = useState("");

  const setJob = useCallback((job: GenerationJob | null) => {
    if (currentJobRef.current?.id !== job?.id) {
      jobEpochRef.current += 1;
      pollAttemptRef.current = 0;
      pollStartedAtRef.current = job ? Date.parse(job.timestamps.createdAt) : null;
    }
    currentJobRef.current = job;
    setCurrentJob(job);
  }, []);

  const persistJob = useCallback(
    async (job: GenerationJob) => {
      await deps.saveJob(generationJobStorageRecord(job));
      setJob(job);
    },
    [deps, setJob],
  );

  const refreshProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const nextProviders = await deps.fetchProviders();
      providersRef.current = nextProviders;
      setProviders(nextProviders);
    } catch (providerError) {
      setError(providerError instanceof Error ? providerError.message : "无法读取序列服务状态。" );
    } finally {
      setProvidersLoading(false);
    }
  }, [deps]);

  useEffect(() => {
    void refreshProviders();
    void deps
      .listJobs<GenerationJob>()
      .then(async (records: StoredGenerationJob<GenerationJob>[]) => {
        const restored = records[0]?.job ?? null;
        const restoredStorageStatus = records[0]?.resultStorageStatus ?? null;
        const protectedJobIds = records
          .filter((record) => record.id === restored?.id || activeStatuses.has(record.job.status) || record.job.status === "status_unknown")
          .map((record) => record.id);
        await deps.cleanupStorage({ protectedJobIds }).catch(() => {
          setError("本地清理未完成，已保留现有任务并继续恢复。" );
        });
        setJob(restored);
        setResultStorageStatus(restoredStorageStatus);
        if (restored?.status === "completed" && restoredStorageStatus !== "purged") {
          const resources = await deps.listFrames<Frame>(restored.id);
          if (restoredResultIsComplete(restored, resources, deps.now())) {
            setFrames(resources.map((resource: StoredFrameResource<Frame>) => resource.frame));
            setResultStorageStatus("available");
          } else {
            setFrames([]);
            setResultStorageStatus("invalid");
            setError("本地序列结果已损坏或不完整，需要重新生成。" );
          }
        }
      })
      .catch(() => setError("无法恢复本地序列任务。"))
      .finally(() => setJobsLoading(false));
  }, [deps, refreshProviders, setJob]);

  const persistCompletedResult = useCallback(
    async (job: GenerationJob) => {
      const queryJobId = job.recovery?.queryCursor;
      if (!queryJobId) throw new Error("任务缺少可查询的代理任务引用。" );
      const result = await deps.fetchResult(queryJobId);
      const remoteIntegrity = validateSequenceResult(
        result.frames,
        job.request.effectiveParameters.frameCount,
        deps.now(),
        undefined,
        result.jobId,
      );
      if (
        result.jobId !== queryJobId ||
        result.integrity.status !== "complete" ||
        remoteIntegrity.status !== "complete"
      ) {
        throw new SequenceApiError(
          "代理返回的序列结果不完整或任务归属不匹配。",
          "invalid_result",
          200,
          false,
          "none",
        );
      }
      const materialized = await Promise.all(result.frames.map(deps.materializeFrame));
      const stableFrames = materialized.map((item) => ({ ...item.frame, jobId: job.id }));
      const integrity = validateSequenceResult(
        stableFrames,
        job.request.effectiveParameters.frameCount,
        deps.now(),
        undefined,
        job.id,
      );
      if (integrity.status !== "complete") {
        throw new Error("序列结果不完整，不能进入帧工作区。" );
      }
      const requiredBytes = materialized.reduce((total, item) => total + item.blob.size, 0);
      const capacity = await deps.checkCapacity(requiredBytes, { protectedJobIds: [job.id] });
      if (!capacity.allowed) throw new Error("本地空间不足，无法安全保存完整序列结果。" );

      const withResult: GenerationJob = {
        ...job,
        resultIntegrity: integrity,
        frameIds: [...stableFrames]
          .sort((left, right) => left.sequenceIndex - right.sequenceIndex)
          .map((frame) => frame.id),
      };
      const completedTransition =
        withResult.status === "completed"
          ? { ...withResult, timestamps: { ...withResult.timestamps, updatedAt: deps.now() } }
          : transitionGenerationJob(withResult, "completed", deps.now());
      const completed: GenerationJob = { ...completedTransition, stage: "completed" };
      const resources = materialized.map((item, index) =>
        frameResourceStorageRecord(stableFrames[index], item.blob),
      );
      await deps.saveCompletedResult(generationJobStorageRecord(completed), resources);
      setFrames([...stableFrames].sort((left, right) => left.sequenceIndex - right.sequenceIndex));
      setResultStorageStatus("available");
      setJob(completed);
    },
    [deps, setJob],
  );

  const reconcile = useCallback(async () => {
    const job = currentJobRef.current;
    if (
      reconcilingRef.current ||
      !job ||
      ["failed", "cancelled", "completed", "abandoned"].includes(job.status)
    ) return;
    reconcilingRef.current = true;
    setReconciling(true);
    const capturedJobId = job.id;
    const capturedEpoch = jobEpochRef.current;
    const isCurrent = () => {
      const latest = currentJobRef.current;
      return latest?.id === capturedJobId &&
        jobEpochRef.current === capturedEpoch &&
        !["completed", "abandoned"].includes(latest.status);
    };
    try {
      const pollStartedAt = pollStartedAtRef.current ?? Date.parse(job.timestamps.createdAt);
      if (
        activeStatuses.has(job.status) &&
        Number.isFinite(pollStartedAt) &&
        Date.parse(deps.now()) - pollStartedAt > deps.maxPollingWindowMs
      ) {
        await persistJob({
          ...job,
          status: "status_unknown",
          stage: "polling_window_exceeded",
          progress: null,
          timestamps: { ...job.timestamps, updatedAt: deps.now() },
          lastError: {
            code: "timeout_unknown",
            message: "已超过最大查询窗口，任务状态未知。",
            retryable: false,
            recoveryAction: "reconcile",
          },
        });
        return;
      }
      let queryJobId = job.recovery?.queryCursor;
      if (!queryJobId) {
        const currentCapability = providersRef.current.find(
          (provider) => provider.provider === job.provider,
        );
        const requestProxyInstance = job.request.providerExtensions?.proxyInstanceId;
        if (!currentCapability || requestProxyInstance !== currentCapability.proxyInstanceId) {
          await persistJob({
            ...job,
            status: "status_unknown",
            stage: "proxy_instance_changed",
            timestamps: { ...job.timestamps, updatedAt: deps.now() },
            lastError: {
              code: "timeout_unknown",
              message: "代理实例已变化，不能重新提交旧任务；请对账或放弃跟踪。",
              retryable: false,
              recoveryAction: "reconcile",
            },
          });
          return;
        }
        const source = await deps.getSourceImage(job.request.source.id);
        if (!isCurrent()) return;
        if (!sourceMatchesRequest(job, source)) {
          const unavailable: GenerationJob = {
            ...job,
            status: "status_unknown",
            stage: "source_resource_unavailable",
            timestamps: { ...job.timestamps, updatedAt: deps.now() },
            lastError: {
              code: "resource_unavailable",
              message: "历史源图资源不可用，无法使用原幂等 ID 恢复提交。",
              retryable: false,
              recoveryAction: "none",
            },
          };
          await persistJob(unavailable);
          setError(unavailable.lastError?.message ?? "历史源图资源不可用。" );
          return;
        }
        const receipt = await deps.submitJob(job.request, source.dataUrl);
        if (!isCurrent()) return;
        queryJobId = receipt.jobId;
        await persistJob({
          ...job,
          externalJobRef: receipt.externalJobRef,
          stage: "accepted_locally",
          timestamps: {
            ...job.timestamps,
            submittedAt: receipt.submittedAt,
            updatedAt: receipt.submittedAt,
          },
          recovery: { canQuery: true, queryCursor: receipt.jobId },
        });
      }
      const latest = currentJobRef.current ?? job;
      const snapshot = await deps.fetchJob(queryJobId);
      if (!isCurrent()) return;
      const current = currentJobRef.current ?? latest;
      if (snapshot.proxyInstanceId !== current.request.providerExtensions.proxyInstanceId) {
        await persistJob({
          ...current,
          status: "status_unknown",
          stage: "proxy_instance_changed",
          timestamps: { ...current.timestamps, updatedAt: deps.now() },
          lastError: {
            code: "timeout_unknown",
            message: "查询响应来自不同代理实例，任务状态未知。",
            retryable: false,
            recoveryAction: "reconcile",
          },
        });
        return;
      }
      if (Date.parse(snapshot.updatedAt) < Date.parse(current.timestamps.updatedAt)) return;
      if (snapshot.status === "completed") {
        try {
          await persistCompletedResult(current);
          setError("");
        } catch (resultError) {
          const message = resultError instanceof Error ? resultError.message : "无法保存完整序列结果。";
          if (!isCurrent()) return;
          if (resultError instanceof SequenceApiError) {
            const remoteError = apiDomainError(resultError);
            await persistJob({
              ...current,
              status: resultError.code === "status_unknown" ? "status_unknown" : "failed",
              progress: null,
              stage: resultError.code === "status_unknown" ? "result_status_unknown" : "result_rejected",
              timestamps: { ...current.timestamps, updatedAt: deps.now() },
              lastError: remoteError,
            });
          } else {
            await persistJob({
              ...current,
              status: "processing",
              progress: null,
              stage: "storage_failed",
              timestamps: { ...current.timestamps, updatedAt: deps.now() },
              lastError: {
                code: "resource_unavailable",
                message,
                retryable: true,
                recoveryAction: "retry",
              },
            });
          }
          setError(message);
        }
        return;
      }
      if (snapshot.status !== current.status && !canTransitionGenerationJob(current.status, snapshot.status)) {
        return;
      }
      const updated: GenerationJob = {
        ...current,
        status: snapshot.status,
        progress: snapshot.progress,
        stage: snapshot.stage,
        timestamps: { ...current.timestamps, updatedAt: snapshot.updatedAt },
        ...(snapshot.error ? { lastError: snapshot.error } : {}),
      };
      await persistJob(updated);
      setError(snapshot.error?.message ?? "");
    } catch (queryError) {
      if (!isCurrent()) return;
      const latest = currentJobRef.current ?? job;
      const queryMessage = queryError instanceof Error ? queryError.message : "无法查询任务状态。";
      const unknown = queryError instanceof SequenceApiError && queryError.code === "status_unknown";
      if (unknown && (latest.status === "status_unknown" || canTransitionGenerationJob(latest.status, "status_unknown"))) {
        const updated: GenerationJob = {
          ...latest,
          status: "status_unknown",
          progress: null,
          stage: "reconciliation_required",
          timestamps: { ...latest.timestamps, updatedAt: deps.now() },
          lastError: {
            code: "timeout_unknown",
            message: queryMessage,
            retryable: false,
            recoveryAction: "reconcile",
          },
        };
        await persistJob(updated);
      } else if (queryError instanceof SequenceApiError && !activeStatuses.has(latest.status)) {
        await persistJob({
          ...latest,
          status: "failed",
          stage: "query_failed",
          timestamps: { ...latest.timestamps, updatedAt: deps.now() },
          lastError: apiDomainError(queryError),
        });
      } else if (activeStatuses.has(latest.status)) {
        await persistJob({
          ...latest,
          stage: "query_retry_scheduled",
          timestamps: { ...latest.timestamps, updatedAt: deps.now() },
          lastError: {
            code: "query_failed",
            message: queryMessage,
            retryable: true,
            recoveryAction: "retry",
          },
        });
      }
      setError(queryMessage);
    } finally {
      reconcilingRef.current = false;
      setReconciling(false);
      pollAttemptRef.current += 1;
      setPollTick((value) => value + 1);
    }
  }, [deps, persistCompletedResult, persistJob]);

  useEffect(() => {
    if (!currentJob || !activeStatuses.has(currentJob.status) || currentJob.stage === "storage_failed") return;
    const exponent = Math.min(pollAttemptRef.current, 5);
    const jitter = 0.8 + deps.random() * 0.4;
    const hiddenMultiplier = document.hidden ? deps.hiddenPollMultiplier : 1;
    const delay = Math.round(deps.pollIntervalMs * 2 ** exponent * jitter * hiddenMultiplier);
    const timer = window.setTimeout(() => void reconcile(), delay);
    return () => window.clearTimeout(timer);
  }, [currentJob, deps.hiddenPollMultiplier, deps.pollIntervalMs, deps.random, pollTick, reconcile]);

  const submit = useCallback(
    async (request: SequenceGenerationRequest, sourceImageDataUrl: string) => {
      const existing = currentJobRef.current;
      if (
        submittingRef.current ||
        (existing && (activeStatuses.has(existing.status) || existing.status === "status_unknown"))
      ) return;
      submittingRef.current = true;
      setSubmitting(true);
      setError("");
      const localJob = submittingJob(request, deps.now());
      try {
        await persistJob(localJob);
        const receipt = await deps.submitJob(request, sourceImageDataUrl);
        await persistJob({
          ...localJob,
          externalJobRef: receipt.externalJobRef,
          status: receipt.status,
          stage: "accepted_locally",
          timestamps: {
            ...localJob.timestamps,
            submittedAt: receipt.submittedAt,
            updatedAt: receipt.submittedAt,
          },
          recovery: { canQuery: true, queryCursor: receipt.jobId },
        });
        setFrames([]);
        setResultStorageStatus(null);
      } catch (submitError) {
        const ambiguous = !(submitError instanceof SequenceApiError) ||
          submitError.code === "status_unknown" ||
          submitError.httpStatus === undefined;
        const failed: GenerationJob = {
          ...localJob,
          status: ambiguous ? "status_unknown" : "failed",
          stage: ambiguous ? "submission_receipt_unknown" : "submission_rejected",
          timestamps: { ...localJob.timestamps, updatedAt: deps.now() },
          lastError: ambiguous
            ? {
                code: "timeout_unknown",
                message: "提交响应丢失；必须使用原幂等 ID 查询或对账。",
                retryable: false,
                recoveryAction: "reconcile",
              }
            : apiDomainError(submitError),
        };
        await persistJob(failed).catch(() => undefined);
        setError(submitError instanceof Error ? submitError.message : "序列任务提交失败。" );
        throw submitError;
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [deps, persistJob],
  );

  const retryFailed = useCallback(
    async () => {
      const parent = currentJobRef.current;
      if (!parent || parent.status !== "failed" || submittingRef.current) return;
      const source = await deps.getSourceImage(parent.request.source.id);
      if (!sourceMatchesRequest(parent, source)) {
        const message = "历史源图资源不可用或内容已变化，不能安全重试原任务。";
        setError(message);
        await persistJob({
          ...parent,
          lastError: {
            code: "resource_unavailable",
            message,
            retryable: false,
            recoveryAction: "none",
          },
          timestamps: { ...parent.timestamps, updatedAt: deps.now() },
        });
        return;
      }
      const draftId = deps.createId();
      const clientRequestId = deps.createId();
      const currentCapability = providersRef.current.find(
        (provider) => provider.provider === parent.provider,
      );
      if (!currentCapability) {
        setError("当前无法读取原服务商的代理实例，不能安全重试。" );
        return;
      }
      const request: SequenceGenerationRequest = {
        ...parent.request,
        draftId,
        clientRequestId,
        providerExtensions: {
          ...parent.request.providerExtensions,
          proxyInstanceId: currentCapability.proxyInstanceId,
        },
      };
      submittingRef.current = true;
      setSubmitting(true);
      setError("");
      const createdAt = deps.now();
      const retrying = createRetryChildJob({
        parent,
        id: draftId,
        draftId,
        clientRequestId,
        createdAt,
      });
      const localSubmitted = transitionGenerationJob(retrying, "submitting", createdAt);
      try {
        await persistJob(localSubmitted);
        const receipt = await deps.submitJob(request, source.dataUrl);
        await persistJob({
          ...localSubmitted,
          externalJobRef: receipt.externalJobRef,
          recovery: { canQuery: true, queryCursor: receipt.jobId },
          timestamps: {
            ...localSubmitted.timestamps,
            submittedAt: receipt.submittedAt,
            updatedAt: receipt.submittedAt,
          },
        });
        setFrames([]);
        setResultStorageStatus(null);
      } catch (retryError) {
        const ambiguous = !(retryError instanceof SequenceApiError) ||
          retryError.code === "status_unknown" ||
          retryError.httpStatus === undefined;
        await persistJob({
          ...localSubmitted,
          status: ambiguous ? "status_unknown" : "failed",
          stage: ambiguous ? "retry_receipt_unknown" : "retry_rejected",
          timestamps: { ...localSubmitted.timestamps, updatedAt: deps.now() },
          lastError: ambiguous
            ? {
                code: "timeout_unknown",
                message: "重试响应丢失；必须使用原幂等 ID 查询或对账。",
                retryable: false,
                recoveryAction: "reconcile",
              }
            : apiDomainError(retryError),
        }).catch(() => undefined);
        setError(retryError instanceof Error ? retryError.message : "重试提交失败。" );
        throw retryError;
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [deps, persistJob],
  );

  const abandonTracking = useCallback(async () => {
    const job = currentJobRef.current;
    if (!job || job.status !== "status_unknown") return;
    jobEpochRef.current += 1;
    await persistJob({
      ...job,
      status: "abandoned",
      stage: "tracking_abandoned",
      timestamps: { ...job.timestamps, updatedAt: deps.now() },
      lastError: {
        code: "timeout_unknown",
        message: "已放弃跟踪；远端任务仍可能继续运行。",
        retryable: false,
        recoveryAction: "none",
      },
    });
  }, [deps, persistJob]);

  const value = useMemo<SequenceContextValue>(
    () => ({
      providers,
      providersLoading,
      jobsLoading,
      currentJob,
      frames,
      resultStorageStatus,
      submitting,
      reconciling,
      error,
      refreshProviders,
      submit,
      retryFailed,
      reconcile,
      abandonTracking,
      clearError: () => setError(""),
    }),
    [providers, providersLoading, jobsLoading, currentJob, frames, resultStorageStatus, submitting, reconciling, error, refreshProviders, submit, retryFailed, reconcile, abandonTracking],
  );

  return <SequenceContext.Provider value={value}>{children}</SequenceContext.Provider>;
}

export function useSequenceGeneration(): SequenceContextValue {
  const context = useContext(SequenceContext);
  if (!context) throw new Error("useSequenceGeneration must be used inside SequenceProvider");
  return context;
}
