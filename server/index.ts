import { randomUUID } from "node:crypto";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import {
  aspectRatios,
  providerIds,
  qualityLevels,
  type ProviderCapabilities,
  type SourceImageGenerateRequest,
  type SourceImageGenerateResponse,
} from "../src/core/sourceImage.js";
import { compileSourceImagePrompt } from "../src/core/promptTemplates.js";
import { generateWithGemini } from "./providers/gemini.js";
import {
  MCP_IMAGE_PROFILES,
  generateWithMcp,
  getMcpProviderConfiguration,
  listMcpTools,
} from "./providers/mcp.js";
import { generateWithOpenAI } from "./providers/openai.js";
import { ProviderRequestError } from "./providers/types.js";
import {
  getSequenceProviderCapabilities,
  type SequenceProviderCapabilitySummary,
} from "./providers/sequence.js";
import { parseSequenceJobSubmission } from "./sequenceRequest.js";
import {
  SequenceJobConflictError,
  SequenceJobRateLimitError,
  SequenceJobService,
} from "./sequenceJobs.js";

const rootDir = process.cwd();

try {
  process.loadEnvFile(path.resolve(rootDir, ".env"));
} catch (error) {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code !== "ENOENT") throw error;
}

const referenceImageSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  size: z.number().int().positive().max(15 * 1024 * 1024),
});

const generateRequestSchema = z
  .object({
    provider: z.enum(providerIds),
    mode: z.enum(["text_to_image", "image_to_image"]),
    userPrompt: z.string().trim().min(1).max(12_000),
    basePrompt: z.string().max(12_000),
    negativePrompt: z.string().max(12_000),
    changeIntent: z.enum(["preserve", "balanced", "creative"]).optional(),
    aspectRatio: z.enum(aspectRatios),
    quality: z.enum(qualityLevels),
    count: z.number().int().min(1).max(4),
    clientRequestId: z.string().uuid(),
    referenceImage: referenceImageSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.mode === "image_to_image" && !value.referenceImage) {
      context.addIssue({
        code: "custom",
        path: ["referenceImage"],
        message: "Image-to-image mode requires a reference image.",
      });
    }
    if (value.mode === "image_to_image" && !value.changeIntent) {
      context.addIssue({
        code: "custom",
        path: ["changeIntent"],
        message: "Image-to-image mode requires a change intention.",
      });
    }
  });

function providerCapabilities(): ProviderCapabilities[] {
  const mcp = getMcpProviderConfiguration();
  return [
    ...MCP_IMAGE_PROFILES.map((profile): ProviderCapabilities => ({
      id: profile.id,
      name: profile.name,
      configured: mcp.generationConfigured,
      model: mcp.discoveryConfigured ? `${profile.textToImageTool} / ${profile.imageToImageTool}` : "待配置",
      supportsTextToImage: true,
      supportsImageToImage: true,
      supportsMultipleImages: false,
      supportsTransparentBackground: false,
      supportsCancellation: false,
      aspectRatios: [...aspectRatios],
      qualityLevels: [...qualityLevels],
    })),
    {
      id: "gemini",
      name: "Google Gemini / Nano Banana 2",
      configured: Boolean(process.env.GEMINI_API_KEY),
      model: process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image",
      supportsTextToImage: true,
      supportsImageToImage: true,
      supportsMultipleImages: true,
      supportsTransparentBackground: false,
      supportsCancellation: false,
      aspectRatios: [...aspectRatios],
      qualityLevels: [...qualityLevels],
    },
    {
      id: "openai",
      name: "OpenAI GPT Image 2",
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
      supportsTextToImage: true,
      supportsImageToImage: true,
      supportsMultipleImages: true,
      supportsTransparentBackground: false,
      supportsCancellation: false,
      aspectRatios: [...aspectRatios],
      qualityLevels: [...qualityLevels],
    },
  ];
}

const completedRequests = new Map<string, SourceImageGenerateResponse>();
const inFlightRequests = new Map<string, Promise<SourceImageGenerateResponse>>();

function singleRouteParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function executeGeneration(
  request: SourceImageGenerateRequest,
): Promise<SourceImageGenerateResponse> {
  const compiledPrompt = compileSourceImagePrompt(request);
  const providerRequest = { ...request, userPrompt: compiledPrompt };
  const jobId = randomUUID();

  const result =
    request.provider === "mcp_banana" || request.provider === "mcp_image2"
      ? await generateWithMcp(providerRequest)
      : request.provider === "gemini"
      ? await generateWithGemini(
          providerRequest,
          process.env.GEMINI_API_KEY || "",
          process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image",
        )
      : await generateWithOpenAI(
          providerRequest,
          process.env.OPENAI_API_KEY || "",
          process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
        );

  if (result.images.length === 0) {
    throw new ProviderRequestError("The provider returned no valid image.");
  }

  return {
    jobId,
    status: "succeeded",
    provider: request.provider,
    model: result.model,
    compiledPrompt,
    effectiveParameters: {
      aspectRatio: request.aspectRatio,
      quality: request.quality,
      count: result.images.length,
      providerSize: result.providerSize,
    },
    images: result.images,
    providerNote: result.providerNote,
  };
}

