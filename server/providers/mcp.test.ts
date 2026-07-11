import { describe, expect, it } from "vitest";
import type { SourceImageGenerateRequest } from "../../src/core/sourceImage";
import {
  MCP_IMAGE_PROFILES,
  buildMcpProfileArguments,
  parseMcpImageResult,
  type McpTool,
} from "./mcp";

const imageFields = Array.from({ length: 10 }, (_, index) => `图像输入${index + 1}`);
const imageProperties = Object.fromEntries(imageFields.map((field) => [field, { type: "string" }]));

const request: SourceImageGenerateRequest = {
  provider: "mcp_banana",
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

const bananaEditTool: McpTool = {
  name: MCP_IMAGE_PROFILES[0].imageToImageTool,
  inputSchema: {
    type: "object",
    properties: {
      文本输入: { type: "string" },
      ...imageProperties,
      aspectRatio: { type: "string" },
      resolution: { type: "string" },
    },
    required: ["文本输入", ...imageFields],
  },
};

describe("MCP image provider", () => {
  it("maps Banana editing fields and fills schema-bug optional image slots", () => {
    const args = buildMcpProfileArguments(
      bananaEditTool,
      request,
      MCP_IMAGE_PROFILES[0],
      "https://assets.example/reference.png",
    );
    expect(args).toMatchObject({
      文本输入: request.userPrompt,
      图像输入1: "https://assets.example/reference.png",
      图像输入2: "",
      图像输入10: "",
      aspectRatio: "1:1",
      resolution: "1K",
    });
  });

  it("maps Image2 size and quality while allowing text-only generation", () => {
    const image2 = MCP_IMAGE_PROFILES[1];
    const tool: McpTool = {
      name: image2.textToImageTool,
      inputSchema: {
        type: "object",
        properties: {
          文本输入: { type: "string" },
          ...imageProperties,
          size: { type: "string" },
          quality: { type: "string" },
          background: { type: "string" },
        },
        required: ["文本输入", ...imageFields],
      },
    };
    const args = buildMcpProfileArguments(
      tool,
      { ...request, provider: "mcp_image2", mode: "text_to_image", aspectRatio: "16:9", quality: "high", referenceImage: undefined },
      image2,
      "https://assets.example/transparent.png",
    );
    expect(args).toMatchObject({
      文本输入: request.userPrompt,
      图像输入1: "https://assets.example/transparent.png",
      图像输入10: "https://assets.example/transparent.png",
      size: "1824x1024",
      quality: "high",
      background: "opaque",
    });
  });

  it("refuses unmapped required fields", () => {
    const incompatible: McpTool = {
      ...bananaEditTool,
      inputSchema: { ...bananaEditTool.inputSchema, required: ["文本输入", ...imageFields, "workspace_id"] },
    };
    expect(() =>
      buildMcpProfileArguments(
        incompatible,
        request,
        MCP_IMAGE_PROFILES[0],
        "https://assets.example/reference.png",
      ),
    ).toThrow("workspace_id");
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

  it("extracts a remote result URL without accepting non-raster inline data", () => {
    const previousServerUrl = process.env.MCP_SERVER_URL;
    process.env.MCP_SERVER_URL = "https://canvas.dxx.cn/api/mcp/sse";
    const parsed = parseMcpImageResult({
      content: [
        { type: "image", data: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml" },
        { type: "text", text: JSON.stringify({ 图像输出: "/assets/result.png" }) },
      ],
    });
    expect(parsed.images).toHaveLength(0);
    expect(parsed.remoteUrl).toBe("https://canvas.dxx.cn/assets/result.png");
    if (previousServerUrl === undefined) delete process.env.MCP_SERVER_URL;
    else process.env.MCP_SERVER_URL = previousServerUrl;
  });

  it("does not accept a tool error as an image result", () => {
    expect(() => parseMcpImageResult({ isError: true, content: [] })).toThrow(
      "reported an error",
    );
  });
});
