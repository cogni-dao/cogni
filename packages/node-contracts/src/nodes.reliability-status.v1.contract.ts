// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/nodes.reliability-status.v1`
 * Purpose: Versioned wire contract for one node/environment reliability verdict.
 * Scope: Zod wire shapes only; policy evaluation and metric queries live in the operator.
 * Invariants: FAIL_CLOSED, LOW_CARDINALITY, ONE_HEALTH_CONTRACT.
 * Side-effects: none
 * Links: /api/v1/nodes/{id}/observability/health, task.5247
 * @public
 */

import { z } from "zod";

export const reliabilityEnvironmentSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);

export const reliabilityStateSchema = z.enum([
  "healthy",
  "warning",
  "contained",
  "recovering",
  "unknown",
]);

export const databaseTierSchema = z.enum(["shared", "dedicated", "unknown"]);

export const reliabilityStatusV1Schema = z.object({
  version: z.literal("reliability-status.v1"),
  nodeId: z.string().uuid(),
  slug: z.string().min(1).max(63),
  environment: reliabilityEnvironmentSchema,
  buildSha: z.string().min(7).nullable(),
  databaseTier: databaseTierSchema,
  budgetProfile: z.string().min(1).max(63).nullable(),
  state: reliabilityStateSchema,
  regionalReadiness: z.array(
    z.object({
      region: z.string().min(1).max(63),
      healthy: z.boolean(),
      observedAt: z.string().datetime(),
    })
  ),
  utilization: z.object({
    ioPressurePct: z.number().min(0).nullable(),
    connectionPct: z.number().min(0).nullable(),
    memoryHeadroomPct: z.number().min(0).max(100).nullable(),
    diskHeadroomPct: z.number().min(0).max(100).nullable(),
  }),
  incidentReason: z.string().min(1).max(128).nullable(),
  lastTransitionAt: z.string().datetime().nullable(),
  evidenceQueryRefs: z.array(z.string().min(1).max(128)).max(16),
});

export const reliabilityStatusV1Operation = {
  id: "nodes.reliability-status.v1",
  summary: "Read a node's fail-closed reliability state",
  input: z.object({
    nodeId: z.string().uuid(),
    environment: reliabilityEnvironmentSchema,
  }),
  output: reliabilityStatusV1Schema,
} as const;

export type ReliabilityEnvironment = z.infer<
  typeof reliabilityEnvironmentSchema
>;
export type ReliabilityState = z.infer<typeof reliabilityStateSchema>;
export type DatabaseTier = z.infer<typeof databaseTierSchema>;
export type ReliabilityStatusV1 = z.infer<typeof reliabilityStatusV1Schema>;
