// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens`
 * Purpose: Barrel for the pure node-formation generators — each a TS port of one `scaffold-node.sh`
 *   step or `scripts/ci/*.sh` renderer, so the operator can author a node-app PR via the GitHub Git
 *   Data API without a checkout or bash.
 * Scope: Named re-exports only; every member is a pure string/number transform with no IO.
 * Side-effects: none
 * Links: scripts/setup/scaffold-node.sh, task.5092
 * @public
 */

export {
  insertAppsetKustomization,
  removeFromAppsetsKustomization,
  renderNodeAppset,
} from "./appset";
export { insertCaddyBlock } from "./caddyfile";
export { type RenderCatalogInput, renderCatalog } from "./catalog";
export {
  DISTRIBUTION_CLAIM_CONTRACT_PATTERN,
  hasDistributionActivationSpec,
  type RenderDistributionActivationInput,
  renderDistributionActivationSpec,
} from "./distribution-activation";
export {
  addCatalogEnv,
  dropCatalogEnv,
  type EnvRemovalViolation,
  envRemovalViolation,
  hasCatalogSourceRepo,
  PLACEMENT_PROVIDERS,
  type PlacementProvider,
  parseCatalogActivityEnv,
  parseCatalogEnvs,
  parseCatalogPlacement,
  setCatalogEnvs,
  setCatalogPlacement,
} from "./env-membership";
export {
  appsetPath,
  appsetsKustomizationPath,
  buildEnvDeltaPlan,
  buildPlacementPlan,
  CATALOG_PATH,
  type EnvDeltaResult,
  type EnvPlanCurrent,
  EnvPlanError,
  type EnvPlanOp,
  externalSecretPath,
  overlayPath,
  type PlacementDeltaResult,
} from "./env-membership-plan";
export {
  NODE_DEPLOY_ENVS,
  NODE_FORMATION_ACTIVITY_ENV,
  NODE_FORMATION_ENVS,
  type NodeFormationEnv,
} from "./envs";
export {
  renderNodeExternalSecret,
  renderNodeExternalSecretKustomization,
} from "./external-secret";
export { insertNetworkNode } from "./network-nodes";
export { nextFreeNodePort } from "./node-port";
export { renderOverlay, renderOverlayFile } from "./overlay";
export {
  ACTIVATION_MARKUP_FACTOR,
  ACTIVATION_REVENUE_SHARE,
  hasPaymentsActivationSpec,
  type RenderPaymentsActivationInput,
  renderPaymentsActivationSpec,
} from "./payments-activation";
export { type RenderRepoSpecInput, renderRepoSpec } from "./repo-spec";
export { insertSchedulerEndpoint } from "./scheduler-endpoints";
