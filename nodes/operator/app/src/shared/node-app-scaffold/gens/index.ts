// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens`
 * Purpose: Barrel for the pure node-birth generators — each a TS port of one `scaffold-node.sh`
 *   step or `scripts/ci/*.sh` renderer, so the operator can author a node-app PR via the GitHub Git
 *   Data API without a checkout or bash.
 * Scope: Named re-exports only; every member is a pure string/number transform with no IO.
 * Side-effects: none
 * Links: scripts/setup/scaffold-node.sh, task.5092
 * @public
 */

export { insertAppsetKustomization, renderNodeAppset } from "./appset";
export { insertCaddyBlock } from "./caddyfile";
export { type RenderCatalogInput, renderCatalog } from "./catalog";
export { renderGitmodules } from "./gitmodules";
export { nextFreeNodePort } from "./node-port";
export { renderOverlay } from "./overlay";
export { type RenderRepoSpecInput, renderRepoSpec } from "./repo-spec";
export { insertSchedulerEndpoint } from "./scheduler-endpoints";
