export const providerIds = ["gemini", "openai"] as const;
export type ProviderId = (typeof providerIds)[number];

export const sourceImageModes = [
  "text_to_image",
  "image_to_image",
  "local_upload",
] as const;
export type SourceImageMode = (typeof sourceImageModes)[number];

export const aspectRatios = ["1:1", "3:2", "2:3", "16:9", "9:16"] as const;
export type AspectRatio = (typeof aspectRatios)[number];

export const qualityLevels = ["draft", "standard", "high"] as const;
export type QualityLevel = (typeof qualityLevels)[number];

export type SourceImageTaskStatus =
  | "idle"
  | "validating"
  | "submitting"
  | "generating"
  | "succeeded"
  | "failed"
  | "status_unknown";

export interface PromptSettings {
  basePrompt: string;
  negativePrompt: string;
  version: number;
}

export interface ReferenceImageSnapshot {
  name: string;
  mimeType: string;
  data: string;
  width: number;
  height: number;
  size: number;
}

export interface SourceImageGenerateRequest {
  provider: ProviderId;
  mode: Exclude<SourceImageMode, "local_upload">;
  userPrompt: string;
  basePrompt: string;
  negativePrompt: string;
  changeIntent?: "preserve" | "balanced" | "creative";
  aspectRatio: AspectRatio;
  quality: QualityLevel;
  count: number;
  clientRequestId: string;
  referenceImage?: ReferenceImageSnapshot;
}

export interface GeneratedImagePayload {
  id: string;
  dataUrl: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface SourceImageGenerateResponse {
  jobId: string;
  status: "succeeded";
  provider: ProviderId;
  model: string;
  compiledPrompt: string;
  effectiveParameters: {
    aspectRatio: AspectRatio;
    quality: QualityLevel;
    count: number;
    providerSize: string;
  };
  images: GeneratedImagePayload[];
  providerNote?: string;
}

export interface ProviderCapabilities {
  id: ProviderId;
  name: string;
  configured: boolean;
  model: string;
  supportsTextToImage: boolean;
  supportsImageToImage: boolean;
  supportsMultipleImages: boolean;
  supportsTransparentBackground: boolean;
  supportsCancellation: boolean;
  aspectRatios: AspectRatio[];
  qualityLevels: QualityLevel[];
}

export interface SourceImageAsset {
  id: string;
  jobId: string;
  provider: ProviderId | "local";
  model: string;
  mode: SourceImageMode;
  createdAt: string;
  dataUrl: string;
  mimeType: string;
  width?: number;
  height?: number;
  sourceName?: string;
  promptSnapshot: {
    userPrompt: string;
    basePrompt: string;
    negativePrompt: string;
    compiledPrompt: string;
    templateVersion: number;
  };
  effectiveParameters: {
    aspectRatio: AspectRatio;
    quality: QualityLevel;
    providerSize: string;
  };
  referenceImage?: ReferenceImageSnapshot;
}

export interface SourceImageErrorResponse {
  error: {
    code: "request_failed" | "status_unknown" | "no_valid_image";
    message: string;
    requestId?: string;
  };
}
