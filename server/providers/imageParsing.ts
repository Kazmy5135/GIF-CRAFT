import { randomUUID } from "node:crypto";
import type { GeneratedImagePayload } from "../../src/core/sourceImage.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractGeminiImages(payload: unknown): GeneratedImagePayload[] {
  const seen = new Set<string>();
  const images: GeneratedImagePayload[] = [];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (!isRecord(value)) return;

    const candidateData =
      typeof value.data === "string" &&
      (value.type === "image" || "mime_type" in value || "mimeType" in value)
        ? value.data
        : undefined;

    if (candidateData && !seen.has(candidateData)) {
      const mimeType =
        (typeof value.mime_type === "string" && value.mime_type) ||
        (typeof value.mimeType === "string" && value.mimeType) ||
        "image/png";
      seen.add(candidateData);
      images.push({
        id: randomUUID(),
        dataUrl: `data:${mimeType};base64,${candidateData}`,
        mimeType,
      });
    }

    Object.values(value).forEach(visit);
  }

  if (isRecord(payload)) {
    if ("output_image" in payload) {
      visit(payload.output_image);
    }
    if (Array.isArray(payload.steps)) {
      payload.steps.forEach((step) => {
        if (isRecord(step) && step.type === "model_output") visit(step.content);
      });
    }
  }
  return images;
}

export function extractOpenAIImages(payload: unknown): GeneratedImagePayload[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];

  return payload.data.flatMap((item) => {
    if (!isRecord(item) || typeof item.b64_json !== "string") return [];
    const mimeType = "image/png";
    return [
      {
        id: randomUUID(),
        dataUrl: `data:${mimeType};base64,${item.b64_json}`,
        mimeType,
      },
    ];
  });
}

export function getProviderErrorSummary(payload: unknown): string {
  if (!isRecord(payload)) return "Provider request failed";
  const error = isRecord(payload.error) ? payload.error : undefined;
  if (error && typeof error.message === "string") {
    return error.message.slice(0, 240);
  }
  if (typeof payload.message === "string") {
    return payload.message.slice(0, 240);
  }
  return "Provider request failed";
}
