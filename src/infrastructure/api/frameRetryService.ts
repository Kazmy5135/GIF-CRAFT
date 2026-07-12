import {
  validateSequenceResult,
  type Frame,
  type GenerationJob,
  type SequenceGenerationRequest,
  type SequenceGenerationResult,
  type SequenceJobReceipt,
  type SequenceJobSnapshot,
  type SequenceProviderCapabilities,
} from "../../core/sequenceGeneration";
import {
  fetchSequenceJob,
  fetchSequenceResult,
  SequenceApiError,
  submitSequenceJob,
} from "./sequenceApi";

export type FrameRetryMode = SequenceProviderCapabilities["frameRetryMode"];

export type FrameRetryCapabilities = Pick<
  SequenceProviderCapabilities,
  "provider" | "frameRetryMode"
> & {
  /** Runtime proxy identity used for this child attempt, not the parent's historical identity. */
  readonly proxyInstanceId: string;
};

export interface FullSequenceFrameRetryInput {
  /** Stable workspace retry attempt ID and the client-side idempotency key. */
  readonly attemptId: string;
  /** IDs must already be persisted with the attempt before retry() is called. */
  readonly draftId: string;
  readonly clientRequestId: string;
  readonly parentJob: GenerationJob;
  readonly targetSequenceIndex: number;
  readonly sourceImageDataUrl: string;
  readonly capabilities: FrameRetryCapabilities;
  /** Durable barrier: polling cannot begin until the receipt is persisted successfully. */
  readonly onReceipt: (receipt: FrameRetryReceipt) => Promise<void>;
}

export interface FrameRetryReceipt {
  readonly childJobId: string;
  readonly externalJobRef?: string;
  readonly submittedAt?: string;
}

export interface FullSequenceFrameRetryResult {
  readonly attemptId: string;
  readonly executionMode: "full_sequence_fallback";
  readonly childJobId: string;
  /** Present for attempts submitted by this service instance; unavailable after metadata-only restore. */
  readonly childRequest?: SequenceGenerationRequest;
  readonly candidateFrame: Frame;
  readonly candidateBlob: Blob;
}

export interface ReconcileFrameRetryInput
  extends Pick<
    FullSequenceFrameRetryInput,
    "attemptId" | "parentJob" | "targetSequenceIndex" | "capabilities"
  > {
  readonly childJobId: string;
}

export type FrameRetryServiceErrorCode =
  | "capability_unsupported"
  | "invalid_request"
  | "status_unknown"
  | "child_job_failed"
  | "invalid_result"
  | "invalid_candidate_resource";

export class FrameRetryServiceError extends Error {
  constructor(
    message: string,
    readonly code: FrameRetryServiceErrorCode,
    readonly recoveryAction: "fix_input" | "reconcile" | "retry" | "none",
    readonly childJobId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FrameRetryServiceError";
  }
}

export interface FrameRetryServiceDependencies {
  readonly now: () => string;
  readonly submitJob: (
    request: SequenceGenerationRequest,
    sourceImageDataUrl: string,
  ) => Promise<SequenceJobReceipt>;
  readonly fetchJob: (jobId: string) => Promise<SequenceJobSnapshot>;
  readonly fetchResult: (jobId: string) => Promise<SequenceGenerationResult>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;
}

const defaultDependencies: FrameRetryServiceDependencies = {
  now: () => new Date().toISOString(),
  submitJob: submitSequenceJob,
  fetchJob: fetchSequenceJob,
  fetchResult: fetchSequenceResult,
  sleep: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
  pollIntervalMs: 1_500,
  maxPollAttempts: 600,
};

interface RetryEntry {
  readonly fingerprint: string;
  readonly childRequest?: SequenceGenerationRequest;
  readonly input: Pick<
    FullSequenceFrameRetryInput,
    "attemptId" | "parentJob" | "targetSequenceIndex" | "capabilities"
  >;
  readonly draftId?: string;
  readonly clientRequestId?: string;
  onReceipt?: (receipt: FrameRetryReceipt) => Promise<void>;
  receipt?: FrameRetryReceipt;
  receiptPersisted?: boolean;
  sourceImageDataUrl?: string;
  childJobId?: string;
  inFlight?: Promise<FullSequenceFrameRetryResult>;
  result?: FullSequenceFrameRetryResult;
  terminalError?: FrameRetryServiceError;
}

