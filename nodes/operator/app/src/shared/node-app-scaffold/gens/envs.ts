// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/envs`
 * Purpose: Single source for supported deployment environments and the born-production birth set.
 * Scope: Pure constants consumed by node-formation generators and route observability.
 * Side-effects: none
 * Links: story.5025, docs/guides/create-node.md, docs/spec/secrets-management.md
 * @public
 */

/**
 * Every environment that can be managed after birth. Candidate-b/canary are not
 * deployment targets.
 */
export const NODE_DEPLOY_ENVS = [
  "candidate-a",
  "preview",
  "production",
] as const;

export type NodeFormationEnv = (typeof NODE_DEPLOY_ENVS)[number];

/**
 * BORN_PRODUCTION (story.5025). A formation PR renders BOTH environments a Spawn needs and
 * nothing else:
 *
 *   candidate-a — the TRANSIENT proof slot. It is passive by construction (it is not the
 *     activity authority, and only production receives webhooks), and disposable by policy
 *     (`bootPolicyForEnvironment` gives candidate-a `onDeadline: Close`, so a workload that
 *     never serves its exact SHA stops spending instead of renting forever). Closing it is
 *     the ordinary env verb — `{env:"candidate-a", present:false}` — which is legal precisely
 *     because the authority already lives in production.
 *   production — canonical, generation-1 activity authority.
 *
 * PREVIEW_IS_ABSENT_AT_BIRTH: preview is deliberately not here. A birth that renders preview
 * buys a third lease nobody asked for and creates a middle environment with no owner; preview
 * remains an explicit post-birth `{env:"preview", present:true}` transition.
 *
 * Membership is DECLARATIVE, not a deploy trigger. Listing production here commits the
 * production overlay/AppSet/ExternalSecret shape; the production deploy itself is still the
 * separate, human-dispatched promote. Merging a formation PR does not ship to production.
 */
export const NODE_FORMATION_ENVS = [
  "candidate-a",
  "production",
] as const satisfies readonly NodeFormationEnv[];

/**
 * The fixed generation-1 activity environment stamped at birth. Production, because it is the
 * ONLY environment that receives Git webhooks (ACTIVITY_FOLLOWS_INGEST, bug.5079): a node born
 * with a sub-production authority is structurally unable to earn a receipt, and every promote
 * then has to move the authority. Born-production makes the authority immutable for the node's
 * whole life, which is exactly what generation 1 can safely offer — it has no fenced cutover.
 */
export const NODE_FORMATION_ACTIVITY_ENV = "production" as const;
