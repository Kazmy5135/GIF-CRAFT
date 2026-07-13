import type { GenerationJob } from "../../core/sequenceGeneration";
import type { SourceImageAsset } from "../../core/sourceImage";
import type { StoredGenerationJob } from "../../infrastructure/storage/sequenceJobRepository";

export function sourceAsset(overrides: Partial<SourceImageAsset> = {}): SourceImageAsset {
  return {
    id: "source-1",
    jobId: "source-job-1",
    provider: "local",
    model: "local-upload",
    mode: "local_upload",
    createdAt: "2026-07-13T09:00:00.000Z",
    confirmedAt: "2026-07-13T09:01:00.000Z",
    contentSnapshotId: `sha256:${"a".repeat(64)}`,
    dataUrl: "data:image/png;base64,AA==",
    mimeType: "image/png",
    width: 512,
    height: 512,
    size: 1,
    availability: "available",
    sourceName: "hero.png",
    promptSnapshot: {
      userPrompt: "hero",
      basePrompt: "",
      negativePrompt: "",
      compiledPrompt: "hero",
      templateVersion: 1,
    },
    effectiveParameters: {
      aspectRatio: "1:1",
      quality: "standard",
      providerSize: "512x512",
    },
    ...overrides,
  };
}

export function generationJob(
  status: GenerationJob["status"] = "completed",
  overrides: Partial<GenerationJob> = {},
): GenerationJob {
  const completed = status === "completed";
  const frameIds = completed
    ? Array.from({ length: 8 }, (_, index) => `frame-${index}`)
    : [];
  return {
    id: completed ? "job-completed" : `job-${status}`,
    clientRequestId: `request-${status}`,
    provider: "gorilla_seedance",
    request: {
      draftId: `draft-${status}`,
      clientRequestId: `request-${status}`,
      provider: "gorilla_seedance",
      source: {
        id: "source-1",
        confirmedAt: "2026-07-13T09:01:00.000Z",
        contentSnapshotId: `sha256:${"a".repeat(64)}`,
        resourceRef: "source-image:source-1",
        mimeType: "image/png",
        width: 512,
        height: 512,
        size: 1,
      },
      presetId: "character.idle.v1",
      presetVersion: 1,
      promptSnapshot: { layerRefs: [], userDescription: "idle", compiledText: "idle" },
      requestedParameters: {
        frameCount: 8,
        frameRate: 8,
        loopMode: "loop",
        canvas: { mode: "source", aspectRatio: "1:1", width: 512, height: 512 },
        anchor: "bottom_center_feet_baseline",
        randomSeed: null,
      },
      effectiveParameters: {
        frameCount: 8,
        frameRate: 8,
        loopMode: "loop",
        canvas: { mode: "source", aspectRatio: "1:1", width: 480, height: 480 },
        anchor: "bottom_center_feet_baseline",
        randomSeed: null,
      },
      parameterMappings: [],
      providerExtensions: { proxyInstanceId: "proxy-1" },
    },
    status,
    progress: null,
    stage: status,
    timestamps: {
      createdAt: "2026-07-13T09:02:00.000Z",
      updatedAt: completed ? "2026-07-13T09:04:00.000Z" : "2026-07-13T09:03:00.000Z",
    },
    retryCount: 0,
    frameIds,
    resultIntegrity: {
      status: completed ? "complete" : "pending",
      expectedFrameCount: 8,
      actualFrameCount: completed ? 8 : 0,
      issues: [],
    },
    ...overrides,
  };
}

export function storedJob(
  job: GenerationJob,
  overrides: Partial<StoredGenerationJob<GenerationJob>> = {},
): StoredGenerationJob<GenerationJob> {
  return {
    id: job.id,
    clientRequestId: job.clientRequestId,
    sourceImageId: job.request.source.id,
    provider: job.provider,
    status: job.status,
    createdAt: job.timestamps.createdAt,
    updatedAt: job.timestamps.updatedAt,
    resultStorageStatus: job.status === "completed" ? "available" : undefined,
    resultBytes: job.status === "completed" ? 8 : 0,
    job,
    ...overrides,
  };
}
