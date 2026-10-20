// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/node-isolated-services`
 * Purpose: Resolve which declared node services the operator places in their own lease.
 * Scope: Pure catalog policy parsing plus receipt-family scoping. No workflow, git, provider, or cluster I/O.
 * Invariants:
 *   - PLACEMENT_IS_OPERATOR_POLICY: the node declares an ordinary private service in its
 *     repo-spec; only the operator catalog row (`isolated_services`) moves it into its own lease.
 *   - ISOLATED_SERVICE_IS_ITS_OWN_LEASE: each isolated service is one more XComputeWorkload named
 *     `<nodeId>-<service>` with its own idempotence key family and its own lease_generation,
 *     while its spend receipt keeps the node's nodeId.
 *   - NOTHING_BUMPS_IMPLICITLY: each instance's generation is a human-committed catalog cell;
 *     absent resolves to 0, exactly like the primary workload's `lease_generation`.
 *   - APP_GENERATION_EVIDENCE_IS_ITS_OWN_FAMILY: receipts are scoped by key family before any
 *     generation is derived, so an instance lease never moves the primary workload's generation.
 * Side-effects: none
 * Links: story.5093, task.5272, infra/catalog/_schema.json, infra/crossplane/xcomputeworkload/xrd.yaml (spec.instance)
 * @internal
 */

import { z } from "zod";

import type { DeploymentEnvironment } from "./node-deployment-provider";

const generationCell = z.number().int().min(0).max(1000000);

const catalogIsolatedServicesSchema = z
  .object({
    isolated_services: z
      .record(
        z.string().regex(/^[a-z][a-z0-9-]{0,19}$/),
        z
          .object({
            lease_generation: z
              .object({
                "candidate-a": generationCell.optional(),
                preview: generationCell.optional(),
                production: generationCell.optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
      )
      .optional(),
  })
  .passthrough();

export interface NodeIsolatedService {
  /** Declared repo-spec service name; also the XR `spec.instance`. */
  readonly service: string;
  readonly leaseGeneration: number;
}

/** Catalog-declared isolated services for one environment, in stable name order. */
export function resolveNodeIsolatedServices(input: {
  readonly catalog: unknown;
  readonly environment: DeploymentEnvironment;
}): readonly NodeIsolatedService[] {
  const parsed = catalogIsolatedServicesSchema.safeParse(input.catalog);
  if (!parsed.success) {
    throw new Error(
      `[isolated-services] Invalid catalog isolated_services: ${parsed.error.message}`
    );
  }
  return Object.entries(parsed.data.isolated_services ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([service, cell]) => ({
      service,
      leaseGeneration: cell.lease_generation?.[input.environment] ?? 0,
    }));
}

/**
 * Drop receipts minted for one of this node's ISOLATED-SERVICE leases, so they never count as
 * the primary workload's generation evidence. Crossplane keys are
 * `xcw:<namespace>:<workloadName>:<generation>[:recover:<n>]` and an instance's workload name is
 * `<nodeId>-<instance>`; only that shape is removed. Every other receipt, including legacy key
 * shapes, passes through unchanged so callers keep their existing evidence and refusals.
 */
export function receiptsExcludingInstances<
  T extends { readonly cogniKey: string },
>(receipts: readonly T[], nodeId: string): T[] {
  return receipts.filter((receipt) => {
    const name = /^xcw:[^:]+:([^:]+):/.exec(receipt.cogniKey)?.[1];
    return !name?.startsWith(`${nodeId}-`);
  });
}
