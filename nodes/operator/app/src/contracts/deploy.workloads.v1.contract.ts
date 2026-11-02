// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/deploy.workloads.v1`
 * Purpose: Wire contract for `POST/GET /api/v1/deploy/workloads` — record intent to deploy one declared
 *   workload at a source sha, and read what the node-deploy sequencer has done about it (task.5400).
 * Scope: Request/response schemas only. The route only RECORDS intent; the sequencer executes it.
 * Invariants:
 *   - INTENT_ONLY: a 200 means "a release and its desired row were written", never "deployed".
 *   - FULL_SHA: `sourceSha` is a full 40-hex git sha; a branch name or short sha is a 400.
 *   - STRICT_INPUT: unknown keys are a 400.
 * Side-effects: none (schemas only)
 * Links: src/app/api/v1/deploy/workloads/route.ts, features/node-deploy/sequencer.ts
 * @public
 */

import { z } from "zod";

export const DeployWorkloadEnvSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);

export const DeployWorkloadInputSchema = z.strictObject({
  nodeId: z.string().min(1).describe("Node UUID or unique slug"),
  env: DeployWorkloadEnvSchema,
  workload: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/, "workload must be a DNS-safe name"),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-hex sha"),
});

export const DeployWorkloadQuerySchema = z.strictObject({
  nodeId: z.string().min(1),
  env: DeployWorkloadEnvSchema,
  workload: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/)
    .optional(),
});

export const DeployWorkloadRecordedSchema = z.object({
  releaseId: z.string().uuid(),
  nodeId: z.string().uuid(),
  env: DeployWorkloadEnvSchema,
  workload: z.string(),
  sourceSha: z.string(),
  desiredState: z.literal("running"),
});

export type DeployWorkloadInput = z.infer<typeof DeployWorkloadInputSchema>;
export type DeployWorkloadQuery = z.infer<typeof DeployWorkloadQuerySchema>;
export type DeployWorkloadRecorded = z.infer<
  typeof DeployWorkloadRecordedSchema
>;
