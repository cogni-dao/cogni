// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/node-lease-generation`
 * Purpose: Resolve one (node, environment)'s explicit Akash lease replacement counter.
 * Scope: Pure catalog policy parsing. No workflow, git, provider, or cluster I/O.
 * Invariants:
 *   - ZERO_IS_DEFAULT: an absent cell resolves to 0, the same value the XRD defaults, so
 *     adding this field changes nothing until a row opts in. Mirrors LEGACY_IS_DEFAULT.
 *   - NOTHING_BUMPS_IMPLICITLY: the generation is the ONLY varying component of the actuator's
 *     wallet-wide idempotence key (`xcw:<namespace>:<name>:<generation>`). This resolver READS a
 *     human-committed catalog cell and never derives, increments, or synthesizes a value —
 *     a generation that moved on its own would answer "no existing resource" after a promote
 *     and mint a SECOND PAID LEASE.
 *   - GENERATION_IS_NOT_CALLER_INPUT: REST callers never select a generation; only the catalog row does.
 * Side-effects: none
 * Links: story.5016, infra/catalog/_schema.json,
 *   infra/crossplane/xcomputeworkload/xrd.yaml (spec.leaseGeneration)
 * @internal
 */

import { z } from "zod";

import type { DeploymentEnvironment } from "./node-deployment-provider";

/** Bounds mirror the XRD's `spec.leaseGeneration` (integer, minimum 0, maximum 1000000). */
const leaseGenerationCellSchema = z.number().int().min(0).max(1000000);

const catalogLeaseGenerationSchema = z
  .object({
    lease_generation: z
      .object({
        "candidate-a": leaseGenerationCellSchema.optional(),
        preview: leaseGenerationCellSchema.optional(),
        production: leaseGenerationCellSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

/**
 * Resolve one env's lease replacement generation. Missing policy is deliberately 0 — the value
 * every existing workload already runs under via the XRD default — so this field is inert
 * for every row that has never needed a lease replaced.
 *
 * This is the caller-side half of the actuator's settled-key refusal
 * (`akash_tx_create_refused_settled_key`): once a lease closes terminally its idempotence
 * key is spent forever, so recreating that (node, environment) REQUIRES a bumped generation, and
 * the bump must be an explicit human commit to the catalog row — never automation.
 */
export function resolveNodeLeaseGeneration(input: {
  readonly catalog: unknown;
  readonly environment: DeploymentEnvironment;
}): number {
  const parsed = catalogLeaseGenerationSchema.safeParse(input.catalog);
  if (!parsed.success) {
    throw new Error(
      `[lease-generation] Invalid catalog lease_generation: ${parsed.error.message}`
    );
  }
  return parsed.data.lease_generation?.[input.environment] ?? 0;
}
