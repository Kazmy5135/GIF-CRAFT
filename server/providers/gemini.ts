import type { SourceImageGenerateRequest } from "../../src/core/sourceImage.js";
import { extractGeminiImages, getProviderErrorSummary } from "./imageParsing.js";
import { ProviderRequestError, type ProviderGenerationResult } from "./types.js";

const qualityToImageSize = {
  draft: "1K",
  standard: "2K",
  high: "4K",
} as const;

export async function generateWithGemini(
  request: SourceImageGenerateRequest,
  apiKey: string,
  model: string,
): Promise<ProviderGenerationResult> {
  const imageSize = qualityToImageSize[request.quality];
  const input =
    request.mode === "image_to_image" && request.referenceImage
      ? [
          { type: "image", mime_type: request.referenceImage.mimeType, data: request.referenceImage.data },
          { type: "text", text: request.userPrompt },
        ]
      : request.userPrompt;

  const requests = Array.from({ length: request.count }, async () => {
    let response: Response;
    try {
      response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model,
          input,
          response_format: {
            type: "image",
            mime_type: "image/png",
            aspect_ratio: request.aspectRatio,
            image_size: imageSize,
          },
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      throw new ProviderRequestError(
        error instanceof Error ? error.message : "Gemini request status is unknown",
        true,
      );
    }

    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ProviderRequestError(getProviderErrorSummary(payload));
    }
    return extractGeminiImages(payload);
  });

  const images = (await Promise.all(requests)).flat();
  return {
    model,
    providerSize: `${request.aspectRatio} ${imageSize}`,
    images,
  };
}
