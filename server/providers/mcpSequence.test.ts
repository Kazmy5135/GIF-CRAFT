import { afterEach, describe, expect, it } from "vitest";
import {
  MCP_SEQUENCE_TOOL,
  buildMcpSequenceArguments,
  classifyMcpSequenceCallError,
  parseMcpVideoResult,
  type McpTool,
} from "./mcp";

const previousServerUrl = process.env.MCP_SERVER_URL;

afterEach(() => {
  if (previousServerUrl === undefined) delete process.env.MCP_SERVER_URL;
  else process.env.MCP_SERVER_URL = previousServerUrl;
  delete process.env.MCP_ASSET_HOSTS;
});

const tool: McpTool = {
  name: MCP_SEQUENCE_TOOL,
  inputSchema: {
    type: "object",
    properties: {
      首帧: {},
      尾帧: {},
      文本输入: {},
      model: {},
      ratio: {},
      resolution: {},
      duration: {},
    },
    required: ["首帧", "尾帧", "文本输入"],
  },
};

describe("Gorilla Seedance sequence mapping", () => {
  it("maps the approved fast 1:1 480p four-second profile", () => {
    expect(
      buildMcpSequenceArguments(
        tool,
        { prompt: "idle loop", model: "fast", loop: true },
        "/assets/source.png",
      ),
    ).toEqual({
      首帧: "/assets/source.png",
      尾帧: "/assets/source.png",
      文本输入: "idle loop",
      model: "bytedance/doubao-seedance-2-0-fast",
      ratio: "1:1",
      resolution: "480p",
      duration: "4",
    });
  });

  it("uses an empty tail input for a non-looping action", () => {
    const result = buildMcpSequenceArguments(
      tool,
      { prompt: "attack", model: "standard", loop: false },
      "/assets/source.png",
    );
    expect(result.尾帧).toBe("");
    expect(result.model).toBe("bytedance/doubao-seedance-2-0");
  });

  it("accepts only an allowlisted MCP video URL", () => {
    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    const parsed = parseMcpVideoResult({
        content: [{ type: "text", text: '{"outputUrl":"/assets/result.mp4"}' }],
      });
    expect(parsed.remoteUrl).toBe("https://canvas.example.test/assets/result.mp4");
    expect(parsed.note).not.toContain("/assets/result.mp4");
    expect(() =>
      parseMcpVideoResult({
        structuredContent: { outputUrl: "https://evil.example/result.mp4" },
      }),
    ).toThrow(/no allowed video URL/i);
  });

  it("prefers explicit video output and never mistakes echoed input assetUrl for output", () => {
    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    expect(
      parseMcpVideoResult({
        structuredContent: {
          assetUrl: "/assets/uploaded-source.png",
          result: { videoUrl: "/assets/generated.mp4" },
        },
      }).remoteUrl,
    ).toBe("https://canvas.example.test/assets/generated.mp4");
    expect(() =>
      parseMcpVideoResult({
        structuredContent: { assetUrl: "/assets/uploaded-source.png" },
      }),
    ).toThrow(/no allowed video URL/i);
  });

  it("rejects allowlisted hosts when URL userinfo or a non-default port is present", () => {
    process.env.MCP_SERVER_URL = "https://canvas.example.test/api/mcp/sse";
    expect(() =>
      parseMcpVideoResult({
        structuredContent: { videoUrl: "https://user@canvas.example.test/assets/result.mp4" },
      }),
    ).toThrow(/no allowed video URL/i);
    expect(() =>
      parseMcpVideoResult({
        structuredContent: { videoUrl: "https://canvas.example.test:444/assets/result.mp4" },
      }),
    ).toThrow(/no allowed video URL/i);
  });

  it("classifies authentication, rate limit, and timeout failures", () => {
    expect(classifyMcpSequenceCallError(new Error("HTTP 401 unauthorized"))).toMatchObject({
      kind: "authentication",
      retryable: false,
      statusUnknown: false,
    });
    expect(classifyMcpSequenceCallError(new Error("429 too many requests"))).toMatchObject({
      kind: "rate_limit",
      retryable: true,
      statusUnknown: false,
    });
    expect(classifyMcpSequenceCallError(new Error("request timeout"))).toMatchObject({
      kind: "status_unknown",
      retryable: false,
      statusUnknown: true,
    });
  });

  it("classifies structured MCP tool errors before result parsing", () => {
    let rateError: unknown;
    try {
      parseMcpVideoResult({
        isError: true,
        content: [{ type: "text", text: "429 too many requests" }],
      });
    } catch (error) {
      rateError = error;
    }
    expect(rateError).toMatchObject({ kind: "rate_limit", retryable: true });
    let authError: unknown;
    try {
      parseMcpVideoResult({
        isError: true,
        content: [{ type: "text", text: "HTTP 401 unauthorized" }],
      });
    } catch (error) {
      authError = error;
    }
    expect(authError).toMatchObject({ kind: "authentication", retryable: false });
    let timeoutError: unknown;
    try {
      parseMcpVideoResult({
        isError: true,
        content: [{ type: "text", text: "upstream request timed out" }],
      });
    } catch (error) {
      timeoutError = error;
    }
    expect(timeoutError).toMatchObject({
      kind: "status_unknown",
      retryable: false,
      statusUnknown: true,
    });
  });
});
