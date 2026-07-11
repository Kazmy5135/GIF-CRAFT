import { afterEach, describe, expect, it } from "vitest";
import type { SourceImageGenerateRequest } from "../../src/core/sourceImage";
import {
  buildMcpToolArguments,
  parseMcpImageResult,
  type McpTool,
} from "./mcp";

const request: SourceImageGenerateRequest = {
  provider: "mcp",
  mode: "image_to_image",
  userPrompt: "keep the character, change the pose",
  basePrompt: "game asset",
  negativePrompt: "duplicates",
  changeIntent: "preserve",
  aspectRatio: "1:1",
  quality: "standard",
  count: 1,
  clientRequestId: "c4455ce5-33e9-40cd-a25f-6f5e3b503a6f",
  referenceImage: {
    name: "hero.png",
    mimeType: "image/png",
    data: "aGVsbG8=",
    width: 64,
    height: 64,
    size: 5,
  },
};

const tool: McpTool = {
  name: "edit-image",
  inputSchema: {
    type: "object",
    properties: { prompt: { type: "string" }, image: { type: "string" } },
    required: ["prompt", "image"],
  },
};

describe("MCP image provider", () => {
  afterEach(() => {
    for (const key of [
      "MCP_PROMPT_FIELD",
      "MCP_IMAGE_FIELD",
      "MCP_IMAGE_FORMAT",
      "MCP_ASPECT_RATIO_FIELD",
      "MCP_QUALITY_FIELD",
      "MCP_COUNT_FIELD",
    ]) {
      delete process.env[key];
    }
  });

  it("maps only configured fields and uses a data URL for the reference image", () => {
    expect(buildMcpToolArguments(tool, request)).toEqual({
      prompt: request.userPrompt,
      image: "data:image/png;base64,aGVsbG8=",
    });
  });

  it("refuses a tool with unmapped required fields", () => {
    const incompatible: McpTool = {
      ...tool,
      inputSchema: { ...tool.inputSchema, required: ["prompt", "image", "workspace_id"] },
    };
    expect(() => buildMcpToolArguments(incompatible, request)).toThrow("workspace_id");
  });

  it("parses standard MCP image content and embedded image resources", () => {
    const parsed = parseMcpImageResult({
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        {
          type: "resource",
          resource: { uri: "memory://result", blob: "aGVsbG8=", mimeType: "image/webp" },
        },
        { type: "text", text: "generation complete" },
      ],
    });
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0].dataUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(parsed.note).toBe("generation complete");
  });

  it("does not accept a tool error as an image result", () => {
    expect(() => parseMcpImageResult({ isError: true, content: [] })).toThrow(
      "reported an error",
    );
  });

  it("rejects non-raster image content", () => {
    const parsed = parseMcpImageResult({
      content: [{ type: "image", data: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml" }],
    });
    expect(parsed.images).toHaveLength(0);
  });
});
