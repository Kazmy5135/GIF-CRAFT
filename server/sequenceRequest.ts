import { createHash } from "node:crypto";
import { z } from "zod";
import {
  compileSequencePrompt,
  diffSequenceParameters,
  sequencePresets,
  sequencePresetIds,
  validateSequenceParameters,
  type SequenceGenerationRequest,
} from "../src/core/sequenceGeneration.js";
import { GORILLA_SEEDANCE_PROVIDER } from "./providers/sequence.js";

const MAX_SOURCE_DATA_URL_LENGTH = 21 * 1024 * 1024;

const promptLayerSchema = z.object({ id: z.string().min(1).max(120), version: z.literal(1) });
const canvasSchema = z.object({
  mode: z.literal("source"),
  aspectRatio: z.enum(["1:1", "3:2", "2:3", "16:9", "9:16"]),
  width: z.number().int().positive().max(8_192),
  height: z.number().int().positive().max(8_192),
});
const anchorSchema = z.enum(["bottom_center_feet_baseline", "full_canvas_fixed_camera"]);
const loopModeSchema = z.enum(["loop", "once"]);
const requestedParametersSchema = z.object({
  frameCount: z.number().int().positive().max(120),
  frameRate: z.number().int().positive().max(120),
  loopMode: loopModeSchema.nullable(),
  canvas: canvasSchema,
  anchor: anchorSchema,
  randomSeed: z.number().int().safe().nullable(),
});
const effectiveParametersSchema = z.object({
  frameCount: z.union([z.literal(8), z.literal(12)]),
  frameRate: z.union([z.literal(8), z.literal(12)]),
  loopMode: loopModeSchema,
  canvas: z.object({
    mode: z.literal("source"),
    aspectRatio: z.literal("1:1"),
    width: z.literal(480),
    height: z.literal(480),
  }),
  anchor: anchorSchema,
  randomSeed: z.null(),
});
const parameterFieldSchema = z.enum([
  "frameCount",
  "frameRate",
  "loopMode",
  "canvas.mode",
  "canvas.aspectRatio",
  "canvas.width",
  "canvas.height",
  "anchor",
  "randomSeed",
]);
const parameterValueSchema = z.union([z.string(), z.number(), z.null()]);

