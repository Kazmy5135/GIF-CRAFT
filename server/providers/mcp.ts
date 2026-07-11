import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type {
  GeneratedImagePayload,
  SourceImageGenerateRequest,
} from "../../src/core/sourceImage.js";
import type { ProviderGenerationResult } from "./types.js";
import { ProviderRequestError } from "./types.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
}

interface McpCallResult {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpProviderConfiguration {
  url: string;
  hasToken: boolean;
  textToImageTool?: string;
  imageToImageTool?: string;
  discoveryConfigured: boolean;
  generationConfigured: boolean;
}

const MAX_TOOL_COUNT = 100;
const MAX_IMAGE_DATA_LENGTH = 32 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function getMcpProviderConfiguration(): McpProviderConfiguration {
  const url = process.env.MCP_SERVER_URL?.trim() || "";
  const hasToken = Boolean(process.env.MCP_AUTH_TOKEN?.trim());
  const textToImageTool = process.env.MCP_TEXT_TO_IMAGE_TOOL?.trim() || undefined;
  const imageToImageTool = process.env.MCP_IMAGE_TO_IMAGE_TOOL?.trim() || undefined;
  return {
    url,
    hasToken,
    textToImageTool,
    imageToImageTool,
    discoveryConfigured: Boolean(url && hasToken),
    generationConfigured: Boolean(url && hasToken && textToImageTool && imageToImageTool),
  };
}

function validatedMcpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderRequestError("MCP Server URL is invalid.");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new ProviderRequestError("MCP Server must use HTTPS unless it is local.");
  }
  return url;
}

