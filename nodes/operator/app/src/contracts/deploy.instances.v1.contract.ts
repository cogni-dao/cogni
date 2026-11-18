// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/deploy.instances.v1`
 * Purpose: Wire contract for `GET /api/v1/deploy/instances?nodeId=&env=` — the instance directory: which
 *   copies of a node run in an env right now and the host each serves from (story.5159 step 1, design hub
 *   `candidate-pr-lanes`). The scheduler-worker resolves a run's `instance` name here instead of trusting
 *   a URL from run input.
 * Scope: Request/response schemas only. Rows are derived from the node-deploy sequencer's durable state;
 *   see `features/node-deploy/instance-directory.ts`.
 * Invariants:
 *   - IDENTITY_NOT_URL: a caller names an instance; only this read supplies its host.
 *   - RUNNING_AND_PROVEN_ONLY: an instance is listed only when its desired row is `running` and an attempt
 *     of it is `active`. Absence means unknown or closed; a caller never falls back to another instance.
 *   - HOST_IS_A_BARE_HOSTNAME: `host` has no scheme, port or path; the caller adds `https://`.
 *   - STRICT_INPUT: unknown query keys are a 400.
 * Side-effects: none (schemas only)
 * Links: features/node-deploy/instance-directory.ts, app/api/v1/deploy/instances/route.ts
 * @public
 */

import { z } from "zod";

import { DeployWorkloadEnvSchema } from "./deploy.workloads.v1.contract";

/** `GET /api/v1/deploy/instances?nodeId=&env=` */
export const DeployInstancesQuerySchema = z.strictObject({
  nodeId: z.string().min(1).describe("Node UUID or unique slug"),
  env: DeployWorkloadEnvSchema,
});

/** An instance name: `main`, a workload name (`canary`) or, later, `pr-<n>`. A DNS label. */
export const DeployInstanceNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "instance must be a DNS-safe label");

export const DeployInstanceSchema = z.object({
  instance: DeployInstanceNameSchema,
  /** The workload that backs this instance (`app` is `main`). */
  workload: z.string(),
  /** Bare public hostname the instance serves from. */
  host: z.string().min(1),
  /** The release whose attempt is proven `active`. */
  releaseId: z.string(),
  sourceSha: z.string(),
});

export const DeployInstancesReadSchema = z.object({
  nodeId: z.string().uuid(),
  env: DeployWorkloadEnvSchema,
  asOf: z.string(),
  instances: z.array(DeployInstanceSchema),
});

export type DeployInstancesQuery = z.infer<typeof DeployInstancesQuerySchema>;
export type DeployInstance = z.infer<typeof DeployInstanceSchema>;
export type DeployInstancesRead = z.infer<typeof DeployInstancesReadSchema>;
