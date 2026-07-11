import { afterEach, describe, expect, it, vi } from "vitest";
import type { SequenceGenerationRequest } from "../../core/sequenceGeneration";
import {
  fetchSequenceJob,
  fetchSequenceProviders,
  fetchSequenceResult,
  submitSequenceJob,
} from "./sequenceApi";

afterEach(() => {
  vi.restoreAllMocks();
});

const request = {
  clientRequestId: "1e4afad2-0ea2-4cf7-97de-8e3b6bf0884d",
  providerExtensions: { proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
} as SequenceGenerationRequest;

describe("sequence API client", () => {
  it("submits source bytes outside the immutable request snapshot", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jobId: "job-1",
          externalJobRef: "local:job-1",
          provider: "gorilla_seedance",
          proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "submitting",
          submittedAt: "2026-07-11T12:00:00.000Z",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(submitSequenceJob(request, "data:image/png;base64,AA==")).resolves.toMatchObject({
      jobId: "job-1",
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      request,
      sourceImageDataUrl: "data:image/png;base64,AA==",
    });
  });

  it("queries status and result resource routes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "job/1",
            externalJobRef: "local:job/1",
            provider: "gorilla_seedance",
            proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "generating",
            progress: null,
            updatedAt: "2026-07-11T12:00:00.000Z",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "job/1",
            frames: [],
            integrity: {
              status: "complete",
              expectedFrameCount: 0,
              actualFrameCount: 0,
              issues: [],
            },
          }),
          { status: 200 },
        ),
      );
    await fetchSequenceJob("job/1");
    await fetchSequenceResult("job/1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sequence-jobs/job%2F1");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sequence-jobs/job%2F1/result");
  });

  it("returns a valid 200 failed snapshot even when it contains an error field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        jobId: "job-1",
        externalJobRef: "local:job-1",
        provider: "gorilla_seedance",
        proxyInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "failed",
        progress: null,
        updatedAt: "2026-07-12T00:00:00.000Z",
        error: {
          code: "partial_result",
          message: "只生成了部分帧。",
          retryable: true,
          recoveryAction: "retry",
        },
      }), { status: 200 }),
    );
    await expect(fetchSequenceJob("job-1")).resolves.toMatchObject({
      status: "failed",
      error: { code: "partial_result", retryable: true, recoveryAction: "retry" },
    });
  });

  it("reads sequence provider summaries without affecting image providers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          providers: [{ id: "mcp_banana" }],
          sequenceProviders: [{ provider: "gorilla_seedance", configured: true }],
        }),
        { status: 200 },
      ),
    );
    await expect(fetchSequenceProviders()).resolves.toEqual([
      { provider: "gorilla_seedance", configured: true },
    ]);
  });

  it("preserves unknown status as a reconcile error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "status_unknown",
            message: "代理重启后无法向服务商对账。",
          },
        }),
        { status: 404 },
      ),
    );
    await expect(fetchSequenceJob("missing")).rejects.toMatchObject({
      code: "status_unknown",
      httpStatus: 404,
    });
  });

  it("treats a truncated 202 response as ambiguous without a definitive HTTP status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{", { status: 202, headers: { "content-type": "application/json" } }),
    );
    await expect(submitSequenceJob(request, "data:image/png;base64,AA==")).rejects.toMatchObject({
      code: "status_unknown",
      httpStatus: undefined,
      retryable: false,
      recoveryAction: "reconcile",
    });
  });

  it("maps definitive validation errors to a non-retryable repair action", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "validation_failed", message: "invalid" } }), { status: 400 }),
    );
    await expect(submitSequenceJob(request, "data:image/png;base64,AA==")).rejects.toMatchObject({
      code: "validation_failed",
      httpStatus: 400,
      retryable: false,
      recoveryAction: "fix_input",
    });
  });

  it("rejects a receipt from a different proxy instance as status_unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        jobId: "job-1",
        externalJobRef: "local:job-1",
        provider: "gorilla_seedance",
        proxyInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "submitting",
        submittedAt: "2026-07-11T12:00:00.000Z",
      }), { status: 202 }),
    );
    await expect(submitSequenceJob(request, "data:image/png;base64,AA==")).rejects.toMatchObject({
      code: "status_unknown",
      httpStatus: undefined,
      retryable: false,
      recoveryAction: "reconcile",
    });
  });
});
