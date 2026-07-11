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

export type ProviderErrorKind =
  | "invalid_request"
  | "capability"
  | "authentication"
  | "rate_limit"
  | "request_failed"
  | "status_unknown"
  | "invalid_result"
  | "partial_result";

export interface ProviderRequestErrorOptions {
  kind?: ProviderErrorKind;
  retryable?: boolean;
  statusUnknown?: boolean;
}

export class ProviderRequestError extends Error {
  public readonly statusUnknown: boolean;
  public readonly kind: ProviderErrorKind;
  public readonly retryable: boolean;

  constructor(
    message: string,
    statusUnknownOrOptions: boolean | ProviderRequestErrorOptions = false,
  ) {
    super(message);
    const options =
      typeof statusUnknownOrOptions === "boolean"
        ? { statusUnknown: statusUnknownOrOptions }
        : statusUnknownOrOptions;
    this.statusUnknown = Boolean(options.statusUnknown || options.kind === "status_unknown");
    this.kind = this.statusUnknown ? "status_unknown" : options.kind || "request_failed";
    this.retryable = options.retryable ?? this.kind === "request_failed";
  }
}

export type ProviderGenerator = (
  request: SourceImageGenerateRequest,
) => Promise<ProviderGenerationResult>;
