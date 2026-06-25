// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/fleet/fleet-schemas`
 * Purpose: Zod schema + inferred view-model type for the dashboard Fleet/Infra SERVERS sub-card
 *   (story.5013 v0) — the boundary contract for `GET /api/v1/compute/balances` (incl. fields that are
 *   null today, e.g. estimatedDaysRemaining, so the adapter can enrich later with zero UI change).
 *   The NODES table is server-rendered from `NodeRegistryPort.listPublic()`, so it carries NO HTTP
 *   boundary here — it reuses the typed `NodeSummary` port shape directly.
 * Scope: Pure schema/parse definitions. Does not fetch, render, or branch on a provider.
 * Invariants: NO_ANY (the route payload is parsed at the boundary), TOLERATE_NULL (null-today fields
 *   are `.nullable()`, never required).
 * Side-effects: none
 * Links: packages/ai-tools/src/capabilities/compute.ts (ComputeBalance),
 *   src/ports/node-registry.port.ts (NodeSummary, the NODES table source)
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
