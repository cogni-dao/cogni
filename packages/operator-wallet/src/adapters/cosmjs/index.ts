// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/adapters/cosmjs`
 * Purpose: Subpath export for the CosmosSignerPort → cosmjs `OfflineDirectSigner` bridge.
 * Scope: Re-exports only. Does not contain runtime logic.
 * Invariants: Consumers use `@cogni/operator-wallet/adapters/cosmjs` to avoid pulling
 *   `@cosmjs/proto-signing` into non-Cosmos contexts.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/operator-wallet-custody-boundary, work item task.5060 (story.5017 Track B)
 * @public
 */

export { createDirectSignerFromPort } from "./direct-signer.bridge.js";
