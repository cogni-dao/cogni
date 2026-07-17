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
  // ProposalCreated is the AUTHORITATIVE source of the on-chain proposalId.
  // In OSx 1.4 TokenVoting the id is a hash that does NOT equal the value a
  // createProposal simulation returns — parse it from this event in the receipt
  // (proven in spikes/walk-p4-mint-into-distributor/REPORT.md, Surprise #2).
  {
    type: "event",
    name: "ProposalCreated",
    anonymous: false,
    inputs: [
      {
        name: "proposalId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "creator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      { name: "startDate", type: "uint64", indexed: false },
      { name: "endDate", type: "uint64", indexed: false },
      { name: "metadata", type: "bytes", indexed: false },
      {
        name: "actions",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "allowFailureMap", type: "uint256", indexed: false },
    ],
  },
  // Read-back to confirm the proposal EARLY-EXECUTED in the same tx (executed=true).
  {
    type: "function",
    name: "getProposal",
    stateMutability: "view",
    inputs: [{ name: "_proposalId", type: "uint256" }],
    outputs: [
      { name: "open", type: "bool" },
      { name: "executed", type: "bool" },
      {
        name: "parameters",
        type: "tuple",
        components: [
          { name: "votingMode", type: "uint8" },
          { name: "supportThreshold", type: "uint32" },
          { name: "startDate", type: "uint64" },
          { name: "endDate", type: "uint64" },
          { name: "snapshotBlock", type: "uint64" },
          { name: "minVotingPower", type: "uint256" },
        ],
      },
      {
        name: "tally",
        type: "tuple",
        components: [
          { name: "abstain", type: "uint256" },
          { name: "yes", type: "uint256" },
          { name: "no", type: "uint256" },
        ],
      },
      {
        name: "actions",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "allowFailureMap", type: "uint256" },
    ],
  },
] as const;
