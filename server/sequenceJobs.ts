import { createHash, randomUUID } from "node:crypto";
import type {
  GenerationJobStatus,
  SequenceGenerationError,
  SequenceGenerationRequest,
  SequenceGenerationResult,
  SequenceJobReceipt,
  SequenceJobSnapshot,
} from "../src/core/sequenceGeneration.js";
import {
  canTransitionGenerationJob,
  validateSequenceResult,
} from "../src/core/sequenceGeneration.js";
import {
  executeGorillaSequence,
  type SequenceExecutionContext,
} from "./providers/sequence.js";
import { ProviderRequestError } from "./providers/types.js";

const DEFAULT_RESULT_CACHE_BYTES = 128 * 1024 * 1024;
const DEFAULT_RESULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TOMBSTONE_LIMIT = 1_000;
const DEFAULT_JOB_METADATA_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_JOB_METADATA_LIMIT = 500;

export type SequenceJobExecutor = (
  request: SequenceGenerationRequest,
  sourceImageDataUrl: string,
  context: SequenceExecutionContext,
) => Promise<SequenceGenerationResult>;

interface SequenceJobRecord {
  readonly requestFingerprint: string;
  readonly receipt: SequenceJobReceipt;
  snapshot: SequenceJobSnapshot;
  result?: SequenceGenerationResult;
  resultBytes?: number;
  resultCachedAtMs?: number;
  readonly createdAtMs: number;
}

interface SequenceRequestTombstone {
  readonly requestFingerprint: string;
  readonly receipt: SequenceJobReceipt;
  readonly createdAtMs: number;
}

export class SequenceJobConflictError extends Error {}
export class SequenceJobRateLimitError extends Error {}

export interface SequenceJobServiceOptions {
  execute?: SequenceJobExecutor;
  nowMs?: () => number;
  resultCacheBytes?: number;
  resultTtlMs?: number;
  tombstoneTtlMs?: number;
  tombstoneLimit?: number;
  jobMetadataTtlMs?: number;
  jobMetadataLimit?: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function fingerprintSequenceRequest(request: SequenceGenerationRequest): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(request))).digest("hex");
}

function sequenceError(error: unknown): SequenceGenerationError {
  if (error instanceof ProviderRequestError) {
    if (error.statusUnknown || error.kind === "status_unknown") return {
        code: "timeout_unknown",
        message: "服务商调用超时，无法确认远端任务结果；请勿自动重新提交。",
        retryable: false,
        recoveryAction: "reconcile",
      };
    if (error.kind === "invalid_request") return {
      code: "validation_failed",
      message: "序列请求未通过服务端领域校验。",
      retryable: false,
      recoveryAction: "fix_input",
    };
    if (error.kind === "capability") return {
      code: "capability_unsupported",
      message: "当前服务商不支持该序列请求。",
      retryable: false,
      recoveryAction: "fix_input",
    };
    if (error.kind === "authentication") return {
      code: "authentication_failed",
      message: "序列服务商鉴权失败，请更新服务端凭据。",
      retryable: false,
      recoveryAction: "fix_input",
    };
    if (error.kind === "rate_limit") return {
      code: "rate_limited",
      message: "序列服务商当前限流，请稍后显式重试。",
      retryable: true,
      recoveryAction: "retry",
    };
    if (error.kind === "invalid_result") return {
      code: "invalid_result",
      message: "服务商结果无法安全归一化；不会自动重新生成。",
      retryable: false,
      recoveryAction: "none",
    };
    if (error.kind === "partial_result") return {
      code: "partial_result",
      message: "服务商只返回了部分帧，结果不会标记为完成。",
      retryable: false,
      recoveryAction: "none",
    };
    return {
      code: "request_failed",
      message: "序列生成失败，请检查服务商配置或稍后重试。",
      retryable: error.retryable,
      recoveryAction: error.retryable ? "retry" : "none",
    };
  }
  return {
    code: "request_failed",
    message: "序列生成失败，请检查服务商配置或稍后重试。",
    retryable: false,
    recoveryAction: "none",
  };
}

function isTerminal(status: GenerationJobStatus): boolean {
  return ["completed", "failed", "status_unknown", "abandoned", "cancelled"].includes(status);
}

