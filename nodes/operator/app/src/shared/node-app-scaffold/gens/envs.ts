// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/envs`
 * Purpose: Single source for the environment matrix a wizard-born node enters.
 * Scope: Pure constants consumed by node-formation generators and route observability.
 * Side-effects: none
 * Links: docs/guides/create-node.md, docs/spec/secrets-management.md
 * @public
 */

/**
 * A `type: node` birth is all-three-envs or none. Candidate-b/canary are not
 * birth targets.
 */
export const NODE_FORMATION_ENVS = [
  "candidate-a",
  "preview",
  "production",
] as const;

export type NodeFormationEnv = (typeof NODE_FORMATION_ENVS)[number];
