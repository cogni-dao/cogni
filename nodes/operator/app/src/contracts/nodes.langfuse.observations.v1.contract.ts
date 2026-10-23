// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/nodes.langfuse.observations.v1`
 * Purpose: Bounded native Langfuse v2 observation query/result contract.
 * Scope: Zod IO only; upstream additive fields are withheld until reviewed.
 * Invariants: No caller ownership predicate or arbitrary upstream operation.
 * Side-effects: none
 * Links: https://cloud.langfuse.com/generated/api/openapi.yml, task.5319
 * @public
 */
import { z } from "zod";

export const LangfuseEnvironmentSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);
export const LangfuseFilterSchema = z
  .object({
    type: z.literal("string"),
    column: z.enum([
      "id",
      "traceId",
      "sessionId",
      "name",
      "type",
      "level",
      "model",
      "version",
      "parentObservationId",
    ]),
    operator: z.literal("="),
    value: z.string().min(1).max(256),
  })
  .strict();
export const LangfuseObservationQuerySchema = z
  .object({
    environment: LangfuseEnvironmentSchema.default("production"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(16384).optional(),
    fromStartTime: z.string().datetime({ offset: true }).optional(),
    toStartTime: z.string().datetime({ offset: true }).optional(),
    fields: z
      .string()
      .max(256)
      .default("core,basic,io,model,usage,metadata,trace_context"),
    traceId: z.string().min(1).max(256).optional(),
    sessionId: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(256).optional(),
    type: z.string().min(1).max(64).optional(),
    level: z.enum(["DEBUG", "DEFAULT", "WARNING", "ERROR"]).optional(),
    filter: z.string().max(4096).optional(),
  })
  .strict();

// Native ObservationV2 fields, pinned to the reviewed 2026-10-23 OpenAPI.
const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();
export const LangfuseObservationSchema = z.object({
  id: z.string(),
  traceId: z.string().nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  projectId: z.string(),
  parentObservationId: z.string().nullable(),
  type: z.string(),
  name: nullableString,
  level: nullableString,
  statusMessage: nullableString,
  version: nullableString,
  environment: nullableString,
  isRootObservation: z.boolean().nullable().optional(),
  sessionId: nullableString,
  completionStartTime: nullableString,
  createdAt: nullableString,
  updatedAt: nullableString,
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  model: nullableString,
  internalModelId: nullableString,
  modelParameters: z.unknown().optional(),
  usageDetails: z.record(z.string(), z.number()).nullable().optional(),
  costDetails: z.record(z.string(), z.number()).nullable().optional(),
  totalCost: nullableNumber,
  usagePricingTierName: nullableString,
  promptId: nullableString,
  promptName: nullableString,
  promptVersion: z.number().nullable().optional(),
  latency: nullableNumber,
  timeToFirstToken: nullableNumber,
  modelId: nullableString,
  inputPrice: nullableString,
  outputPrice: nullableString,
  totalPrice: nullableString,
  traceName: nullableString,
  tags: z.array(z.string()).nullable().optional(),
  release: nullableString,
});
export const LangfuseObservationPageSchema = z.object({
  data: z.array(LangfuseObservationSchema),
  meta: z.object({
    cursor: z.string().nullable(),
    cogni: z.object({
      contractVersion: z.literal("langfuse-observations-v2.1"),
      nodeId: z.string(),
      logicalEnvironment: LangfuseEnvironmentSchema,
      fromStartTime: z.string(),
      toStartTime: z.string(),
      partial: z.boolean(),
      attributionUnavailable: z.number().int().nonnegative(),
      privacyProjected: z.literal(true),
      truncated: z.boolean(),
    }),
  }),
});
export type LangfuseObservation = z.infer<typeof LangfuseObservationSchema>;
