import { describe, expect, it } from "vitest";
import { compileSourceImagePrompt } from "./promptTemplates.js";

describe("compileSourceImagePrompt", () => {
  it("combines the base template, user prompt and negative constraints", () => {
    const prompt = compileSourceImagePrompt({
      mode: "text_to_image",
      basePrompt: "Base",
      userPrompt: "A knight",
      negativePrompt: "No text",
    });

    expect(prompt).toContain("Base");
    expect(prompt).toContain("A knight");
    expect(prompt).toContain("Negative constraints: No text");
  });

  it("adds the image-change intention only for image-to-image requests", () => {
    const prompt = compileSourceImagePrompt({
      mode: "image_to_image",
      basePrompt: "Base",
      userPrompt: "Add armor",
      negativePrompt: "",
      changeIntent: "preserve",
    });

    expect(prompt).toContain("Preserve the reference image identity");
  });
});