const activeJobStatuses = new Set(["draft", "validating", "ready", "retrying", "submitting", "queued", "generating", "processing", "cancelling"]);
const allowedImageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function invalidRequest(message: string): FrameRetryServiceError {
  return new FrameRetryServiceError(message, "invalid_request", "fix_input");
}

function retryFingerprint(
  input: Pick<
    FullSequenceFrameRetryInput,
    "attemptId" | "parentJob" | "targetSequenceIndex" | "capabilities"
  >,
): string {
  return [
    input.attemptId,
    input.parentJob.id,
    input.parentJob.request.source.contentSnapshotId,
    input.targetSequenceIndex,
    input.capabilities.provider,
    input.capabilities.frameRetryMode,
    input.capabilities.proxyInstanceId,
  ].join("\u0000");
}

function validateRetryContext(
  input: Pick<
    FullSequenceFrameRetryInput,
    "attemptId" | "parentJob" | "targetSequenceIndex" | "capabilities"
  >,
): void {
  if (!input.attemptId.trim()) throw invalidRequest("重试尝试 ID 缺失。");
  if (input.capabilities.provider !== input.parentJob.provider) {
    throw invalidRequest("重试能力与父任务服务商不匹配。");
  }
  if (!input.capabilities.proxyInstanceId.trim()) {
    throw invalidRequest("当前重试能力缺少代理实例 ID。");
  }
  if (input.capabilities.frameRetryMode !== "full_sequence_fallback") {
    throw new FrameRetryServiceError(
      input.capabilities.frameRetryMode === "native_single_frame"
        ? "当前服务声明原生单帧重试，不能使用完整序列降级服务。"
        : "当前服务不支持指定帧重试。",
      "capability_unsupported",
      "none",
    );
  }
  const { parentJob, targetSequenceIndex } = input;
  if (parentJob.status !== "completed" || parentJob.resultIntegrity.status !== "complete") {
    throw invalidRequest("只有完整完成的父任务可以发起指定帧重试。");
  }
  const expectedFrameCount = parentJob.request.effectiveParameters.frameCount;
  if (
    parentJob.clientRequestId !== parentJob.request.clientRequestId ||
    parentJob.resultIntegrity.expectedFrameCount !== expectedFrameCount ||
    parentJob.resultIntegrity.actualFrameCount !== expectedFrameCount ||
    parentJob.resultIntegrity.issues.length > 0 ||
    parentJob.frameIds.length !== expectedFrameCount ||
    new Set(parentJob.frameIds).size !== expectedFrameCount
  ) {
    throw invalidRequest("父任务请求快照或完整性引用不一致。");
  }
  if (
    !Number.isSafeInteger(targetSequenceIndex) ||
    targetSequenceIndex < 0 ||
    targetSequenceIndex >= expectedFrameCount
  ) {
    throw invalidRequest("目标原始序列索引超出父任务范围。");
  }
}

function validateRetryInput(input: FullSequenceFrameRetryInput): void {
  validateRetryContext(input);
  if (!input.draftId.trim() || !input.clientRequestId.trim()) {
    throw invalidRequest("重试尝试缺少已持久化的 draftId 或 clientRequestId。");
  }
  if (typeof input.onReceipt !== "function") {
    throw invalidRequest("重试尝试缺少回执持久化回调。");
  }
  decodeImageDataUrl(
    input.sourceImageDataUrl,
    input.parentJob.request.source.mimeType,
    input.parentJob.request.source.size,
    "源图",
  );
}

