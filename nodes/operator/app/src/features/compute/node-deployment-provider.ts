// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/node-deployment-provider`
 * Purpose: Resolve operator-owned per-environment placement policy from one catalog row.
 * Scope: Pure catalog policy parsing. No workflow, git, provider, or cluster I/O.
 * Invariants:
 *   - K3S_IS_DEFAULT: an absent env override preserves the existing deployment path.
 *   - OPERATOR_OWNS_PLACEMENT: node repo-spec owns topology; parent catalog owns placement.
 *   - PROVIDER_IS_NOT_CALLER_INPUT: REST callers never select a compute provider.
 * Side-effects: none
 * Links: story.5016, task.5056, infra/catalog/_schema.json
 * @internal
 */

import { z } from "zod";

import { NODE_DEPLOYMENT_PROVIDERS } from "@/shared/node-registry/placement";

export const deploymentEnvironmentSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);
export type DeploymentEnvironment = z.infer<typeof deploymentEnvironmentSchema>;

// PLACEMENT_IS_NOT_A_SECOND_LIST — one provider vocabulary, shared with the runtime address
// resolver (`@shared/node-registry/placement`) so CI policy and request-time routing cannot drift.
export const nodeDeploymentProviderSchema = z.enum(NODE_DEPLOYMENT_PROVIDERS);
export type NodeDeploymentProvider = z.infer<
  typeof nodeDeploymentProviderSchema
>;

const catalogPlacementSchema = z
  .object({
    deployment_provider: z
      .object({
        "candidate-a": nodeDeploymentProviderSchema.optional(),
        preview: nodeDeploymentProviderSchema.optional(),
        production: nodeDeploymentProviderSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

/** Resolve one env's provider. Missing policy is deliberately the existing k3s lane. */
export function resolveNodeDeploymentProvider(input: {
  readonly catalog: unknown;
  readonly environment: DeploymentEnvironment;
}): NodeDeploymentProvider {
  const parsed = catalogPlacementSchema.safeParse(input.catalog);
  if (!parsed.success) {
    throw new Error(
      `[deployment-provider] Invalid catalog placement: ${parsed.error.message}`
    );
  }
  return parsed.data.deployment_provider?.[input.environment] ?? "k3s";
}
