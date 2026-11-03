// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/node-catalog-policy`
 * Purpose: Read the two PUBLIC, node-owned policy cells the node-deploy sequencer applies to a node
 *   app from the node's catalog row (the one baked into the operator image): the hard placement
 *   countries and the database pool maxes (task.5405). Same cells the Crossplane lane read.
 * Scope: Pure parsing. The row arrives through `NodeCatalogPort`; nothing here touches the disk.
 * Invariants:
 *   - ABSENT_IS_UNCONSTRAINED: no cell means no country requirement and no pool env, never a default.
 *   - INVALID_IS_AN_ERROR_NOT_A_WILDCARD: a malformed cell throws (the sequencer waits and says why)
 *     instead of widening placement. An empty country list is rejected, not read as "anywhere".
 *   - REUSE: country parsing is `resolveNodeRequiredPlacement`; pool limits use the shared schema.
 * Side-effects: none
 * Links: features/compute/node-required-placement.ts, infra/catalog/_schema.json, task.5405
 * @internal
 */

import { z } from "zod";

import { resolveNodeRequiredPlacement } from "@/features/compute/node-required-placement";
import { DatabaseCellRuntimePoolLimitsSchema } from "@/shared/secrets/database-cell-binding.data";

import type { NodeAppPoolLimits } from "./node-app-env";

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
