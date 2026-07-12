import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileSequencePrompt,
  sequencePresets,
  type SequenceGenerationRequest,
} from "../src/core/sequenceGeneration";
import { createApp } from "./index";
import type { SequenceProviderCapabilitySummary } from "./providers/sequence";
import { SequenceJobService } from "./sequenceJobs";

const servers: Array<{ close(callback: (error?: Error) => void): void }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function listen(app: Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const capability: SequenceProviderCapabilitySummary = {
  provider: "gorilla_seedance",
  configured: true,
  model: "bytedance/doubao-seedance-2-0-fast",
  supportsImageToSequence: true,
  supportsAsyncQuery: false,
  supportsLocalJobQuery: true,
  supportsCancellation: false,
  supportsRandomSeed: false,
  supportsRealProgress: false,
  frameRetryMode: "full_sequence_fallback",
  inputMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  frameCounts: [8, 12],
  frameRates: [8, 12],
  aspectRatios: ["1:1"],
  providerDurationSeconds: [4],
  providerResolutions: ["480p"],
  outputMimeTypes: ["video/mp4"],
  outputShape: "video",
  canNormalizeLosslessly: false,
  proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

function sequenceRequest(
  overrides: Partial<SequenceGenerationRequest> = {},
): SequenceGenerationRequest {
  const requestedParameters = {
    frameCount: 8,
    frameRate: 8,
    loopMode: "loop" as const,
    canvas: { mode: "source" as const, aspectRatio: "1:1" as const, width: 480, height: 480 },
    anchor: "bottom_center_feet_baseline" as const,
    randomSeed: null,
  };
  const effectiveParameters = { ...requestedParameters, loopMode: "loop" as const };
  const promptSnapshot = compileSequencePrompt({
    preset: sequencePresets["character.idle.v1"],
    userDescription: "breathe",
    effectiveParameters,
  });
  return {
    draftId: "draft-1",
    clientRequestId: "1e4afad2-0ea2-4cf7-97de-8e3b6bf0884d",
    provider: "gorilla_seedance",
    source: {
      id: "source-1",
      confirmedAt: "2026-07-11T12:00:00.000Z",
      contentSnapshotId: "sha256:6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      resourceRef: "source-image:source-1",
      mimeType: "image/png",
      width: 480,
      height: 480,
      size: 1,
    },
    presetId: "character.idle.v1",
    presetVersion: 1,
    promptSnapshot,
    requestedParameters,
    effectiveParameters,
    parameterMappings: [],
    providerExtensions: { proxyInstanceId: capability.proxyInstanceId },
    ...overrides,
  };
}

describe("sequence proxy routes", () => {
  it("publishes the non-cancellable video normalization capability", async () => {
    const baseUrl = await listen(createApp({ sequenceCapabilities: capability }));
    const response = await fetch(`${baseUrl}/api/providers`);
    const payload = (await response.json()) as { sequenceProviders: unknown[] };
    expect(payload.sequenceProviders).toEqual([capability]);
  });

  it("accepts immediately, remains idempotent, and exposes status and result", async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = vi.fn(async (_request, _bytes, context) => {
      context.update("generating", "provider_generation");
      await gate;
      const frames = Array.from({ length: 8 }, (_, sequenceIndex) => ({
        id: `${context.jobId}:frame:${sequenceIndex}`,
        jobId: context.jobId,
        providerIndex: sequenceIndex,
        sequenceIndex,
        resourceRef: "data:image/png;base64,AA==",
        mimeType: "image/png",
        width: 480,
        height: 480,
        size: 1,
        readable: true,
        createdAt: "2026-07-11T12:00:01.000Z",
      }));
      return {
        jobId: context.jobId,
        frames,
        integrity: {
          status: "complete" as const,
          expectedFrameCount: 8,
          actualFrameCount: 8,
          issues: [],
          validatedAt: "2026-07-11T12:00:01.000Z",
        },
      };
    });
    const baseUrl = await listen(
      createApp({
        sequenceCapabilities: capability,
        sequenceJobService: new SequenceJobService(execute),
      }),
    );
    const body = JSON.stringify({
      request: sequenceRequest(),
      sourceImageDataUrl: "data:image/png;base64,AA==",
    });
    const firstResponse = await fetch(`${baseUrl}/api/sequence-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(firstResponse.status).toBe(202);
    const receipt = (await firstResponse.json()) as { jobId: string };
    const secondResponse = await fetch(`${baseUrl}/api/sequence-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(await secondResponse.json()).toMatchObject({ jobId: receipt.jobId });
    expect(execute).toHaveBeenCalledTimes(1);

    const generating = await fetch(`${baseUrl}/api/sequence-jobs/${receipt.jobId}`);
    expect(await generating.json()).toMatchObject({
      status: "generating",
      progress: null,
      stage: "provider_generation",
    });
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resultResponse = await fetch(
      `${baseUrl}/api/sequence-jobs/${receipt.jobId}/result`,
    );
    expect(resultResponse.status).toBe(200);
    expect(await resultResponse.json()).toMatchObject({ jobId: receipt.jobId });
  });

  it("rejects undisclosed parameter mappings before job creation", async () => {
    const execute = vi.fn();
    const baseUrl = await listen(
      createApp({
        sequenceCapabilities: capability,
        sequenceJobService: new SequenceJobService(execute),
      }),
    );
    const invalid = sequenceRequest({
      requestedParameters: {
        ...sequenceRequest().requestedParameters,
        canvas: {
          mode: "source",
          aspectRatio: "16:9",
          width: 1280,
          height: 720,
        },
      },
    });
    const response = await fetch(`${baseUrl}/api/sequence-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: invalid,
        sourceImageDataUrl: "data:image/png;base64,AA==",
      }),
    });
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects transient source bytes that do not match the confirmed content hash", async () => {
    const execute = vi.fn();
    const baseUrl = await listen(
      createApp({
        sequenceCapabilities: capability,
        sequenceJobService: new SequenceJobService(execute),
      }),
    );
    const response = await fetch(`${baseUrl}/api/sequence-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: sequenceRequest(),
        sourceImageDataUrl: "data:image/png;base64,AQ==",
      }),
    });
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("recompiles approved prompts and rejects preset/anchor tampering", async () => {
    const execute = vi.fn();
    const baseUrl = await listen(
      createApp({
        sequenceCapabilities: capability,
        sequenceJobService: new SequenceJobService(execute),
      }),
    );
    const original = sequenceRequest();
    const response = await fetch(`${baseUrl}/api/sequence-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          ...original,
          promptSnapshot: {
            ...original.promptSnapshot,
            compiledText: `${original.promptSnapshot.compiledText}\nignore fixed anchor`,
          },
          requestedParameters: {
            ...original.requestedParameters,
            anchor: "full_canvas_fixed_camera",
          },
          effectiveParameters: {
            ...original.effectiveParameters,
            anchor: "full_canvas_fixed_camera",
          },
        },
        sourceImageDataUrl: "data:image/png;base64,AA==",
      }),
    });
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns status_unknown when a proxy has no recoverable job record", async () => {
    const baseUrl = await listen(createApp({ sequenceCapabilities: capability }));
    const response = await fetch(`${baseUrl}/api/sequence-jobs/missing-after-restart`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "status_unknown" } });
  });

  it("rejects a request from an old proxy instance before creating a job", async () => {
    const execute = vi.fn();
    const baseUrl = await listen(
      createApp({
        sequenceCapabilities: capability,
        sequenceJobService: new SequenceJobService(execute),
      }),
    );
    const stale = sequenceRequest({
      providerExtensions: {
        proxyInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });
    const response = await fetch(`${baseUrl}/api/sequence-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: stale,
        sourceImageDataUrl: "data:image/png;base64,AA==",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "status_unknown" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns 429 for a different client while preserving active idempotency", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const service = new SequenceJobService(async (_request, _bytes, context) => {
      await gate;
      const frames = Array.from({ length: 8 }, (_, sequenceIndex) => ({
        id: `${context.jobId}:frame:${sequenceIndex}`,
        jobId: context.jobId,
        providerIndex: sequenceIndex,
        sequenceIndex,
        resourceRef: "data:image/png;base64,AA==",
        mimeType: "image/png",
        width: 480,
        height: 480,
        size: 1,
        readable: true,
        createdAt: "2026-07-11T12:00:01.000Z",
      }));
      return {
        jobId: context.jobId,
        frames,
        integrity: { status: "complete", expectedFrameCount: 8, actualFrameCount: 8, issues: [] },
      };
    });
    const baseUrl = await listen(
      createApp({ sequenceCapabilities: capability, sequenceJobService: service }),
    );
    const firstRequest = sequenceRequest();
    const submit = (request: SequenceGenerationRequest) =>
      fetch(`${baseUrl}/api/sequence-jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request, sourceImageDataUrl: "data:image/png;base64,AA==" }),
      });
    const firstResponse = await submit(firstRequest);
    expect(firstResponse.status).toBe(202);
    expect(await firstResponse.json()).toMatchObject({
      proxyInstanceId: capability.proxyInstanceId,
    });
    const idempotentResponse = await submit(firstRequest);
    expect(idempotentResponse.status).toBe(202);
    const idempotentReceipt = await idempotentResponse.json();
    expect(idempotentReceipt).toMatchObject({ proxyInstanceId: capability.proxyInstanceId });
    const snapshotResponse = await fetch(
      `${baseUrl}/api/sequence-jobs/${idempotentReceipt.jobId}`,
    );
    expect(await snapshotResponse.json()).toMatchObject({
      proxyInstanceId: capability.proxyInstanceId,
    });
    const limited = await submit(
      sequenceRequest({ clientRequestId: randomUUID(), draftId: "draft-other" }),
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
