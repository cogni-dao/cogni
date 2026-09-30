// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/node-required-placement`
 * Purpose: Resolve one (node, environment)'s HARD placement requirement — the country codes
 *   its workload may be placed in.
 * Scope: Pure catalog policy parsing. No workflow, git, provider, or cluster I/O.
 * Invariants:
 *   - ABSENT_IS_UNCONSTRAINED: an omitted row or environment resolves to `[]`, which every
 *     consumer reads as "no requirement". This field is inert for every row that has never
 *     needed one, exactly like LEGACY_IS_DEFAULT and ZERO_IS_DEFAULT next door.
 *   - EMPTY_IS_A_TYPO_NOT_A_WILDCARD: `[]` in the catalog is REJECTED, never read as
 *     "anywhere". Consumers fail closed, so an empty requirement would refuse every bid and
 *     present as "no provider bid for this workload" — the single most confusing outcome this
 *     feature can produce. Omitting the cell is how you say unconstrained.
 *   - REQUIREMENT_IS_NOT_CALLER_INPUT: REST callers never select a placement requirement; only
 *     the catalog row does (CATALOG_IS_SSOT). A caller-supplied country set would let a flight
 *     move a node's jurisdiction without review.
 *   - NOT_A_GUARANTEE: the value narrows a candidate POOL using providers' advertised/ingress
 *     country. That is measurably not the egress identity a workload presents to a third party
 *     (two Akash providers in different advertised countries have shared one egress NAT), so
 *     only the workload's own outbound probe proves reachability. Callers must not describe
 *     this as proof.
 * Side-effects: none
 * Links: story.5050, infra/catalog/_schema.json (`required_placement_countries`),
 *   ../../adapters/server/compute/akash-provider-screen (the consumer that FILTERS on it),
 *   knowledge `akash-egress-jurisdiction-gate`
 * @internal
 */

import { z } from "zod";

import type { DeploymentEnvironment } from "./node-deployment-provider";

/** ISO 3166-1 alpha-2, matching the catalog cell's own pattern. */
const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

/**
 * Bounds mirror the catalog schema's cell. `min(1)` is load-bearing: see
 * EMPTY_IS_A_TYPO_NOT_A_WILDCARD.
 */
const placementCellSchema = z
  .array(countryCodeSchema)
  .min(1)
  .max(32)
  .refine((codes) => new Set(codes).size === codes.length, {
    message: "country codes must be unique",
  });

const catalogRequiredPlacementSchema = z
  .object({
    required_placement_countries: z
      .object({
        "candidate-a": placementCellSchema.optional(),
        preview: placementCellSchema.optional(),
        production: placementCellSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

/**
 * Resolve one environment's required placement countries, or `[]` when unconstrained.
 *
 * This is the node-owned half of placement policy. The operator keeps a fleet-wide provider
 * allowlist and a fleet-wide latency PREFERENCE; neither can express "this node's outbound
 * dependency refuses some jurisdictions". The two compose: a bid must satisfy the fleet
 * boundary AND this requirement.
 *
 * Read it at the same moment as the rest of the row (promote/flight materialize time), because
 * the requirement binds only on a fresh lease CREATE — Akash refuses in-place placement change,
 * so editing this cell does nothing until `lease_generation` is bumped.
 */
export function resolveNodeRequiredPlacement(input: {
  readonly catalog: unknown;
  readonly environment: DeploymentEnvironment;
}): readonly string[] {
  const parsed = catalogRequiredPlacementSchema.safeParse(input.catalog);
  if (!parsed.success) {
    throw new Error(
      `[required-placement] Invalid catalog required_placement_countries: ${parsed.error.message}`
    );
  }
  return parsed.data.required_placement_countries?.[input.environment] ?? [];
}
