import type {
  SequenceGenerationError,
  SequenceGenerationRequest,
  SequenceGenerationResult,
  SequenceJobReceipt,
  SequenceJobSnapshot,
  SequenceProviderCapabilities,
} from "../../core/sequenceGeneration";

export interface SequenceProviderCapabilitySummary extends SequenceProviderCapabilities {
  readonly configured: boolean;
  readonly model: string;
  readonly unavailabilityReason?: string;
  readonly providerDurationSeconds: readonly number[];
  readonly providerResolutions: readonly string[];
  readonly supportsLocalJobQuery: boolean;
  readonly proxyInstanceId: string;
}

interface SequenceApiErrorPayload {
  error: Partial<SequenceGenerationError> & {
    code?: SequenceGenerationError["code"] | "status_unknown";
    message?: string;
  };
}

export class SequenceApiError extends Error {
  constructor(
    message: string,
    public readonly code: SequenceGenerationError["code"] | "status_unknown" =
      "request_failed",
    public readonly httpStatus?: number,
    public readonly retryable: boolean = false,
    public readonly recoveryAction: SequenceGenerationError["recoveryAction"] = "none",
  ) {
    super(message);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    if (response.ok) {
      throw new SequenceApiError(
        "代理已接受请求，但响应不完整，任务状态未知。",
        "status_unknown",
        undefined,
        false,
        "reconcile",
      );
    }
    throw new SequenceApiError("代理返回了无法读取的错误响应。", "request_failed", response.status);
  }
}

function defaultErrorPolicy(
  code: SequenceGenerationError["code"] | "status_unknown",
): Pick<SequenceGenerationError, "retryable" | "recoveryAction"> {
  if (code === "status_unknown" || code === "timeout_unknown") {
    return { retryable: false, recoveryAction: "reconcile" };
  }
  if (["validation_failed", "capability_unsupported", "authentication_failed"].includes(code)) {
    return { retryable: false, recoveryAction: "fix_input" };
  }
  if (["invalid_result", "resource_unavailable", "cancellation_unsupported"].includes(code)) {
    return { retryable: false, recoveryAction: "none" };
  }
  return { retryable: true, recoveryAction: "retry" };
}

async function unwrap<T>(
  response: Response,
  fallbackMessage: string,
  validate?: (payload: unknown) => payload is T,
): Promise<T> {
  const payload = await readJson<T | SequenceApiErrorPayload>(response);
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    const code = error?.code || "request_failed";
    const policy = defaultErrorPolicy(code);
    throw new SequenceApiError(
      error?.message || fallbackMessage,
      code,
      response.status,
      error?.retryable ?? policy.retryable,
      error?.recoveryAction ?? policy.recoveryAction,
    );
  }
  if (validate && !validate(payload)) {
    throw new SequenceApiError(
      "代理返回的成功响应不完整，任务状态未知。",
      "status_unknown",
      undefined,
      false,
      "reconcile",
    );
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isSequenceJobReceipt(value: unknown): value is SequenceJobReceipt {
  return isRecord(value) &&
    typeof value.jobId === "string" &&
    typeof value.externalJobRef === "string" &&
    typeof value.provider === "string" &&
    typeof value.proxyInstanceId === "string" &&
    typeof value.submittedAt === "string" &&
    typeof value.status === "string";
}

function isSequenceJobSnapshot(value: unknown): value is SequenceJobSnapshot {
  return isRecord(value) &&
    typeof value.jobId === "string" &&
    typeof value.provider === "string" &&
    typeof value.proxyInstanceId === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.status === "string" &&
    (value.progress === null || typeof value.progress === "number");
}

function isSequenceGenerationResult(value: unknown): value is SequenceGenerationResult {
  return isRecord(value) && typeof value.jobId === "string" && Array.isArray(value.frames) && isRecord(value.integrity);
}

export async function fetchSequenceProviders(): Promise<SequenceProviderCapabilitySummary[]> {
  const response = await fetch("/api/providers");
  const payload = await unwrap<{ sequenceProviders?: SequenceProviderCapabilitySummary[] }>(
    response,
    "无法读取序列服务状态。",
  );
  return payload.sequenceProviders || [];
}

export async function submitSequenceJob(
  request: SequenceGenerationRequest,
  sourceImageDataUrl: string,
): Promise<SequenceJobReceipt> {
  const response = await fetch("/api/sequence-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request, sourceImageDataUrl }),
  });
  const receipt = await unwrap<SequenceJobReceipt>(response, "无法提交序列任务。", isSequenceJobReceipt);
  if (receipt.proxyInstanceId !== request.providerExtensions.proxyInstanceId) {
    throw new SequenceApiError(
      "代理实例在提交期间发生变化，任务状态未知。",
      "status_unknown",
      undefined,
      false,
      "reconcile",
    );
  }
  return receipt;
}

export async function fetchSequenceJob(jobId: string): Promise<SequenceJobSnapshot> {
  const response = await fetch(`/api/sequence-jobs/${encodeURIComponent(jobId)}`);
  return unwrap<SequenceJobSnapshot>(response, "无法查询序列任务。", isSequenceJobSnapshot);
}

export async function fetchSequenceResult(jobId: string): Promise<SequenceGenerationResult> {
  const response = await fetch(`/api/sequence-jobs/${encodeURIComponent(jobId)}/result`);
  return unwrap<SequenceGenerationResult>(response, "无法读取序列任务结果。", isSequenceGenerationResult);
}
