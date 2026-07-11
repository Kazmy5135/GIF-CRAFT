import type {
  ProviderCapabilities,
  McpToolSummary,
  SourceImageErrorResponse,
  SourceImageGenerateRequest,
  SourceImageGenerateResponse,
} from "../../core/sourceImage";

export class SourceImageApiError extends Error {
  constructor(
    message: string,
    public readonly code: SourceImageErrorResponse["error"]["code"] = "request_failed",
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

export async function fetchMcpTools(): Promise<McpToolSummary[]> {
  const response = await fetch("/api/mcp/tools");
  const payload = (await response.json()) as
    | { tools?: McpToolSummary[] }
    | SourceImageErrorResponse;
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.error.message : "无法读取 MCP 工具列表。";
    throw new SourceImageApiError(message);
  }
  return payload.tools || [];
}

export async function fetchProviders(): Promise<ProviderCapabilities[]> {
  const response = await fetch("/api/providers");
  if (!response.ok) throw new SourceImageApiError("无法读取 API 服务状态。");
  const payload = (await response.json()) as { providers?: ProviderCapabilities[] };
  return payload.providers || [];
}

export async function generateSourceImages(
  request: SourceImageGenerateRequest,
): Promise<SourceImageGenerateResponse> {
  const response = await fetch("/api/source-images/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  const payload = (await response.json()) as
    | SourceImageGenerateResponse
    | SourceImageErrorResponse;

  if (!response.ok || "error" in payload) {
    const error = "error" in payload ? payload.error : undefined;
    throw new SourceImageApiError(
      error?.message || "生成请求失败。",
      error?.code,
      error?.requestId,
    );
  }

  return payload;
}