const sequenceRequestSchema = z
  .object({
    draftId: z.string().trim().min(1).max(120),
    clientRequestId: z.string().uuid(),
    provider: z.literal(GORILLA_SEEDANCE_PROVIDER),
    source: z.object({
      id: z.string().trim().min(1).max(255),
      confirmedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
      contentSnapshotId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      resourceRef: z.string().trim().min(1).max(320),
      mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      width: z.number().int().positive().max(8_192),
      height: z.number().int().positive().max(8_192),
      size: z.number().int().positive().max(15 * 1024 * 1024),
    }),
    presetId: z.enum(sequencePresetIds),
    presetVersion: z.literal(1),
    promptSnapshot: z.object({
      layerRefs: z.array(promptLayerSchema).min(3).max(4),
      userDescription: z.string().trim().min(1).max(2_000),
      compiledText: z.string().trim().min(1).max(12_000),
    }),
    requestedParameters: requestedParametersSchema,
    effectiveParameters: effectiveParametersSchema,
    parameterMappings: z
      .array(
        z.object({
          field: parameterFieldSchema,
          requested: parameterValueSchema,
          effective: parameterValueSchema,
          reason: z.string().trim().min(1).max(500),
        }),
      )
      .max(9),
    providerExtensions: z
      .object({
        model: z.enum(["fast", "standard"]).optional(),
        proxyInstanceId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .superRefine((request, context) => {
    const preset = sequencePresets[request.presetId];
    const domainIssues = validateSequenceParameters(preset, request.requestedParameters);
    for (const issue of domainIssues) {
      context.addIssue({
        code: "custom",
        path: ["requestedParameters", issue.field],
        message: issue.message,
      });
    }
    if (
      !preset.editableFields.includes("loopMode") &&
      request.requestedParameters.loopMode !== preset.defaults.loopMode
    ) {
      context.addIssue({
        code: "custom",
        path: ["requestedParameters", "loopMode"],
        message: "The selected preset has a fixed loop mode.",
      });
    }
    if (
      request.effectiveParameters.anchor !== preset.defaults.anchor ||
      request.effectiveParameters.loopMode !== request.requestedParameters.loopMode
    ) {
      context.addIssue({
        code: "custom",
        path: ["effectiveParameters"],
        message: "Effective anchor and loop mode must preserve the selected preset semantics.",
      });
    }
    try {
      const compiled = compileSequencePrompt({
        preset,
        userDescription: request.promptSnapshot.userDescription,
        effectiveParameters: request.effectiveParameters,
      });
      if (
        compiled.compiledText !== request.promptSnapshot.compiledText ||
        JSON.stringify(compiled.layerRefs) !== JSON.stringify(request.promptSnapshot.layerRefs)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptSnapshot"],
          message: "Prompt snapshot does not match the approved preset and hard constraints.",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["promptSnapshot"],
        message: "Prompt snapshot cannot be compiled from the approved preset.",
      });
    }
    if (request.source.resourceRef !== `source-image:${request.source.id}`) {
      context.addIssue({
        code: "custom",
        path: ["source", "resourceRef"],
        message: "Source resourceRef must be the stable source-image reference.",
      });
    }
    const expectedMappingList = diffSequenceParameters(
      request.requestedParameters,
      request.effectiveParameters,
    );
    const expectedMappings = new Map(
      expectedMappingList.map((mapping) => [mapping.field, mapping]),
    );
    const actualMappings = new Set(request.parameterMappings.map((mapping) => mapping.field));
    if (actualMappings.size !== request.parameterMappings.length) {
      context.addIssue({
        code: "custom",
        path: ["parameterMappings"],
        message: "Parameter mappings must not contain duplicate fields.",
      });
    }
    for (const field of expectedMappings.keys()) {
      if (!actualMappings.has(field)) {
        context.addIssue({
          code: "custom",
          path: ["parameterMappings"],
          message: `Effective parameter mapping for ${field} must be disclosed.`,
        });
      }
    }
    for (const mapping of request.parameterMappings) {
      const expected = expectedMappings.get(mapping.field);
      if (!expected) {
        context.addIssue({
          code: "custom",
          path: ["parameterMappings"],
          message: `Parameter mapping for unchanged field ${mapping.field} is invalid.`,
        });
      } else if (
        mapping.requested !== expected.requested ||
        mapping.effective !== expected.effective
      ) {
        context.addIssue({
          code: "custom",
          path: ["parameterMappings"],
          message: `Parameter mapping values for ${mapping.field} do not match the request.`,
        });
      }
    }
  });

export const sequenceJobSubmissionSchema = z
  .object({
    request: sequenceRequestSchema,
    sourceImageDataUrl: z.string().min(1).max(MAX_SOURCE_DATA_URL_LENGTH),
  })
  .superRefine((submission, context) => {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(
      submission.sourceImageDataUrl,
    );
    if (!match || match[1] !== submission.request.source.mimeType) {
      context.addIssue({
        code: "custom",
        path: ["sourceImageDataUrl"],
        message: "Transient source bytes must match the confirmed source MIME type.",
      });
      return;
    }
    const decodedSize = Buffer.from(match[2], "base64").length;
    if (decodedSize !== submission.request.source.size) {
      context.addIssue({
        code: "custom",
        path: ["sourceImageDataUrl"],
        message: "Transient source bytes do not match the confirmed source snapshot size.",
      });
    }
    const snapshotId = `sha256:${createHash("sha256").update(Buffer.from(match[2], "base64")).digest("hex")}`;
    if (snapshotId !== submission.request.source.contentSnapshotId) {
      context.addIssue({
        code: "custom",
        path: ["sourceImageDataUrl"],
        message: "Transient source bytes do not match the confirmed content snapshot.",
      });
    }
  });

export interface SequenceJobSubmission {
  request: SequenceGenerationRequest;
  sourceImageDataUrl: string;
}

export function parseSequenceJobSubmission(value: unknown):
  | { success: true; data: SequenceJobSubmission }
  | { success: false } {
  const parsed = sequenceJobSubmissionSchema.safeParse(value);
  return parsed.success
    ? { success: true, data: parsed.data as SequenceJobSubmission }
    : { success: false };
}
