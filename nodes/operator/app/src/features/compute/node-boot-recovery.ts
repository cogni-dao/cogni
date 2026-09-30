// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/node-boot-recovery`
 * Purpose: Resolve one (node, environment)'s boot-recovery posture — whether a lease that never
 *   served is held for a human or closed so the bounded re-mint can try another provider.
 * Scope: Pure catalog policy parsing. No workflow, git, provider, or cluster I/O.
 * Invariants:
 *   - HOLD_IS_DEFAULT: an absent row or environment resolves to `hold`, byte-identical to every
 *     row's behaviour before this cell existed. Mirrors ZERO_IS_DEFAULT / LEGACY_IS_DEFAULT.
 *   - RECOVERY_IS_NOT_CALLER_INPUT: only the catalog row selects this (CATALOG_IS_SSOT). A
 *     per-request "is this disposable?" argument is precisely the seam through which a production
 *     workload would eventually be closed by a bad call — see `bootPolicyForEnvironment`.
 *   - ONE_CELL_OPENS_BOTH_GATES: the consumer derives BOTH `onDeadline` and `onGiveUp` from this
 *     single value. `Replace` paired with `onDeadline: Hold` would hold a dead lease forever while
 *     advertising self-healing, which is worse than honest `Hold`, so the two are never
 *     independently settable.
 *   - BOUNDED_BY_THE_COMPOSITION: `auto` authorizes at most 3 `:recover:<n>` attempts per
 *     generation; exhaustion still parks the workload for a human. This never becomes an
 *     unbounded paid retry loop.
 * Side-effects: none
 * Links: story.5050, bug.5325, task.5153 (actuator-owned provider strikes — the prerequisite that
 *   made `Replace` admissible), infra/catalog/_schema.json (`boot_recovery`),
 *   infra/crossplane/xcomputeworkload/composition.yaml (the `:recover:<n>` path this unlocks),
 *   ./compute-workload-manifest (`bootPolicyForEnvironment`)
 * @internal
 */

import { z } from "zod";

import type { BootRecovery } from "./compute-workload-manifest";
import type { DeploymentEnvironment } from "./node-deployment-provider";

/** Mirrors the catalog schema's own enum. */
const bootRecoveryCellSchema = z.enum(["hold", "auto"]);

const catalogBootRecoverySchema = z
  .object({
    boot_recovery: z
      .object({
        "candidate-a": bootRecoveryCellSchema.optional(),
        preview: bootRecoveryCellSchema.optional(),
        production: bootRecoveryCellSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

/**
 * Resolve one environment's boot-recovery posture, defaulting to `hold`.
 *
 * WHY THIS EXISTS. Before it, a provider that won a bid and then failed to serve left the lane
 * stalled until a human noticed, diagnosed, closed the lease and bumped `lease_generation` — one
 * manual cycle per defective provider. With a placement requirement narrowing the pool to a
 * handful of providers, a single bad one could stall a production lane indefinitely while billing
 * (bug.5325). `auto` lets the platform walk its own allowlist instead: close, strike, re-mint
 * elsewhere, bounded at three attempts.
 */
export function resolveNodeBootRecovery(input: {
  readonly catalog: unknown;
  readonly environment: DeploymentEnvironment;
}): BootRecovery {
  const parsed = catalogBootRecoverySchema.safeParse(input.catalog);
  if (!parsed.success) {
    throw new Error(
      `[boot-recovery] Invalid catalog boot_recovery: ${parsed.error.message}`
    );
  }
  return parsed.data.boot_recovery?.[input.environment] ?? "hold";
}
