import type { SourceImageGenerateRequest } from "./sourceImage.js";

export const BUILT_IN_PROMPT_VERSION = 1;

export const BUILT_IN_BASE_PROMPT = [
  "Create a production-ready game art source image.",
  "Keep one clear primary subject, readable silhouette, coherent composition,",
  "consistent anatomy and costume details, and enough clean space around the subject.",
  "The result will be used as the reference image for a later animation workflow.",
].join(" ");

export const BUILT_IN_NEGATIVE_PROMPT = [
  "Avoid duplicate subjects, cropped body parts, extra limbs, missing limbs,",
  "identity drift, inconsistent costume, unreadable silhouette, random text,",
  "watermark, collage layout, split panels, and unintended frame borders.",
].join(" ");

const changeIntentPrompt: Record<
  NonNullable<SourceImageGenerateRequest["changeIntent"]>,
  string
> = {
  preserve:
    "Preserve the reference image identity, pose, composition, colors and important details as closely as possible.",
  balanced:
    "Preserve the recognizable identity and composition while applying the requested changes with moderate freedom.",
  creative:
    "Use the reference image as inspiration while allowing broader visual changes that still follow the requested direction.",
};

export function compileSourceImagePrompt(
  request: Omit<
    Pick<
    SourceImageGenerateRequest,
    "mode" | "basePrompt" | "userPrompt" | "negativePrompt" | "changeIntent"
    >,
    "changeIntent"
  > & { changeIntent?: SourceImageGenerateRequest["changeIntent"] },
): string {
  const sections = [request.basePrompt.trim(), request.userPrompt.trim()];

  if (request.mode === "image_to_image" && request.changeIntent) {
    sections.push(changeIntentPrompt[request.changeIntent]);
  }

  if (request.negativePrompt.trim()) {
    sections.push(`Negative constraints: ${request.negativePrompt.trim()}`);
  }

  return sections.filter(Boolean).join("\n\n");
}
