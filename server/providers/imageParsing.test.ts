import { describe, expect, it } from "vitest";
import { extractGeminiImages, extractOpenAIImages } from "./imageParsing.js";

describe("provider image parsing", () => {
  it("only reads Gemini model output images", () => {
    const result = extractGeminiImages({
      steps: [
        { type: "user_input", content: [{ type: "image", data: "input", mime_type: "image/png" }] },
        { type: "model_output", content: [{ type: "image", data: "output", mime_type: "image/png" }] },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].dataUrl).toContain("output");
  });

  it("reads OpenAI base64 image results", () => {
    const result = extractOpenAIImages({ data: [{ b64_json: "result" }] });
    expect(result).toHaveLength(1);
    expect(result[0].dataUrl).toContain("result");
  });
});
