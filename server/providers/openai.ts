import type { SourceImageGenerateRequest } from "../../src/core/sourceImage.js";
import { extractOpenAIImages, getProviderErrorSummary } from "./imageParsing.js";
import { ProviderRequestError, type ProviderGenerationResult } from "./types.js";

const qualityMap = {
  draft: "low",
  standard: "medium",
  high: "high",
} as const;

const sizeMap = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1536x864",
  "9:16": "864x1536",
} as const;

function base64ToBlob(data: string, mimeType: string): Blob {
  const bytes = Buffer.from(data, "base64");
  return new Blob([bytes], { type: mimeType });
}

export async function generateWithOpenAI(
  request: SourceImageGenerateRequest,
  apiKey: string,
  model: string,
): Promise<ProviderGenerationResult> {
  const size = sizeMap[request.aspectRatio];
  const quality = qualityMap[request.quality];
  let response: Response;

  try {
    if (request.mode === "image_to_image" && request.referenceImage) {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", request.userPrompt);
      form.append("image[]", base64ToBlob(request.referenceImage.data, request.referenceImage.mimeType), request.referenceImage.name);
      form.append("n", String(request.count));
      form.append("size", size);
      form.append("quality", quality);
      form.append("output_format", "png");

      response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
    } else {
      response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt: request.userPrompt,
          n: request.count,
          size,
          quality,
          output_format: "png",
        }),
        signal: AbortSignal.timeout(180_000),
      });
    }
  } catch (error) {
    throw new ProviderRequestError(
      error instanceof Error ? error.message : "OpenAI request status is unknown",
      true,
    );
  }

  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ProviderRequestError(getProviderErrorSummary(payload));
  }

  return {
    model,
    providerSize: size,
    images: extractOpenAIImages(payload),
    providerNote: "GPT Image 2 uses high-fidelity reference inputs automatically.",
  };
}