async function withMcpClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const config = getMcpProviderConfiguration();
  if (!config.discoveryConfigured) {
    throw new ProviderRequestError("MCP Server URL or token is not configured.");
  }

  const client = new Client({ name: "gif-craft", version: "0.1.0" });
  const transport = new SSEClientTransport(validatedMcpUrl(config.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN?.trim()}` },
    },
  });

  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function listToolsWithClient(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
    tools.push(...(result.tools as McpTool[]));
    cursor = result.nextCursor;
    if (tools.length > MAX_TOOL_COUNT) {
      throw new ProviderRequestError("MCP Server returned too many tools.");
    }
  } while (cursor);
  return tools;
}

export async function listMcpTools(): Promise<McpTool[]> {
  return withMcpClient(listToolsWithClient);
}

function requireMappedField(
  tool: McpTool,
  fieldName: string,
  value: unknown,
  target: Record<string, unknown>,
): void {
  if (!tool.inputSchema.properties?.[fieldName]) {
    throw new ProviderRequestError(`MCP tool is missing the configured field: ${fieldName}`);
  }
  target[fieldName] = value;
}

function optionalMappedField(
  tool: McpTool,
  fieldName: string | undefined,
  value: unknown,
  target: Record<string, unknown>,
): void {
  if (!fieldName) return;
  requireMappedField(tool, fieldName, value, target);
}

export function buildMcpToolArguments(
  tool: McpTool,
  request: SourceImageGenerateRequest,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const promptField = process.env.MCP_PROMPT_FIELD?.trim() || "prompt";
  requireMappedField(tool, promptField, request.userPrompt, args);

  if (request.mode === "image_to_image") {
    if (!request.referenceImage) {
      throw new ProviderRequestError("MCP image-to-image request requires a reference image.");
    }
    const imageField = process.env.MCP_IMAGE_FIELD?.trim() || "image";
    const imageFormat = process.env.MCP_IMAGE_FORMAT?.trim() || "data-url";
    const image = request.referenceImage;
    const imageValue =
      imageFormat === "base64"
        ? image.data
        : imageFormat === "object"
          ? { data: image.data, mimeType: image.mimeType }
          : `data:${image.mimeType};base64,${image.data}`;
    requireMappedField(tool, imageField, imageValue, args);
  }

  optionalMappedField(tool, process.env.MCP_ASPECT_RATIO_FIELD?.trim(), request.aspectRatio, args);
  optionalMappedField(tool, process.env.MCP_QUALITY_FIELD?.trim(), request.quality, args);
  optionalMappedField(tool, process.env.MCP_COUNT_FIELD?.trim(), request.count, args);

  const missingRequired = (tool.inputSchema.required || []).filter((field) => !(field in args));
  if (missingRequired.length > 0) {
    throw new ProviderRequestError(
      `MCP tool mapping is incomplete. Required fields: ${missingRequired.join(", ")}`,
    );
  }
  return args;
}

function imageFromBase64(data: string, mimeType: string): GeneratedImagePayload | undefined {
  if (!ALLOWED_IMAGE_TYPES.has(mimeType) || !data || data.length > MAX_IMAGE_DATA_LENGTH) return undefined;
  return {
    id: randomUUID(),
    dataUrl: `data:${mimeType};base64,${data}`,
    mimeType,
  };
}

function imageFromDataUrl(value: string): GeneratedImagePayload | undefined {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/.exec(value);
  return match ? imageFromBase64(match[2], match[1]) : undefined;
}

function collectStructuredImages(value: unknown, images: GeneratedImagePayload[], depth = 0): void {
  if (depth > 5 || images.length >= 4) return;
  if (typeof value === "string") {
    const image = imageFromDataUrl(value);
    if (image) images.push(image);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStructuredImages(item, images, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.data === "string" && typeof record.mimeType === "string") {
    const image = imageFromBase64(record.data, record.mimeType);
    if (image) images.push(image);
  }
  Object.values(record).forEach((item) => collectStructuredImages(item, images, depth + 1));
}

export function parseMcpImageResult(result: McpCallResult): {
  images: GeneratedImagePayload[];
  note?: string;
} {
  if (result.isError) throw new ProviderRequestError("MCP tool reported an error.");
  const images: GeneratedImagePayload[] = [];
  const notes: string[] = [];

  for (const item of result.content || []) {
    if (!item || typeof item !== "object") continue;
    const content = item as Record<string, unknown>;
    if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") {
      const image = imageFromBase64(content.data, content.mimeType);
      if (image) images.push(image);
    } else if (content.type === "resource" && content.resource && typeof content.resource === "object") {
      const resource = content.resource as Record<string, unknown>;
      if (typeof resource.blob === "string" && typeof resource.mimeType === "string") {
        const image = imageFromBase64(resource.blob, resource.mimeType);
        if (image) images.push(image);
      }
    } else if (content.type === "text" && typeof content.text === "string") {
      const dataImage = imageFromDataUrl(content.text.trim());
      if (dataImage) images.push(dataImage);
      else notes.push(content.text.slice(0, 500));
    }
  }
  collectStructuredImages(result.structuredContent, images);

  return {
    images: images.slice(0, 4),
    note: notes.length ? notes.join("\n").slice(0, 1_000) : undefined,
  };
}

export async function generateWithMcp(
  request: SourceImageGenerateRequest,
): Promise<ProviderGenerationResult> {
  const config = getMcpProviderConfiguration();
  const toolName =
    request.mode === "text_to_image" ? config.textToImageTool : config.imageToImageTool;
  if (!config.generationConfigured || !toolName) {
    throw new ProviderRequestError("MCP image tools have not been selected.");
  }

  return withMcpClient(async (client) => {
    const listed = await listToolsWithClient(client);
    const tool = listed.find((item) => item.name === toolName);
    if (!tool) throw new ProviderRequestError("Configured MCP image tool was not found.");

    let result: McpCallResult;
    try {
      result = (await client.callTool(
        { name: toolName, arguments: buildMcpToolArguments(tool, request) },
        undefined,
        { timeout: 180_000 },
      )) as McpCallResult;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      throw new ProviderRequestError("MCP image generation failed.", message.includes("timeout"));
    }

    const parsed = parseMcpImageResult(result);
    if (parsed.images.length === 0) {
      throw new ProviderRequestError("MCP tool returned no supported inline image.");
    }
    return {
      model: `mcp:${toolName}`,
      providerSize: `${request.aspectRatio} · MCP`,
      images: parsed.images,
      providerNote: parsed.note,
    };
  });
}