function cloneChildRequest(
  parent: GenerationJob,
  draftId: string,
  clientRequestId: string,
  proxyInstanceId: string,
): SequenceGenerationRequest {
  const request = parent.request;
  return {
    ...request,
    draftId,
    clientRequestId,
    source: { ...request.source },
    promptSnapshot: {
      ...request.promptSnapshot,
      layerRefs: request.promptSnapshot.layerRefs.map((layer) => ({ ...layer })),
    },
    requestedParameters: {
      ...request.requestedParameters,
      canvas: { ...request.requestedParameters.canvas },
    },
    effectiveParameters: {
      ...request.effectiveParameters,
      canvas: { ...request.effectiveParameters.canvas },
    },
    parameterMappings: request.parameterMappings.map((mapping) => ({ ...mapping })),
    providerExtensions: { ...request.providerExtensions, proxyInstanceId },
  };
}

function decodeImageDataUrl(
  dataUrl: string,
  expectedMimeType: string,
  expectedSize: number,
  label: string,
): Uint8Array<ArrayBuffer> {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match || !allowedImageMimeTypes.has(match[1].toLowerCase())) {
    throw new FrameRetryServiceError(
      `${label}必须是 PNG、JPEG 或 WebP 的 base64 data URL。`,
      "invalid_candidate_resource",
      "none",
    );
  }
  const mimeType = match[1].toLowerCase();
  if (mimeType !== expectedMimeType.toLowerCase()) {
    throw new FrameRetryServiceError(`${label} MIME 与元数据不一致。`, "invalid_candidate_resource", "none");
  }
  const encoded = match[2];
  const estimatedSize = Math.floor((encoded.length * 3) / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (estimatedSize <= 0 || estimatedSize > MAX_IMAGE_BYTES || expectedSize !== estimatedSize) {
    throw new FrameRetryServiceError(`${label}体积与元数据不一致或超过安全限制。`, "invalid_candidate_resource", "none");
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch (cause) {
    throw new FrameRetryServiceError(`${label} base64 内容无效。`, "invalid_candidate_resource", "none", undefined, { cause });
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (!hasExpectedImageSignature(bytes, mimeType)) {
    throw new FrameRetryServiceError(`${label}文件签名与 MIME 不一致。`, "invalid_candidate_resource", "none");
  }
  return bytes;
}

function hasExpectedImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}

function statusUnknown(message: string, childJobId?: string, cause?: unknown): FrameRetryServiceError {
  return new FrameRetryServiceError(message, "status_unknown", "reconcile", childJobId, { cause });
}

function assertReceipt(
  receipt: SequenceJobReceipt,
  request: SequenceGenerationRequest,
  parent: GenerationJob,
  capabilities: FrameRetryCapabilities,
): void {
  if (
    !receipt.jobId.trim() ||
    receipt.provider !== parent.provider ||
    request.providerExtensions.proxyInstanceId !== capabilities.proxyInstanceId ||
    receipt.proxyInstanceId !== capabilities.proxyInstanceId
  ) {
    throw statusUnknown("子任务提交回执归属不一致，状态未知。", receipt.jobId || undefined);
  }
}

function assertSnapshot(
  snapshot: SequenceJobSnapshot,
  childJobId: string,
  parent: GenerationJob,
  capabilities: FrameRetryCapabilities,
): void {
  if (
    snapshot.jobId !== childJobId ||
    snapshot.provider !== parent.provider ||
    snapshot.proxyInstanceId !== capabilities.proxyInstanceId
  ) {
    throw statusUnknown("子任务查询结果归属不一致，状态未知。", childJobId);
  }
}

function mapSubmitError(error: unknown): FrameRetryServiceError {
  if (error instanceof FrameRetryServiceError) return error;
  if (!(error instanceof SequenceApiError) || error.code === "status_unknown" || error.httpStatus === undefined) {
    return statusUnknown("子任务提交结果不明确；为避免重复生成，不会自动重提。", undefined, error);
  }
  return new FrameRetryServiceError(
    error.message || "子任务提交失败。",
    "child_job_failed",
    error.retryable ? "retry" : "none",
    undefined,
    { cause: error },
  );
}

export class FrameRetryService {
  private readonly entries = new Map<string, RetryEntry>();

  constructor(private readonly dependencies: FrameRetryServiceDependencies = defaultDependencies) {
    if (!Number.isSafeInteger(dependencies.maxPollAttempts) || dependencies.maxPollAttempts <= 0) {
      throw new Error("maxPollAttempts 必须是正整数。");
    }
    if (!Number.isFinite(dependencies.pollIntervalMs) || dependencies.pollIntervalMs < 0) {
      throw new Error("pollIntervalMs 不能为负数。");
    }
  }

  retry(input: FullSequenceFrameRetryInput): Promise<FullSequenceFrameRetryResult> {
    const fingerprint = retryFingerprint(input);
    const existing = this.entries.get(input.attemptId);
    if (existing && existing.fingerprint !== fingerprint) {
      return Promise.reject(invalidRequest("同一重试尝试 ID 不能用于不同目标。"));
    }
    if (
      existing &&
      (existing.draftId !== input.draftId || existing.clientRequestId !== input.clientRequestId)
    ) {
      return Promise.reject(invalidRequest("同一重试尝试 ID 不能切换 draftId 或 clientRequestId。"));
    }
    let entry = existing;
    if (!entry) {
      try {
        validateRetryInput(input);
        entry = {
          fingerprint,
          childRequest: cloneChildRequest(
            input.parentJob,
            input.draftId,
            input.clientRequestId,
            input.capabilities.proxyInstanceId,
          ),
          input: {
            attemptId: input.attemptId,
            parentJob: input.parentJob,
            targetSequenceIndex: input.targetSequenceIndex,
            capabilities: input.capabilities,
          },
          draftId: input.draftId,
          clientRequestId: input.clientRequestId,
          onReceipt: input.onReceipt,
          sourceImageDataUrl: input.sourceImageDataUrl,
        };
        this.entries.set(input.attemptId, entry);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (entry.result) return Promise.resolve(entry.result);
    if (entry.terminalError) return Promise.reject(entry.terminalError);
    if (entry.inFlight) return entry.inFlight;

    const operation = this.execute(entry)
      .then((result) => {
        entry!.result = result;
        return result;
      })
      .catch((error: unknown) => {
        const normalized = error instanceof FrameRetryServiceError
          ? error
          : new FrameRetryServiceError("指定帧重试失败。", "child_job_failed", "retry", entry!.childJobId, { cause: error });
        if (normalized.code !== "status_unknown" || !entry!.childJobId) entry!.terminalError = normalized;
        throw normalized;
      })
      .finally(() => {
        entry!.inFlight = undefined;
      });
    entry.inFlight = operation;
    return operation;
  }

  /**
   * Restores an already-submitted attempt after refresh. This path never calls submitJob;
   * it can only query the supplied child job and read its result.
   */
  reconcile(input: ReconcileFrameRetryInput): Promise<FullSequenceFrameRetryResult> {
    try {
      validateRetryContext(input);
      if (!input.childJobId.trim()) throw invalidRequest("待对账的重试子任务 ID 缺失。");
    } catch (error) {
      return Promise.reject(error);
    }
    const fingerprint = retryFingerprint(input);
    const existing = this.entries.get(input.attemptId);
    if (existing && existing.fingerprint !== fingerprint) {
      return Promise.reject(invalidRequest("同一重试尝试 ID 不能用于不同目标。"));
    }
    if (existing?.childJobId && existing.childJobId !== input.childJobId) {
      return Promise.reject(invalidRequest("同一重试尝试 ID 不能切换到另一个子任务。"));
    }
    let entry = existing;
    if (!entry) {
      entry = {
        fingerprint,
        input: {
          attemptId: input.attemptId,
          parentJob: input.parentJob,
          targetSequenceIndex: input.targetSequenceIndex,
          capabilities: input.capabilities,
        },
        childJobId: input.childJobId,
        receiptPersisted: true,
      };
      this.entries.set(input.attemptId, entry);
    } else {
      entry.childJobId = input.childJobId;
      entry.receiptPersisted = true;
    }
    if (entry.result) return Promise.resolve(entry.result);
    if (entry.inFlight) return entry.inFlight;
    // An explicit reconciliation is allowed to re-check a previously ambiguous/failed read,
    // but it still cannot create another remote task.
    entry.terminalError = undefined;
    const operation = this.track(
      entry,
      this.pollAndReadCandidate(entry, input.childJobId),
    );
    entry.inFlight = operation;
    return operation;
  }

  /** Explicitly releases completed/abandoned attempt bookkeeping. */
  forget(attemptId: string): void {
    this.entries.delete(attemptId);
  }

  private async execute(entry: RetryEntry): Promise<FullSequenceFrameRetryResult> {
    if (entry.childJobId && entry.receipt && !entry.receiptPersisted) {
      await this.persistReceipt(entry);
    }
    if (!entry.childJobId) {
      let receipt: SequenceJobReceipt;
      try {
        if (!entry.childRequest) throw invalidRequest("重试子任务请求快照缺失。");
        if (!entry.sourceImageDataUrl) throw invalidRequest("重试源图已释放，不能再次提交。");
        receipt = await this.dependencies.submitJob(entry.childRequest, entry.sourceImageDataUrl);
      } catch (error) {
        throw mapSubmitError(error);
      } finally {
        // Do not retain the source image bytes after the one authorized submission.
        entry.sourceImageDataUrl = undefined;
      }
      assertReceipt(
        receipt,
        entry.childRequest,
        entry.input.parentJob,
        entry.input.capabilities,
      );
      entry.childJobId = receipt.jobId;
      entry.receipt = {
        childJobId: receipt.jobId,
        externalJobRef: receipt.externalJobRef,
        submittedAt: receipt.submittedAt,
      };
      await this.persistReceipt(entry);
      if (receipt.status === "status_unknown") {
        throw statusUnknown("子任务提交后状态未知；后续只查询现有任务。", receipt.jobId);
      }
      if (["failed", "cancelled", "abandoned"].includes(receipt.status)) {
        throw new FrameRetryServiceError("重试子任务未能开始。", "child_job_failed", "retry", receipt.jobId);
      }
      if (receipt.status === "completed") return this.readCandidate(entry, receipt.jobId);
    }
    return this.pollAndReadCandidate(entry, entry.childJobId);
  }

  private async persistReceipt(entry: RetryEntry): Promise<void> {
    if (entry.receiptPersisted) return;
    if (!entry.receipt || !entry.onReceipt) {
      throw statusUnknown("子任务回执尚未持久化，不能开始查询。", entry.childJobId);
    }
    try {
      await entry.onReceipt(entry.receipt);
      entry.receiptPersisted = true;
      entry.onReceipt = undefined;
    } catch (cause) {
      throw statusUnknown("子任务已提交，但回执持久化失败；不会继续查询或重新提交。", entry.childJobId, cause);
    }
  }

  private track(
    entry: RetryEntry,
    operation: Promise<FullSequenceFrameRetryResult>,
  ): Promise<FullSequenceFrameRetryResult> {
    return operation
      .then((result) => {
        entry.result = result;
        return result;
      })
      .catch((error: unknown) => {
        const normalized = error instanceof FrameRetryServiceError
          ? error
          : new FrameRetryServiceError("指定帧重试失败。", "child_job_failed", "retry", entry.childJobId, { cause: error });
        if (normalized.code !== "status_unknown" || !entry.childJobId) entry.terminalError = normalized;
        throw normalized;
      })
      .finally(() => {
        entry.inFlight = undefined;
      });
  }

  private async pollAndReadCandidate(entry: RetryEntry, childJobId: string): Promise<FullSequenceFrameRetryResult> {
    for (let attempt = 0; attempt < this.dependencies.maxPollAttempts; attempt += 1) {
      let snapshot: SequenceJobSnapshot;
      try {
        snapshot = await this.dependencies.fetchJob(childJobId);
      } catch (error) {
        if (!(error instanceof SequenceApiError) || error.code === "status_unknown" || error.httpStatus === undefined) {
          throw statusUnknown("无法确认重试子任务状态；不会自动重提。", childJobId, error);
        }
        throw new FrameRetryServiceError(error.message, "child_job_failed", error.retryable ? "retry" : "none", childJobId, { cause: error });
      }
      assertSnapshot(
        snapshot,
        childJobId,
        entry.input.parentJob,
        entry.input.capabilities,
      );
      if (snapshot.status === "completed") return this.readCandidate(entry, childJobId);
      if (snapshot.status === "status_unknown") {
        throw statusUnknown("重试子任务状态未知；不会自动重提。", childJobId);
      }
      if (["failed", "cancelled", "abandoned"].includes(snapshot.status)) {
        throw new FrameRetryServiceError(
          snapshot.error?.message || "重试子任务失败。",
          "child_job_failed",
          snapshot.error?.retryable ? "retry" : "none",
          childJobId,
        );
      }
      if (!activeJobStatuses.has(snapshot.status)) {
        throw statusUnknown("重试子任务返回未知生命周期状态。", childJobId);
      }
      if (attempt + 1 < this.dependencies.maxPollAttempts) {
        await this.dependencies.sleep(this.dependencies.pollIntervalMs);
      }
    }
    throw statusUnknown("重试子任务在轮询窗口内没有完成；不会自动重提。", childJobId);
  }

  private async readCandidate(entry: RetryEntry, childJobId: string): Promise<FullSequenceFrameRetryResult> {
    let result: SequenceGenerationResult;
    try {
      result = await this.dependencies.fetchResult(childJobId);
    } catch (error) {
      if (!(error instanceof SequenceApiError) || error.code === "status_unknown" || error.httpStatus === undefined) {
        throw statusUnknown("子任务完成但结果状态不明确；不会自动重提。", childJobId, error);
      }
      throw new FrameRetryServiceError(error.message, "invalid_result", "none", childJobId, { cause: error });
    }
    const expectedFrameCount = entry.input.parentJob.request.effectiveParameters.frameCount;
    const localIntegrity = validateSequenceResult(
      result.frames,
      expectedFrameCount,
      this.dependencies.now(),
      undefined,
      childJobId,
    );
    if (
      result.jobId !== childJobId ||
      result.integrity.status !== "complete" ||
      result.integrity.expectedFrameCount !== expectedFrameCount ||
      result.integrity.actualFrameCount !== expectedFrameCount ||
      result.integrity.issues.length > 0 ||
      localIntegrity.status !== "complete"
    ) {
      throw new FrameRetryServiceError("重试子任务结果归属或完整性无效。", "invalid_result", "none", childJobId);
    }
    const matchingFrames = result.frames.filter(
      (frame) => frame.sequenceIndex === entry.input.targetSequenceIndex,
    );
    if (matchingFrames.length !== 1) {
      throw new FrameRetryServiceError("结果无法唯一定位目标原始序列索引。", "invalid_result", "none", childJobId);
    }
    const remoteFrame = matchingFrames[0];
    if (
      remoteFrame.width !== entry.input.parentJob.request.effectiveParameters.canvas.width ||
      remoteFrame.height !== entry.input.parentJob.request.effectiveParameters.canvas.height ||
      !remoteFrame.readable
    ) {
      throw new FrameRetryServiceError("候选帧尺寸或可读状态无效。", "invalid_candidate_resource", "none", childJobId);
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = decodeImageDataUrl(
        remoteFrame.resourceRef,
        remoteFrame.mimeType,
        remoteFrame.size,
        "候选帧",
      );
    } catch (error) {
      if (error instanceof FrameRetryServiceError) {
        throw new FrameRetryServiceError(
          error.message,
          error.code,
          error.recoveryAction,
          childJobId,
          { cause: error },
        );
      }
      throw error;
    }
    const candidateBlob = new Blob([bytes], { type: remoteFrame.mimeType });
    const candidateFrame: Frame = {
      ...remoteFrame,
      resourceRef: `workspace-frame-resource:${childJobId}:${remoteFrame.id}`,
    };
    return {
      attemptId: entry.input.attemptId,
      executionMode: "full_sequence_fallback",
      childJobId,
      ...(entry.childRequest ? { childRequest: entry.childRequest } : {}),
      candidateFrame,
      candidateBlob,
    };
  }
}

export function createFrameRetryService(
  dependencies?: Partial<FrameRetryServiceDependencies>,
): FrameRetryService {
  return new FrameRetryService({ ...defaultDependencies, ...dependencies });
}
