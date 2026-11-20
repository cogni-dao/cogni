// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/work-item`
 * Purpose: Re-export the released work-item capability and conflict identity.
 * Scope: Shared contracts only. Does not implement work-item behavior.
 * Invariants:
 *   - RELEASE_OWNS_CONTRACTS: Types and errors come from the same immutable tools release.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/adopt-node-package-release
 * @public
 */
export {
  type WorkItemAssignee,
  type WorkItemCapability,
  type WorkItemInfo,
  WorkItemPatchConflictError,
  type WorkItemQueryPage,
  type WorkItemQueryParams,
} from "@cogni/shared-ai-tools";
