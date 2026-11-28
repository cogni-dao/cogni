// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-read`
 * Purpose: Apply operator policy to the released work-item reader.
 * Scope: Tool composition only. Does not implement the shared read envelope.
 * Invariants:
 *   - HOST_POLICY_PRESERVED: The reader requires node collaboration authority.
 *   - RELEASE_OWNS_BEHAVIOR: The operator supplies no private read implementation.
 * Side-effects: none (composition only)
 * Links: https://node-template.cognidao.org/knowledge/work-item-artifacts
 * @public
 */
import {
  workItemReadBoundTool as sharedRead,
  workItemReadContract as sharedReadContract,
} from "@cogni/shared-ai-tools";

export {
  createWorkItemReadImplementation,
  WORK_ITEM_READ_NAME,
} from "@cogni/shared-ai-tools";
export const workItemReadContract = {
  ...sharedReadContract,
  requires: "node.collaborate",
};
export const workItemReadBoundTool = {
  ...sharedRead,
  contract: workItemReadContract,
};
