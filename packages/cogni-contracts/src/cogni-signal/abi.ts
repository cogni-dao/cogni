// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/contracts/cogni-signal/abi`
 * Purpose: CogniSignal contract ABI for deployment and verification.
 * Scope: ABI constant only; does not include bytecode or addresses.
 * Invariants: ABI must match solc 0.8.30 compiled output.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

/**
 * CogniSignal ABI (minimal for deployment + verification).
 * Source: cogni-gov-contracts/out/CogniSignal.sol/CogniSignal.json
 */
export const COGNI_SIGNAL_ABI = [
  {
    type: "constructor",
    inputs: [{ name: "dao", type: "address", internalType: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "DAO",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
] as const;
