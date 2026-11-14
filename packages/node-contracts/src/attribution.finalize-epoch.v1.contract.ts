// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.finalize-epoch.v1.contract`
 * Purpose: Defines operation contract for the review → finalized epoch transition (sign-at-finalize V0).
 * Scope: Zod schemas and types for finalize-epoch wire format. Does not contain business logic.
 * Invariants:
 *   - WRITE_ROUTES_AUTHED: requires SIWE session
 *   - WRITE_ROUTES_APPROVER_GATED: requires wallet in ledger approvers
 *   - FINALIZE_IN_PROCESS (story.5007): the node finalizes synchronously in its own
 *     route on its own DB — returns 200 + the statement + R3 cumulative distribution.
 *     No Temporal round-trip; idempotent via the fold FREEZE (a re-POST repairs).
 *   - Contract remains stable; breaking changes require new version
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger, packages/attribution-pipeline-plugins/src/finalize/run-finalize-epoch.ts
 * @public
 */

import { z } from "zod";

export const FinalizeEpochInputSchema = z.object({
  /** EIP-712 hex signature of the typed payout statement */
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "Signature must be hex-encoded with 0x prefix"),
});

/**
 * Cumulative distribution produced by the SAME finalize signature (R3). Null when
 * distributions are not activated or no wallet-resolved cumulative balance remains.
 * When present, the on-chain action is DAO.mint(mintDelta) + distributor.setMerkleRoot.
 */
export const FinalizeCumulativeDistributionSchema = z.object({
  distributionId: z.string(),
  merkleRoot: z.string(),
  /** bigint serialized — the DAO mints exactly this delta for the epoch. */
  mintDelta: z.string(),
  /** bigint serialized — cumulative supply distributed to date. */
  cumulativeTotal: z.string(),
  leafCount: z.number().int().nonnegative(),
  tokenAddress: z.string(),
  chainId: z.number().int(),
  /** Existing per-node distributor (null until R2 activation records it). */
  distributorAddress: z.string().nullable(),
});

export const FinalizeEpochOutputSchema = z.object({
  /** Persisted attribution statement id for the finalized epoch. */
  statementId: z.string(),
  /** bigint serialized — total credits in the finalized pool. */
  poolTotalCredits: z.string(),
  /** Deterministic hash of the final claimant allocation set (what was signed). */
  finalAllocationSetHash: z.string(),
  /** Number of statement lines (claimants) in the finalized statement. */
  statementLineCount: z.number().int().nonnegative(),
  /** R3 cumulative manifest built by this finalize, or null when inactive. */
  cumulativeDistribution: FinalizeCumulativeDistributionSchema.nullable(),
});

export const finalizeEpochOperation = {
  id: "ledger.finalize-epoch.v1",
  summary: "Finalize epoch with signature",
  description:
    "Transitions an epoch from review → finalized. Requires an EIP-712 signature of the typed payout statement. SIWE-protected, approver-gated. Finalizes IN-PROCESS on the node's own DB and returns 200 with the statement + R3 cumulative distribution (FINALIZE_IN_PROCESS, story.5007).",
  input: FinalizeEpochInputSchema,
  output: FinalizeEpochOutputSchema,
} as const;

export type FinalizeEpochInput = z.infer<typeof FinalizeEpochInputSchema>;
export type FinalizeEpochOutput = z.infer<typeof FinalizeEpochOutputSchema>;
