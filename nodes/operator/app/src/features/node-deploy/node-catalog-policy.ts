// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/node-catalog-policy`
 * Purpose: Read the two PUBLIC, node-owned policy cells the node-deploy sequencer applies to a node
 *   app from the node's catalog row (the one baked into the operator image): the hard placement
 *   countries and the database pool maxes (task.5405). Same cells the Crossplane lane read. Also the
 *   placement rules a release's manifest-declared country set meets (story.5141).
 * Scope: Pure parsing. The row arrives through `NodeCatalogPort`; nothing here touches the disk.
 * Invariants:
 *   - ABSENT_IS_UNCONSTRAINED: no cell means no country requirement and no pool env, never a default.
 *   - INVALID_IS_AN_ERROR_NOT_A_WILDCARD: a malformed cell throws (the sequencer waits and says why)
 *     instead of widening placement. An empty country list is rejected, not read as "anywhere".
 *   - REUSE: country parsing is `resolveNodeRequiredPlacement`; pool limits use the shared schema.
 *   - ONE_PLACEMENT_WRITER (CD4, story.5141): a release whose spec carries the manifest's set AND whose
 *     node's catalog row has `required_placement_countries.<env>` is refused (`placement_source_conflict`).
 *     The catalog cell is a bridge until every node moves its set to its manifest (CD9).
 *   - REFUSED_NEVER_NARROWED: a declared set that names a country on the fleet refused list is refused
 *     whole (`placement_country_refused`); it is never narrowed in silence.
 * Side-effects: none
 * Links: features/compute/node-required-placement.ts, infra/catalog/_schema.json, task.5405,
 *   hub `node-choose-placement-region`, story.5141
 * @internal
 */

import { z } from "zod";

import { resolveNodeRequiredPlacement } from "@/features/compute/node-required-placement";
import type { NodeWorkloadSpec } from "@/ports";
import { DatabaseCellRuntimePoolLimitsSchema } from "@/shared/secrets/database-cell-binding.data";

import type { NodeAppPoolLimits } from "./node-app-env";

/**
 * Fleet refused placement countries (operator policy, reviewed in this repo). Source: the "OFAC-sanctioned"
 * section of https://docs.polymarket.com/api-reference/geoblock (IR, SY, CU, KP; checked 2026-11-07).
 * A declared set that names one is refused at record time. Dropping these countries from bid screening
 * for nodes with no set is task.5444.
 */
export const FLEET_REFUSED_PLACEMENT_COUNTRIES: ReadonlySet<string> = new Set([
  "CU",
  "IR",
  "KP",
  "SY",
]);

const DEPLOY_ENVIRONMENTS = ["candidate-a", "preview", "production"] as const;
type DeployEnvironment = (typeof DEPLOY_ENVIRONMENTS)[number];

const poolLaneSchema = z
  .object({ runtimePoolLimits: DatabaseCellRuntimePoolLimitsSchema.optional() })
  .passthrough();
const poolCatalogSchema = z
  .object({
    database: z
      .object({
        "candidate-a": poolLaneSchema.optional(),
        preview: poolLaneSchema.optional(),
        production: poolLaneSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface NodeCatalogPolicy {
  readonly requiredCountryCodes: readonly string[];
  readonly databasePoolLimits?: NodeAppPoolLimits | undefined;
}

function isDeployEnvironment(env: string): env is DeployEnvironment {
  return (DEPLOY_ENVIRONMENTS as readonly string[]).includes(env);
}

export function nodeCatalogPolicy(
  row: unknown,
  env: string
): NodeCatalogPolicy {
  if (!isDeployEnvironment(env))
    throw new Error(`environment ${env} has no catalog policy`);
  const requiredCountryCodes = resolveNodeRequiredPlacement({
    catalog: row,
    environment: env,
  });
  const pools = poolCatalogSchema.parse(row).database?.[env]?.runtimePoolLimits;
  return { requiredCountryCodes, databasePoolLimits: pools };
}

/** True when the catalog row has a `required_placement_countries.<env>` cell (valid or not). */
export function catalogDeclaresPlacement(row: unknown, env: string): boolean {
  const cells = (row as { required_placement_countries?: unknown } | null)
    ?.required_placement_countries;
  return (
    typeof cells === "object" &&
    cells !== null &&
    Object.hasOwn(cells, env) &&
    (cells as Record<string, unknown>)[env] !== undefined
  );
}

export interface PlacementRefusal {
  readonly status: 409 | 422;
  readonly error: "placement_source_conflict" | "placement_country_refused";
  readonly message: string;
}

export function placementConflictMessage(env: string): string {
  return `the workload manifest declares placement countries and the operator catalog also has required_placement_countries.${env} for this node; one writer only (CD4): remove the catalog cell`;
}

/**
 * Record-time placement admission (story.5141). Returns why the release is refused, or `undefined`.
 * Nothing is paid: the caller writes no release row.
 */
export function releasePlacementRefusal(input: {
  readonly spec: NodeWorkloadSpec;
  readonly catalogRow: unknown;
  readonly env: string;
}): PlacementRefusal | undefined {
  const declared = input.spec.placement?.requiredCountryCodes;
  if (!declared) return undefined;
  const refused = declared.filter((c) =>
    FLEET_REFUSED_PLACEMENT_COUNTRIES.has(c)
  );
  if (refused.length > 0)
    return {
      status: 422,
      error: "placement_country_refused",
      message: `the declared placement set names a country on the fleet refused list: ${refused.join(", ")}`,
    };
  if (catalogDeclaresPlacement(input.catalogRow, input.env))
    return {
      status: 409,
      error: "placement_source_conflict",
      message: placementConflictMessage(input.env),
    };
  return undefined;
}
