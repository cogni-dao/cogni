// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/fleet/fleet-schemas`
 * Purpose: Zod schemas + inferred view-model types for the dashboard Fleet/Infra view (story.5013 v0)
 *   — the boundary contract for the two READ routes the card consumes.
 * Scope: Pure schema/parse definitions. Validates the FULL response shape of
 *   `GET /api/v1/compute/balances` and `GET /api/v1/nodes/<id>/deploy-state` (incl. fields that are
 *   null today, e.g. estimatedDaysRemaining / sourceSha / digest, so the adapter can enrich later with
 *   zero UI change). Does not fetch, render, or branch on a provider.
 * Invariants: NO_ANY (all route payloads parsed at the boundary), TOLERATE_NULL (null-today fields
 *   are `.nullable()`, never required), PERSONAL_SCOPE (the node list is the viewer's own — no
 *   all-nodes/fleet read is modeled here).
 * Side-effects: none
 * Links: packages/ai-tools/src/capabilities/compute.ts (ComputeBalance),
 *   nodes/operator/app/src/app/api/v1/nodes/[id]/deploy-state/route.ts (DeployStateResponse)
 * @public
 */

import { z } from "zod";

/** One compute-provider account balance — mirrors ComputeBalance verbatim. */
export const computeBalanceSchema = z.object({
  provider: z.string(),
  accountId: z.string(),
  currency: z.string(),
  remaining: z.number(),
  asOf: z.string(),
  // null today (the provider does not expose a burn rate yet) — render "runway unknown", never crash.
  estimatedDaysRemaining: z.number().nullable(),
});

export const computeBalancesResponseSchema = z.object({
  balances: z.array(computeBalanceSchema),
});

export type ComputeBalanceVM = z.infer<typeof computeBalanceSchema>;

/** Per-env deploy state for ONE node — the FULL deploy-state cell (null-today fields tolerated). */
export const nodeDeployEnvSchema = z.object({
  env: z.string(),
  node: z.string(),
  // null today; the Argo adapter enriches these later with zero UI change.
  sourceSha: z.string().nullable(),
  digest: z.string().nullable(),
  buildSha: z.string().nullable(),
  health: z.enum(["healthy", "degraded", "provisioning", "unknown"]),
  replicas: z.object({ desired: z.number(), ready: z.number() }),
});

export const deployStateResponseSchema = z.object({
  nodeId: z.string(),
  slug: z.string(),
  envs: z.array(nodeDeployEnvSchema),
  liveEnvs: z.array(z.string()),
});

export type DeployEnvVM = z.infer<typeof nodeDeployEnvSchema>;
export type DeployStateVM = z.infer<typeof deployStateResponseSchema>;

/** One row of `GET /api/v1/nodes` — only the fields the fleet view needs (id + slug). */
export const nodeRefSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
  })
  .passthrough();

export const nodesListResponseSchema = z.object({
  nodes: z.array(nodeRefSchema),
});

export type NodeRefVM = { id: string; slug: string };

/** A node block in the grid: its identity + the resolved deploy-state (or an error marker). */
export interface NodeFleetVM {
  readonly id: string;
  readonly slug: string;
  readonly deployState: DeployStateVM | null;
  /** Set when deploy-state could not be resolved (404, 503, 403, network) — render gracefully. */
  readonly error: string | null;
}
