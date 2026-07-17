// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.epoch-distribution.v1.contract`
 * Purpose: Defines the operation contract for serving one claimant's DAO token merkle claim (leaf + proof) for an epoch.
 * Scope: Zod schemas and types for the distribution-claim wire format. Does not contain business logic.
 * Invariants:
 *   - ALL_MATH_BIGINT: amount serialized as a decimal string (base ERC20 units).
 *   - PROOF_HEX_ARRAY: proof is an ordered array of 0x-prefixed sibling hashes.
 *   - NO_SECRETS: payload exposes only public claim data (root, index, amount, proof, distributor).
 *   - DISTRIBUTOR_NULLABLE: distributor is null until the on-chain contract is deployed.
 *   - Contract remains stable; breaking changes require a new version.
 * Side-effects: none
 * Links: docs/spec/attribution-pipeline-overview.md, packages/aragon-osx/src/token-distribution.ts
 * @public
 */

import { z } from "zod";

/**
 * The claimant's merkle claim for an epoch distribution.
 * `distributor` is the on-chain MerkleDistributor address, null until deployed.
 */
export const EpochDistributionClaimSchema = z.object({
  epochId: z.string(),
  // Merkle root the claim contract verifies the proof against.
  root: z.string(),
  // MerkleDistributor contract address; null until the contract is deployed.
  distributor: z.string().nullable(),
  chainId: z.number().int(),
  tokenAddress: z.string(),
  // Leaf index in the merkle tree.
  index: z.number().int(),
  // Claim account (EVM address) the proof is bound to.
  account: z.string(),
  // ERC20 base-unit claim amount (ALL_MATH_BIGINT — string).
  amount: z.string(),
  // Ordered sibling hashes (PROOF_HEX_ARRAY).
  proof: z.array(z.string()),
});

export const EpochDistributionOutputSchema = z.object({
  claim: EpochDistributionClaimSchema.nullable(),
});

export const epochDistributionOperation = {
  id: "ledger.epoch-distribution.v1",
  summary: "Get a claimant's DAO token merkle claim for an epoch",
  description:
    "Returns the merkle leaf + proof for the given claim account in the specified finalized epoch's distribution manifest. claim is null when the epoch has no manifest or the account has no leaf. Public endpoint; serves only public claim data.",
  input: z.object({
    // Claim account address provided as a query param.
    account: z.string(),
  }),
  output: EpochDistributionOutputSchema,
} as const;

export type EpochDistributionClaimDto = z.infer<
  typeof EpochDistributionClaimSchema
>;
export type EpochDistributionOutput = z.infer<
  typeof EpochDistributionOutputSchema
>;
