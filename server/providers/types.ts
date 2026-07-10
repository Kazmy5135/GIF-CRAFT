import type {
  GeneratedImagePayload,
  SourceImageGenerateRequest,
} from "../../src/core/sourceImage.js";

export interface ProviderGenerationResult {
  model: string;
  providerSize: string;
  images: GeneratedImagePayload[];
  providerNote?: string;
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    public readonly statusUnknown = false,
  ) {
    super(message);
  }
}

export type ProviderGenerator = (
  request: SourceImageGenerateRequest,
) => Promise<ProviderGenerationResult>;