export class SequenceJobService {
  private readonly jobsById = new Map<string, SequenceJobRecord>();
  // Tombstones contain only a SHA-256 fingerprint and a small receipt, never
  // source bytes. Their bound is deliberately much larger than result storage.
  private readonly requestsByClientId = new Map<string, SequenceRequestTombstone>();
  private readonly execute: SequenceJobExecutor;
  private readonly nowMs: () => number;
  private readonly resultCacheBytes: number;
  private readonly resultTtlMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly tombstoneLimit: number;
  private readonly jobMetadataTtlMs: number;
  private readonly jobMetadataLimit: number;

  constructor(executeOrOptions: SequenceJobExecutor | SequenceJobServiceOptions = {}) {
    const options =
      typeof executeOrOptions === "function"
        ? { execute: executeOrOptions }
        : executeOrOptions;
    this.execute = options.execute || executeGorillaSequence;
    this.nowMs = options.nowMs || Date.now;
    this.resultCacheBytes = options.resultCacheBytes ?? DEFAULT_RESULT_CACHE_BYTES;
    this.resultTtlMs = options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.tombstoneLimit = options.tombstoneLimit ?? DEFAULT_TOMBSTONE_LIMIT;
    this.jobMetadataTtlMs = options.jobMetadataTtlMs ?? DEFAULT_JOB_METADATA_TTL_MS;
    this.jobMetadataLimit = options.jobMetadataLimit ?? DEFAULT_JOB_METADATA_LIMIT;
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  create(request: SequenceGenerationRequest, sourceImageDataUrl: string): SequenceJobReceipt {
    this.pruneCaches();
    const fingerprint = fingerprintSequenceRequest(request);
    const tombstone = this.requestsByClientId.get(request.clientRequestId);
    if (tombstone) {
      if (tombstone.requestFingerprint !== fingerprint) {
        throw new SequenceJobConflictError(
          "The clientRequestId is already associated with different sequence parameters.",
        );
      }
      return tombstone.receipt;
    }
    if ([...this.jobsById.values()].some((record) => !isTerminal(record.snapshot.status))) {
      throw new SequenceJobRateLimitError("Only one sequence job may be active at a time.");
    }

    const jobId = randomUUID();
    const createdAtMs = this.nowMs();
    const submittedAt = new Date(createdAtMs).toISOString();
    const externalJobRef = `local:${jobId}`;
    const receipt: SequenceJobReceipt = {
      jobId,
      externalJobRef,
      provider: request.provider,
      proxyInstanceId: request.providerExtensions.proxyInstanceId,
      status: "submitting",
      submittedAt,
    };
    const record: SequenceJobRecord = {
      requestFingerprint: fingerprint,
      receipt,
      createdAtMs,
      snapshot: {
        jobId,
        externalJobRef,
        provider: request.provider,
        proxyInstanceId: request.providerExtensions.proxyInstanceId,
        status: "submitting",
        progress: null,
        stage: "accepted_locally",
        updatedAt: submittedAt,
      },
    };
    this.jobsById.set(jobId, record);
    this.requestsByClientId.set(request.clientRequestId, {
      requestFingerprint: fingerprint,
      receipt,
      createdAtMs,
    });
    this.pruneCaches();
    // Source bytes stay only in this short-lived execution closure. They are not
    // copied into receipts, snapshots, fingerprints, job records, or logs.
    queueMicrotask(() => void this.run(jobId, request, sourceImageDataUrl));
    return receipt;
  }

  getSnapshot(jobId: string): SequenceJobSnapshot | undefined {
    this.pruneCaches();
    return this.jobsById.get(jobId)?.snapshot;
  }

  getResult(jobId: string): SequenceGenerationResult | undefined {
    this.pruneCaches();
    return this.jobsById.get(jobId)?.result;
  }

  has(jobId: string): boolean {
    return this.jobsById.has(jobId);
  }

  private update(jobId: string, status: "generating" | "processing", stage: string): void {
    const record = this.jobsById.get(jobId);
    if (!record) throw new ProviderRequestError("Local sequence job no longer exists.", {
      kind: "invalid_result",
      retryable: false,
    });
    if (!canTransitionGenerationJob(record.snapshot.status, status)) {
      throw new ProviderRequestError(
        `Illegal sequence job transition: ${record.snapshot.status} -> ${status}.`,
        { kind: "invalid_result", retryable: false },
      );
    }
    record.snapshot = {
      ...record.snapshot,
      status,
      progress: null,
      stage,
      updatedAt: this.nowIso(),
    };
  }

  private async run(
    jobId: string,
    request: SequenceGenerationRequest,
    sourceImageDataUrl: string,
  ): Promise<void> {
    const record = this.jobsById.get(jobId);
    if (!record) return;
    const context: SequenceExecutionContext = {
      jobId,
      update: (status, stage) => this.update(jobId, status, stage),
    };
    try {
      const result = await this.execute(request, sourceImageDataUrl, context);
      const verifiedIntegrity = validateSequenceResult(
        result.frames,
        request.effectiveParameters.frameCount,
        this.nowIso(),
        undefined,
        jobId,
      );
      if (
        result.jobId !== jobId ||
        result.integrity.status !== "complete" ||
        result.integrity.expectedFrameCount !== request.effectiveParameters.frameCount ||
        result.integrity.actualFrameCount !== result.frames.length ||
        verifiedIntegrity.status !== "complete" ||
        !canTransitionGenerationJob(record.snapshot.status, "completed")
      ) {
        throw new ProviderRequestError("Sequence executor returned an invalid completion result.", {
          kind: "invalid_result",
          retryable: false,
        });
      }
      record.result = result;
      record.resultBytes = result.frames.reduce((total, frame) => total + frame.size, 0);
      record.resultCachedAtMs = this.nowMs();
      record.snapshot = {
        ...record.snapshot,
        status: "completed",
        progress: null,
        stage: "completed",
        updatedAt: this.nowIso(),
      };
      this.pruneCaches();
    } catch (error) {
      const mappedError = sequenceError(error);
      record.snapshot = {
        ...record.snapshot,
        status: mappedError.code === "timeout_unknown" ? "status_unknown" : "failed",
        progress: null,
        stage: mappedError.code === "timeout_unknown" ? "reconciliation_required" : "failed",
        updatedAt: this.nowIso(),
        error: mappedError,
      };
      this.pruneCaches();
    }
  }

  private pruneCaches(): void {
    const now = this.nowMs();
    for (const [clientRequestId, tombstone] of this.requestsByClientId) {
      if (now - tombstone.createdAtMs > this.tombstoneTtlMs) {
        this.requestsByClientId.delete(clientRequestId);
      }
    }
    while (this.requestsByClientId.size > this.tombstoneLimit) {
      const oldest = this.requestsByClientId.keys().next().value;
      if (!oldest) break;
      this.requestsByClientId.delete(oldest);
    }

    const cachedResults = [...this.jobsById.entries()]
      .filter(([, record]) => record.result && record.resultCachedAtMs !== undefined)
      .sort(([, left], [, right]) => (left.resultCachedAtMs ?? 0) - (right.resultCachedAtMs ?? 0));
    let cachedBytes = cachedResults.reduce((total, [, record]) => total + (record.resultBytes ?? 0), 0);
    for (const [, record] of cachedResults) {
      const expired = now - (record.resultCachedAtMs ?? 0) > this.resultTtlMs;
      if (!expired && cachedBytes <= this.resultCacheBytes) continue;
      cachedBytes -= record.resultBytes ?? 0;
      record.result = undefined;
      record.resultBytes = undefined;
      record.resultCachedAtMs = undefined;
    }

    for (const [jobId, record] of this.jobsById) {
      if (isTerminal(record.snapshot.status) && now - record.createdAtMs > this.jobMetadataTtlMs) {
        this.jobsById.delete(jobId);
      }
    }
    while (this.jobsById.size > this.jobMetadataLimit) {
      const removable = [...this.jobsById.entries()].find(([, record]) =>
        isTerminal(record.snapshot.status),
      );
      if (!removable) break;
      this.jobsById.delete(removable[0]);
    }
  }
}
