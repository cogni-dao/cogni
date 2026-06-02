// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/proposal-abis`
 * Purpose: Contract ABIs for DAO proposal creation (CogniSignal + Aragon TokenVoting).
 * Scope: ABI definitions only — no contract calls, no state.
 * Invariants: ABIs must match deployed contract versions.
 * Side-effects: none
 * Links: cogni-proposal-launcher/src/lib/abis.ts
 * @public
 */

export const COGNI_SIGNAL_ABI = [
  {
    type: "function",
    name: "signal",
    inputs: [
      { name: "vcs", type: "string", internalType: "string" },
      { name: "repoUrl", type: "string", internalType: "string" },
      { name: "action", type: "string", internalType: "string" },
      { name: "target", type: "string", internalType: "string" },
      { name: "resource", type: "string", internalType: "string" },
      { name: "extra", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const TOKEN_VOTING_ABI = [
  {
    type: "function",
    name: "createProposal",
    inputs: [
      { name: "_metadata", type: "bytes", internalType: "bytes" },
      {
        name: "_actions",
        type: "tuple[]",
        internalType: "struct Action[]",
        components: [
          { name: "to", type: "address", internalType: "address" },
          { name: "value", type: "uint256", internalType: "uint256" },
          { name: "data", type: "bytes", internalType: "bytes" },
        ],
      },
      {
        name: "_allowFailureMap",
        type: "uint256",
        internalType: "uint256",
      },
      { name: "_startDate", type: "uint64", internalType: "uint64" },
      { name: "_endDate", type: "uint64", internalType: "uint64" },
      {
        name: "_voteOption",
        type: "uint8",
        internalType: "enum IMajorityVoting.VoteOption",
      },
      { name: "_tryEarlyExecution", type: "bool", internalType: "bool" },
    ],
    outputs: [{ name: "proposalId", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;
