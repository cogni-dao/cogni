// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-shared/web3`
 * Purpose: Pure web3 constants — chain config, ABIs, block explorer URLs.
 * Scope: Pure data and constants only. Does NOT include wagmi/viem runtime deps — evm-wagmi + onchain interface stay app-local.
 * Invariants: PURE_LIBRARY — pure data and constants only.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @public
 */

export * from "./block-explorer";
export * from "./chain";
export * from "./erc20-abi";
export * from "./node-formation";
