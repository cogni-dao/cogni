// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.latest-distribution.v1.contract`
 * Purpose: Operation contract for serving an account's CUMULATIVE merkle claim from the latest finalized epoch's manifest.
 * Scope: Zod schemas + types for the cumulative claim wire format. Does not contain business logic.
 * Invariants:
 *   - CUMULATIVE_MODEL: `amount` is the account's cumulativeAmount in the latest manifest (NOT a per-epoch delta).
 *   - PAYS_DELTA: on-chain CumulativeMerkleDrop pays out `cumulativeAmount − cumulativeClaimed(account)`.
 *   - ALL_MATH_BIGINT: amount serialized as a decimal string (base ERC20 units).
 *   - PROOF_HEX_ARRAY: proof is an ordered array of 0x-prefixed sibling hashes (sorted-pair OZ proofs).
 *   - DISTRIBUTOR_NULLABLE: distributor is null until the on-chain contract is recorded.
 *   - NO_SECRETS: payload exposes only public claim data.
 * Side-effects: none
 * Links: docs/spec/attribution-pipeline-overview.md, packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts
 * @public
 */

import { z } from "zod";

/**
 * An account's cumulative merkle claim from the latest finalized manifest.
 * `distributor` is the on-chain CumulativeMerkleDrop address (one per node),
 * null until recorded at activation.
 */
export const LatestDistributionClaimSchema = z.object({
  // Epoch id whose manifest produced this cumulative root.
  epochId: z.string(),
  // Cumulative merkle root the contract verifies the proof against (merkleRoot()).
  root: z.string(),
  // CumulativeMerkleDrop contract address; null until recorded.
  distributor: z.string().nullable(),
  chainId: z.number().int(),
  tokenAddress: z.string(),
  // Claim account (EVM address) the proof is bound to.
  account: z.string(),
  // CUMULATIVE base-unit amount (ALL_MATH_BIGINT — string). This is the leaf's
  // cumulativeAmount; the contract pays out amount − cumulativeClaimed(account).
  amount: z.string(),
  // Ordered sibling hashes (PROOF_HEX_ARRAY, sorted-pair OZ proofs).
  proof: z.array(z.string()),
});

export const LatestDistributionOutputSchema = z.object({
  // null when no finalized manifest exists, or the account has no leaf in the
  // latest manifest.
  claim: LatestDistributionClaimSchema.nullable(),
});

export const latestDistributionOperation = {
  id: "ledger.latest-distribution.v1",
  summary:
    "Get an account's cumulative DAO token merkle claim (latest manifest)",
  description:
    "Returns the account's cumulative merkle leaf + proof from the latest finalized epoch that has a distribution manifest. A single cumulative claim covers ALL unclaimed epochs. claim is null when no finalized manifest exists or the account has no leaf in the latest manifest. Public endpoint; serves only public claim data.",
  input: z.object({
    // Claim account address provided as a query param.
    account: z.string(),
  }),
  output: LatestDistributionOutputSchema,
} as const;

export type LatestDistributionClaimDto = z.infer<
  typeof LatestDistributionClaimSchema
>;
export type LatestDistributionOutput = z.infer<
  typeof LatestDistributionOutputSchema
>;
