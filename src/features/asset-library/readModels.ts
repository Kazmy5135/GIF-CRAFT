import {
  generationJobStatuses,
  sequencePresets,
  type GenerationJob,
  type GenerationJobStatus,
} from "../../core/sequenceGeneration";
import type { SourceImageAsset } from "../../core/sourceImage";
import type { StoredGenerationJob } from "../../infrastructure/storage/sequenceJobRepository";

export type SourceImageLibraryFilter =
  | "all"
  | "available"
  | "unconfirmed"
  | "unavailable";

export interface SourceImageLibraryItem {
  asset: SourceImageAsset;
  isCurrent: boolean;
  availability: Exclude<SourceImageLibraryFilter, "all">;
  sourceLabel: string;
  dimensionsLabel: string;
}

export type SequenceResourceStatus =
  | "available"
  | "purged"
  | "invalid"
  | "not_available";

export type SequenceLibraryFilter = "usable" | "all" | GenerationJobStatus;

export interface SequenceLibraryItem {
  record: StoredGenerationJob<GenerationJob>;
  job: GenerationJob;
  source: SourceImageAsset | null;
  sourceAvailable: boolean;
  presetLabel: string;
  resourceStatus: SequenceResourceStatus;
  usable: boolean;
}

export const sequenceStatusLabels: Record<GenerationJobStatus, string> = {
  draft: "草稿",
  validating: "校验中",
  ready: "等待提交",
  retrying: "准备重试",
  submitting: "提交中",
  queued: "已排队",
  generating: "生成中",
  processing: "处理中",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
  status_unknown: "状态未知",
  abandoned: "已放弃跟踪",
  cancelled: "已取消",
};

export const sequenceResourceStatusLabels: Record<SequenceResourceStatus, string> = {
  available: "资源可用",
  purged: "资源已清理",
  invalid: "资源不完整",
  not_available: "尚无可用资源",
};

export const sourceAvailabilityLabels: Record<
  Exclude<SourceImageLibraryFilter, "all">,
  string
> = {
  available: "可用",
  unconfirmed: "待确认",
  unavailable: "不可用",
};

export const allSequenceStatuses = generationJobStatuses;

function sourceAvailability(
  asset: SourceImageAsset,
): Exclude<SourceImageLibraryFilter, "all"> {
  if (asset.availability === "unavailable") return "unavailable";
  if (
    asset.availability === "available" &&
    asset.confirmedAt &&
    asset.contentSnapshotId
  ) {
    return "available";
  }
  return "unconfirmed";
}

export function buildSourceImageLibraryItems(
  assets: readonly SourceImageAsset[],
  currentSourceId: string | null,
): SourceImageLibraryItem[] {
  return [...assets]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((asset) => ({
      asset,
      isCurrent: asset.id === currentSourceId,
      availability: sourceAvailability(asset),
      sourceLabel:
        asset.mode === "local_upload"
          ? `本地上传${asset.sourceName ? ` · ${asset.sourceName}` : ""}`
          : `${asset.provider} · ${asset.model}`,
      dimensionsLabel:
        asset.width && asset.height
          ? `${asset.width} × ${asset.height}`
          : asset.effectiveParameters.providerSize || "尺寸未知",
    }));
}

export function filterSourceImageLibraryItems(
  items: readonly SourceImageLibraryItem[],
  filter: SourceImageLibraryFilter,
): SourceImageLibraryItem[] {
  return filter === "all"
    ? [...items]
    : items.filter((item) => item.availability === filter);
}

export function getSequenceResourceStatus(
  record: StoredGenerationJob<GenerationJob>,
): SequenceResourceStatus {
  if (record.resultStorageStatus === "purged") return "purged";
  if (record.job.status !== "completed") return "not_available";
  if (
    record.resultStorageStatus === "available" &&
    record.job.resultIntegrity.status === "complete" &&
    record.job.frameIds.length > 0 &&
    record.job.frameIds.length === record.job.request.effectiveParameters.frameCount
  ) {
    return "available";
  }
  return "invalid";
}

export function buildSequenceLibraryItems(
  records: readonly StoredGenerationJob<GenerationJob>[],
  sources: readonly SourceImageAsset[],
): SequenceLibraryItem[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return [...records]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((record) => {
      const source = sourceById.get(record.job.request.source.id) ?? null;
      const resourceStatus = getSequenceResourceStatus(record);
      return {
        record,
        job: record.job,
        source,
        sourceAvailable: Boolean(
          source?.availability === "available" &&
            source.confirmedAt &&
            source.contentSnapshotId === record.job.request.source.contentSnapshotId,
        ),
        presetLabel:
          sequencePresets[record.job.request.presetId]?.displayName ??
          record.job.request.presetId,
        resourceStatus,
        usable: resourceStatus === "available",
      };
    });
}

export function filterSequenceLibraryItems(
  items: readonly SequenceLibraryItem[],
  filter: SequenceLibraryFilter,
): SequenceLibraryItem[] {
  if (filter === "all") return [...items];
  if (filter === "usable") return items.filter((item) => item.usable);
  return items.filter((item) => item.job.status === filter);
}
