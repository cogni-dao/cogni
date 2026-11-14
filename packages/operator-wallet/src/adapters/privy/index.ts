// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/adapters/privy`
 * Purpose: Subpath export for the Privy-managed operator wallet adapter.
 * Scope: Re-exports only. Does not contain runtime logic.
 * Invariants: Consumers use `@cogni/operator-wallet/adapters/privy` to avoid pulling Privy SDK into non-wallet contexts.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/operator-wallet-custody-boundary
 * @public
 */

export {
  PrivyCosmosSigner,
  type PrivyCosmosSignerConfig,
} from "./privy-cosmos-signer.adapter.js";
export {
  PrivyOperatorWalletAdapter,
  type PrivyOperatorWalletConfig,
} from "./privy-operator-wallet.adapter.js";