export interface CreateAppOptions {
  sequenceJobService?: SequenceJobService;
  sequenceCapabilities?: SequenceProviderCapabilitySummary;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const sequenceJobs = options.sequenceJobService || new SequenceJobService();
  const sequenceCapabilities =
    options.sequenceCapabilities || getSequenceProviderCapabilities();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "24mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/providers", (_request, response) => {
    response.json({
      providers: providerCapabilities(),
      sequenceProviders: [sequenceCapabilities],
    });
  });

  app.get("/api/mcp/tools", async (_request, response) => {
    const config = getMcpProviderConfiguration();
    if (!config.discoveryConfigured) {
      response.status(503).json({
        error: { code: "request_failed", message: "MCP Server URL 或令牌尚未在服务端配置。" },
      });
      return;
    }
    try {
      const tools = await listMcpTools();
      response.json({
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    } catch {
      response.status(502).json({
        error: { code: "request_failed", message: "无法连接 MCP 或读取工具列表。" },
      });
    }
  });

  app.post("/api/source-images/generate", async (request: Request, response: Response) => {
    const parsed = generateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: { code: "request_failed", message: "生成参数不完整或无效。" },
      });
      return;
    }

    const payload = parsed.data as SourceImageGenerateRequest;
    const capabilities = providerCapabilities().find((item) => item.id === payload.provider);
    if (!capabilities?.configured) {
      response.status(503).json({
        error: {
          code: "request_failed",
          message: `${capabilities?.name || payload.provider} 尚未在服务端配置。`,
        },
      });
      return;
    }

    const completed = completedRequests.get(payload.clientRequestId);
    if (completed) {
      response.json(completed);
      return;
    }

    let task = inFlightRequests.get(payload.clientRequestId);
    if (!task) {
      task = executeGeneration(payload);
      inFlightRequests.set(payload.clientRequestId, task);
    }

    try {
      const result = await task;
      completedRequests.set(payload.clientRequestId, result);
      if (completedRequests.size > 50) {
        const oldestKey = completedRequests.keys().next().value;
        if (oldestKey) completedRequests.delete(oldestKey);
      }
      response.json(result);
    } catch (error) {
      const statusUnknown = error instanceof ProviderRequestError && error.statusUnknown;
      response.status(statusUnknown ? 504 : 502).json({
        error: {
          code: statusUnknown ? "status_unknown" : "request_failed",
          message: statusUnknown
            ? "请求结果状态未知，请不要立即重复提交。"
            : "生成失败，请检查服务端配置或稍后重试。",
          requestId: payload.clientRequestId,
        },
      });
    } finally {
      inFlightRequests.delete(payload.clientRequestId);
    }
  });

  app.post("/api/sequence-jobs", (request: Request, response: Response) => {
    const parsed = parseSequenceJobSubmission(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: { code: "validation_failed", message: "序列任务参数不完整或无效。" },
      });
      return;
    }
    if (
      parsed.data.request.providerExtensions?.proxyInstanceId !==
      sequenceCapabilities.proxyInstanceId
    ) {
      response.status(409).json({
        error: {
          code: "status_unknown",
          message: "代理实例已变化，旧请求不能自动重新提交；请创建新的显式任务。",
          retryable: false,
          recoveryAction: "reconcile",
        },
      });
      return;
    }
    if (!sequenceCapabilities.configured) {
      response.status(503).json({
        error: {
          code: "capability_unsupported",
          message: sequenceCapabilities.unavailabilityReason || "序列服务当前不可用。",
        },
      });
      return;
    }
    try {
      const receipt = sequenceJobs.create(
        parsed.data.request,
        parsed.data.sourceImageDataUrl,
      );
      response.status(202).json(receipt);
    } catch (error) {
      if (error instanceof SequenceJobConflictError) {
        response.status(409).json({
          error: {
            code: "validation_failed",
            message: "同一个 clientRequestId 已用于不同的序列任务参数。",
          },
        });
        return;
      }
      if (error instanceof SequenceJobRateLimitError) {
        response.status(429).json({
          error: {
            code: "rate_limited",
            message: "当前已有序列任务在执行，请等待其结束后再创建新任务。",
            retryable: true,
            recoveryAction: "retry",
          },
        });
        return;
      }
      response.status(500).json({
        error: { code: "request_failed", message: "无法创建本地序列任务。" },
      });
    }
  });

  app.get("/api/sequence-jobs/:jobId", (request: Request, response: Response) => {
    const jobId = singleRouteParam(request.params.jobId);
    const snapshot = jobId ? sequenceJobs.getSnapshot(jobId) : undefined;
    if (!snapshot) {
      response.status(404).json({
        error: {
          code: "status_unknown",
          message: "代理中没有该任务记录；代理重启后无法向服务商对账。",
        },
      });
      return;
    }
    response.json(snapshot);
  });

  app.get("/api/sequence-jobs/:jobId/result", (request: Request, response: Response) => {
    const jobId = singleRouteParam(request.params.jobId);
    const result = jobId ? sequenceJobs.getResult(jobId) : undefined;
    if (result) {
      response.json(result);
      return;
    }
    const snapshot = jobId ? sequenceJobs.getSnapshot(jobId) : undefined;
    if (!snapshot) {
      response.status(404).json({
        error: {
          code: "status_unknown",
          message: "代理中没有该任务记录；代理重启后结果状态未知。",
        },
      });
      return;
    }
    if (snapshot.status === "completed") {
      response.status(410).json({
        error: {
          code: "resource_unavailable",
          message: "代理结果缓存已过期或因容量限制被清理。",
          retryable: false,
          recoveryAction: "none",
        },
      });
      return;
    }
    response.status(409).json({
      error: snapshot.error || {
        code: "request_failed",
        message: "任务尚未生成完整结果。",
        retryable: false,
        recoveryAction: "none",
      },
    });
  });

  return app;
}

async function start(): Promise<void> {
  const app = createApp();
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    const distDir = path.resolve(rootDir, "dist");
    app.use(express.static(distDir));
    app.use((_request, response) => response.sendFile(path.join(distDir, "index.html")));
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: rootDir,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT || 5173);
  app.listen(port, () => {
    console.log(`GIF CRAFT listening on http://localhost:${port}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  void start();
}
