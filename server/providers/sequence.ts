import { randomUUID } from "node:crypto";
import type {
  ConfirmedSourceImageSnapshot,
  SequenceGenerationRequest,
  SequenceGenerationResult,
  SequenceProviderCapabilities,
} from "../../src/core/sequenceGeneration.js";
import { validateSequenceResult } from "../../src/core/sequenceGeneration.js";
import type { ReferenceImageSnapshot } from "../../src/core/sourceImage.js";
import { generateSequenceVideoWithMcp, getMcpProviderConfiguration } from "./mcp.js";
import {
  detectSequenceMediaCapability,
  normalizeSequenceVideo,
  type NormalizedSequenceMedia,
  type SequenceMediaCapability,
} from "./sequenceMedia.js";
import { ProviderRequestError } from "./types.js";

export const GORILLA_SEEDANCE_PROVIDER = "gorilla_seedance";
export const PROXY_INSTANCE_ID = randomUUID();

export type SequenceProviderCapabilitySummary = SequenceProviderCapabilities & {
  readonly configured: boolean;
  readonly model: string;
  readonly unavailabilityReason?: string;
  readonly providerDurationSeconds: readonly number[];
  readonly providerResolutions: readonly string[];
  readonly supportsLocalJobQuery: boolean;
  readonly proxyInstanceId: string;
};

export function getSequenceProviderCapabilities(
  mediaCapability: SequenceMediaCapability = detectSequenceMediaCapability(),
): SequenceProviderCapabilitySummary {
  const mcp = getMcpProviderConfiguration();
  const configured = mcp.generationConfigured && mediaCapability.available;
  const unavailabilityReason = !mcp.generationConfigured
    ? "MCP Server URL or token is not configured."
    : mediaCapability.available
      ? undefined
      : mediaCapability.reason;
  return {
    provider: GORILLA_SEEDANCE_PROVIDER,
    configured,
    model: "bytedance/doubao-seedance-2-0-fast",
    proxyInstanceId: PROXY_INSTANCE_ID,
    ...(unavailabilityReason ? { unavailabilityReason } : {}),
    supportsImageToSequence: true,
    // Gorilla exposes one synchronous tool call, not the provider operation ID.
    supportsAsyncQuery: false,
    supportsLocalJobQuery: true,
    supportsCancellation: false,
    supportsRandomSeed: false,
    supportsRealProgress: false,
    inputMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    frameCounts: [8, 12],
    frameRates: [8, 12],
    aspectRatios: ["1:1"],
    providerDurationSeconds: [4],
    providerResolutions: ["480p"],
    outputMimeTypes: ["video/mp4"],
    outputShape: "video",
    // Temporal resampling from a lossy H.264 video is deliberately not labelled lossless.
    canNormalizeLosslessly: false,
  };
}

function sourceSnapshotToReference(
  source: ConfirmedSourceImageSnapshot,
  sourceImageDataUrl: string,
): ReferenceImageSnapshot {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(
    sourceImageDataUrl,
  );
  if (!match || match[1] !== source.mimeType) {
    throw new ProviderRequestError("Confirmed source image must be a matching image data URL.", {
      kind: "invalid_request",
      retryable: false,
    });
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.length !== source.size || bytes.length > 15 * 1024 * 1024) {
    throw new ProviderRequestError("Confirmed source image content size is invalid.", {
      kind: "invalid_request",
      retryable: false,
    });
  }
  return {
    name: `sequence-source.${source.mimeType === "image/jpeg" ? "jpg" : source.mimeType.slice(6)}`,
    mimeType: source.mimeType,
    data: match[2],
    width: source.width,
    height: source.height,
    size: source.size,
  };
}

export interface SequenceExecutionContext {
  readonly jobId: string;
  update(status: "generating" | "processing", stage: string): void;
}

export interface SequenceProviderDependencies {
  generateVideo?: typeof generateSequenceVideoWithMcp;
  normalizeVideo?: (
    remoteUrl: string,
    frameCount: 8 | 12,
    jobId: string,
  ) => Promise<NormalizedSequenceMedia>;
}

export async function executeGorillaSequence(
  request: SequenceGenerationRequest,
  sourceImageDataUrl: string,
  context: SequenceExecutionContext,
  dependencies: SequenceProviderDependencies = {},
): Promise<SequenceGenerationResult> {
  if (request.provider !== GORILLA_SEEDANCE_PROVIDER) {
    throw new ProviderRequestError("Sequence provider is not supported.", {
      kind: "capability",
      retryable: false,
    });
  }
  const parameters = request.effectiveParameters;
  if (
    ![8, 12].includes(parameters.frameCount) ||
    ![8, 12].includes(parameters.frameRate) ||
    parameters.canvas.aspectRatio !== "1:1" ||
    parameters.canvas.width !== 480 ||
    parameters.canvas.height !== 480 ||
    parameters.randomSeed !== null
  ) {
    throw new ProviderRequestError("Effective sequence parameters do not match provider capabilities.", {
      kind: "invalid_request",
      retryable: false,
    });
  }
  const requestedModel = request.providerExtensions?.model;
  if (requestedModel !== undefined && requestedModel !== "fast" && requestedModel !== "standard") {
    throw new ProviderRequestError("Unsupported Seedance model selection.", {
      kind: "capability",
      retryable: false,
    });
  }

  context.update("generating", "provider_generation");
  const providerResult = await (dependencies.generateVideo || generateSequenceVideoWithMcp)({
    prompt: request.promptSnapshot.compiledText,
    referenceImage: sourceSnapshotToReference(request.source, sourceImageDataUrl),
    model: requestedModel === "standard" ? "standard" : "fast",
    loop: parameters.loopMode === "loop",
  });

  context.update("processing", "video_normalization");
  let normalized: NormalizedSequenceMedia;
  try {
    normalized = await (dependencies.normalizeVideo || normalizeSequenceVideo)(
      providerResult.remoteUrl,
      parameters.frameCount as 8 | 12,
      context.jobId,
    );
  } catch (error) {
    if (
      error instanceof ProviderRequestError &&
      (error.kind === "partial_result" || error.kind === "invalid_result")
    ) {
      throw error;
    }
    throw new ProviderRequestError("Provider video could not be normalized safely.", {
      kind: "invalid_result",
      retryable: false,
    });
  }
  const frames = normalized.frames.map((frame) => ({ ...frame, readable: true }));
  const validatedAt = new Date().toISOString();
  const integrity = validateSequenceResult(
    frames,
    parameters.frameCount,
    validatedAt,
    undefined,
    context.jobId,
  );
  if (integrity.status !== "complete") {
    throw new ProviderRequestError("Normalized sequence result failed integrity validation.", {
      kind: "invalid_result",
      retryable: false,
    });
  }
  return { jobId: context.jobId, frames, integrity };
}
