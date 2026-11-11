// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/agent.credentials.v1`
 * Purpose: This node's import path for the revocable agent key route contracts (story.5156, child of task.5474): upgrade, rotate, confirm, revoke.
 * Scope: Re-export only; does not define shapes or decide authorization. The zod wire shapes and the result-to-HTTP mapping are fleet-carried and live in the published
 *   `@cogni-dao/agent-grants/credentials`, so a node cannot drift from the fleet's codes. Nothing is defined here.
 * Invariants: CONTRACTS_ARE_TRUTH, defined once in the package (`http.ts`).
 * Side-effects: none
 * Links: https://cognidao.org/work/items/story.5156
 * @public
 */

export {
  confirmAgentCredentialOperation,
  revokeAgentCredentialOperation,
  rotateAgentCredentialOperation,
  upgradeAgentCredentialOperation,
} from "@cogni-dao/agent-grants/credentials";
