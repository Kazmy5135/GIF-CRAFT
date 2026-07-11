import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type {
  GeneratedImagePayload,
  ProviderId,
  ReferenceImageSnapshot,
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

export interface McpImageProfile {
  id: Extract<ProviderId, "mcp_banana" | "mcp_image2">;
  name: string;
  textToImageTool: string;
  imageToImageTool: string;
  uploadTool: string;
  promptField: string;
  imageFields: string[];
  aspectRatioField?: string;
  resolutionField?: string;
  sizeField?: string;
  qualityField?: string;
  backgroundField?: string;
  duplicateImageAcrossFields?: boolean;
  requiresTextPlaceholder?: boolean;
}

export interface McpProviderConfiguration {
  url: string;
  hasToken: boolean;
  discoveryConfigured: boolean;
  generationConfigured: boolean;
}

const MAX_TOOL_COUNT = 100;
const MAX_IMAGE_DATA_LENGTH = 32 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMAGE_FIELDS = [
  "图像输入1",
  "图像输入2",
  "图像输入3",
  "图像输入4",
  "图像输入5",
  "图像输入6",
  "图像输入7",
  "图像输入8",
  "图像输入9",
  "图像输入10",
];

export const MCP_IMAGE_PROFILES: McpImageProfile[] = [
  {
    id: "mcp_banana",
    name: "Gorilla Banana",
    textToImageTool: "flowspace_module_1774248671772_hmmgdw",
    imageToImageTool: "flowspace_module_1774928100822_ltprtx",
    uploadTool: "gorilla_upload_media",
    promptField: "文本输入",
    imageFields: IMAGE_FIELDS,
    aspectRatioField: "aspectRatio",
    resolutionField: "resolution",
  },
  {
    id: "mcp_image2",
    name: "Gorilla OpenAI Image2",
    textToImageTool: "flowspace_module_1776858044139_c8c3gg",
    imageToImageTool: "flowspace_module_1776858044139_c8c3gg",
    uploadTool: "gorilla_upload_media",
    promptField: "文本输入",
    imageFields: IMAGE_FIELDS,
    sizeField: "size",
    qualityField: "quality",
    backgroundField: "background",
    duplicateImageAcrossFields: true,
    requiresTextPlaceholder: true,
  },
];

const BLANK_PLACEHOLDER: ReferenceImageSnapshot = {
  name: "gif-craft-blank-placeholder.png",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAL3SURBVHhe7dQBAQAACMMg+5e+QQYhuAFZAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAwgQAYQKAMAFAmAAgTAAQJgAIEwCECQDCBABhAoAwAUCYACBMABAmAAgTAIQJAMIEAGECgDABQJgAIEwAECYACBMAhAkAsrYH5lA7xVAlcS4AAAAASUVORK5CYII=",
  width: 256,
  height: 256,
  size: 866,
};
let placeholderAssetCache: { serverUrl: string; assetUrl: string } | undefined;

export function getMcpProviderConfiguration(): McpProviderConfiguration {
  const url = process.env.MCP_SERVER_URL?.trim() || "";
  const hasToken = Boolean(process.env.MCP_AUTH_TOKEN?.trim());
  return {
    url,
    hasToken,
    discoveryConfigured: Boolean(url && hasToken),
    generationConfigured: Boolean(url && hasToken),
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

function setToolField(
  tool: McpTool,
  fieldName: string | undefined,
  value: unknown,
  target: Record<string, unknown>,
): void {
  if (!fieldName) return;
  if (!tool.inputSchema.properties?.[fieldName]) {
    throw new ProviderRequestError(`MCP tool is missing the mapped field: ${fieldName}`);
  }
  target[fieldName] = value;
}

function bananaResolution(quality: SourceImageGenerateRequest["quality"]): string {
  return quality === "draft" ? "0.5K" : quality === "high" ? "2K" : "1K";
}

function image2Size(aspectRatio: SourceImageGenerateRequest["aspectRatio"]): string {
  return {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "16:9": "1824x1024",
    "9:16": "1024x1824",
  }[aspectRatio];
}

function image2Quality(quality: SourceImageGenerateRequest["quality"]): string {
  return quality === "draft" ? "low" : quality === "high" ? "high" : "medium";
}

export function buildMcpProfileArguments(
  tool: McpTool,
  request: SourceImageGenerateRequest,
  profile: McpImageProfile,
  uploadedAssetUrl?: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  setToolField(tool, profile.promptField, request.userPrompt, args);

  if (profile.imageFields.length > 0 && tool.inputSchema.properties?.[profile.imageFields[0]]) {
    profile.imageFields.forEach((field, index) => {
      const useAsset = Boolean(
        uploadedAssetUrl && (index === 0 || profile.duplicateImageAcrossFields),
      );
      setToolField(tool, field, useAsset ? uploadedAssetUrl : "", args);
    });
  }
  if (request.mode === "image_to_image" && !uploadedAssetUrl) {
    throw new ProviderRequestError("MCP image-to-image request requires an uploaded asset URL.");
  }

  setToolField(tool, profile.aspectRatioField, request.aspectRatio, args);
  setToolField(tool, profile.resolutionField, bananaResolution(request.quality), args);
  setToolField(tool, profile.sizeField, image2Size(request.aspectRatio), args);
  setToolField(tool, profile.qualityField, image2Quality(request.quality), args);
  setToolField(tool, profile.backgroundField, "opaque", args);

  const missingRequired = (tool.inputSchema.required || []).filter((field) => !(field in args));
  if (missingRequired.length > 0) {
    throw new ProviderRequestError(
      `MCP tool mapping is incomplete. Required fields: ${missingRequired.join(", ")}`,
    );
  }
  return args;
}

function validRemoteUrl(value: string): string | undefined {
  try {
    const mcpUrl = validatedMcpUrl(getMcpProviderConfiguration().url);
    const relativeAsset = value.startsWith("/assets/");
    const url = relativeAsset ? new URL(value, mcpUrl.origin) : new URL(value);
    const configuredHosts = (process.env.MCP_ASSET_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    const allowedHosts = new Set([mcpUrl.hostname.toLowerCase(), ...configuredHosts]);
    return url.protocol === "https:" && allowedHosts.has(url.hostname.toLowerCase())
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function findNamedUrl(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !value) return undefined;
  if (typeof value === "string") {
    try {
      return findNamedUrl(JSON.parse(value), depth + 1);
    } catch {
      if (value.startsWith("/assets/")) return validRemoteUrl(value);
      const match = value.match(/https?:\/\/[^\s"'<>]+/);
      return match ? validRemoteUrl(match[0]) : undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNamedUrl(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["assetUrl", "imageUrl", "outputUrl", "url"]) {
    if (typeof record[key] === "string") {
      const found = validRemoteUrl(record[key]);
      if (found) return found;
    }
  }
  for (const item of Object.values(record)) {
    const found = findNamedUrl(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findResultUrl(result: McpCallResult): string | undefined {
  return findNamedUrl(result.structuredContent) || findNamedUrl(result.content);
}

function findAssetReference(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !value) return undefined;
  if (typeof value === "string") {
    try {
      return findAssetReference(JSON.parse(value), depth + 1);
    } catch {
      return value.startsWith("/assets/") ? value : validRemoteUrl(value);
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAssetReference(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.assetUrl === "string") {
    return record.assetUrl.startsWith("/assets/")
      ? record.assetUrl
      : validRemoteUrl(record.assetUrl);
  }
  for (const item of Object.values(record)) {
    const found = findAssetReference(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function uploadReferenceImage(
  client: Client,
  tool: McpTool,
  image: ReferenceImageSnapshot,
): Promise<string> {
  const result = (await client.callTool(
    {
      name: tool.name,
      arguments: {
        dataUrl: `data:${image.mimeType};base64,${image.data}`,
        filename: image.name,
        purpose: "reference_image",
      },
    },
    undefined,
    { timeout: 60_000 },
  )) as McpCallResult;
  if (result.isError) throw new ProviderRequestError("MCP media upload failed.");
  const assetUrl = findAssetReference(result);
  if (!assetUrl) throw new ProviderRequestError("MCP upload returned no asset URL.");
  return assetUrl;
}

async function getTextPlaceholderAsset(client: Client, uploadTool: McpTool): Promise<string> {
  const serverUrl = getMcpProviderConfiguration().url;
  if (placeholderAssetCache?.serverUrl === serverUrl) return placeholderAssetCache.assetUrl;
  const assetUrl = await uploadReferenceImage(client, uploadTool, BLANK_PLACEHOLDER);
  placeholderAssetCache = { serverUrl, assetUrl };
  return assetUrl;
}

function imageFromBase64(data: string, mimeType: string): GeneratedImagePayload | undefined {
  if (!ALLOWED_IMAGE_TYPES.has(mimeType) || !data || data.length > MAX_IMAGE_DATA_LENGTH) return undefined;
  return { id: randomUUID(), dataUrl: `data:${mimeType};base64,${data}`, mimeType };
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
  remoteUrl?: string;
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
    remoteUrl: findResultUrl(result),
  };
}

async function downloadMcpImage(remoteUrl: string): Promise<GeneratedImagePayload> {
  const response = await fetch(remoteUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new ProviderRequestError("MCP image URL could not be downloaded.");
  if (!validRemoteUrl(response.url)) {
    throw new ProviderRequestError("MCP image URL redirected outside the configured allowlist.");
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "";
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new ProviderRequestError("MCP image URL returned an unsupported format.");
  }
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 24 * 1024 * 1024) {
    throw new ProviderRequestError("MCP image result is too large.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 24 * 1024 * 1024) {
    throw new ProviderRequestError("MCP image result is empty or too large.");
  }
  return {
    id: randomUUID(),
    dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    mimeType,
  };
}

export async function generateWithMcp(
  request: SourceImageGenerateRequest,
): Promise<ProviderGenerationResult> {
  const config = getMcpProviderConfiguration();
  const profile = MCP_IMAGE_PROFILES.find((item) => item.id === request.provider);
  if (!config.generationConfigured || !profile) {
    throw new ProviderRequestError("MCP image provider is not configured.");
  }
  const toolName = request.mode === "text_to_image" ? profile.textToImageTool : profile.imageToImageTool;

  return withMcpClient(async (client) => {
    const tools = await listToolsWithClient(client);
    const tool = tools.find((item) => item.name === toolName);
    const uploadTool = tools.find((item) => item.name === profile.uploadTool);
    if (!tool) throw new ProviderRequestError("Configured MCP image tool was not found.");

    let uploadedAssetUrl: string | undefined;
    if (request.mode === "image_to_image") {
      if (!request.referenceImage || !uploadTool) {
        throw new ProviderRequestError("MCP image upload tool or reference image is missing.");
      }
      uploadedAssetUrl = await uploadReferenceImage(client, uploadTool, request.referenceImage);
    } else if (profile.requiresTextPlaceholder) {
      if (!uploadTool) throw new ProviderRequestError("MCP image upload tool is missing.");
      uploadedAssetUrl = await getTextPlaceholderAsset(client, uploadTool);
    }

    let result: McpCallResult;
    try {
      result = (await client.callTool(
        {
          name: toolName,
          arguments: buildMcpProfileArguments(tool, request, profile, uploadedAssetUrl),
        },
        undefined,
        { timeout: 180_000 },
      )) as McpCallResult;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      throw new ProviderRequestError("MCP image generation failed.", message.includes("timeout"));
    }

    const parsed = parseMcpImageResult(result);
    if (parsed.images.length === 0 && parsed.remoteUrl) {
      parsed.images.push(await downloadMcpImage(parsed.remoteUrl));
    }
    if (parsed.images.length === 0) {
      throw new ProviderRequestError("MCP tool returned no supported image.");
    }
    return {
      model: `mcp:${toolName}`,
      providerSize: `${request.aspectRatio} · ${profile.name}`,
      images: parsed.images,
      providerNote: parsed.note,
    };
  });
}
