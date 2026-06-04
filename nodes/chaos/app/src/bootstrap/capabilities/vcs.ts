// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/vcs`
 * Purpose: Stub VcsCapability for nodes that don't have GitHub App credentials.
 * Scope: Satisfies TOOL_BINDING_REQUIRED without real VCS operations. Does not perform I/O.
 * Invariants:
 *   - GRACEFUL_DEGRADATION: Returns stub (throws on use, not on bind)
 * Side-effects: none
 * Links: task.0242
 * @internal
 */

import type { VcsCapability } from "@cogni/ai-tools";

/**
 * Stub VcsCapability — satisfies tool binding requirement but throws if called.
 * Nodes that need real VCS should use the operator's createVcsCapability factory.
 */
export const stubVcsCapability: VcsCapability = {
  listPrs: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  getCiStatus: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  mergePr: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  createBranch: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  dispatchCandidateFlight: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
};
