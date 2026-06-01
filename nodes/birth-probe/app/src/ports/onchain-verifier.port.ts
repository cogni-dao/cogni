// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/onchain-verifier`
 * Purpose: On-chain transaction verification port for payment validation.
 * Scope: Generic verification interface with no blockchain or indexer-specific types. Does not perform verification logic.
 * Invariants: Verification is deterministic and read-only; no side effects until feature layer settles.
 * Side-effects: none (interface definition only)
 * Notes: MVP adapter stubs VERIFIED; Phase 3 uses Ponder. Uses PaymentErrorCode (may refactor later).
 * Links: Implemented by PonderOnChainVerifierAdapter (stubbed) and FakeOnChainVerifierAdapter (test)
 * @public
 */

import type { PaymentErrorCode } from "@cogni/node-core";

/**
 * Verification status returned by OnChainVerifier
 * VERIFIED: Transaction found and validated
 * PENDING: Transaction not yet confirmed or indexed
 * FAILED: Transaction invalid or failed validation
 */
export type VerificationStatus = "VERIFIED" | "PENDING" | "FAILED";

/**
 * Result of on-chain verification
 * Contains actual transaction data for validation
 */
export interface VerificationResult {
  /** Verification status */
  status: VerificationStatus;
  /** Actual sender address (checksummed, null if not found) */
  actualFrom: string | null;
  /** Actual recipient address (checksummed, null if not found) */
  actualTo: string | null;
  /** Actual transfer amount in raw units (null if not found) */
  actualAmount: bigint | null;
  /** Number of confirmations (null if not found) */
  confirmations: number | null;
  /** Error code if status is FAILED */
  errorCode?: PaymentErrorCode;
}

/**
 * On-chain transaction verifier port
 * Abstracts blockchain/indexer verification logic
 */
export interface OnChainVerifier {
  /**
   * Verifies on-chain transaction matches expected parameters
   * Deterministic read-only operation with no side effects
   *
   * MVP (stubbed): Always returns VERIFIED with expected values
   * Phase 3 (Ponder): Queries indexed Transfer events for real validation
   *
   * @param params - Verification parameters
   * @param params.chainId - Chain ID (Ethereum Sepolia 11155111 for MVP)
   * @param params.txHash - Transaction hash to verify
   * @param params.expectedTo - Expected recipient address (DAO wallet)
   * @param params.expectedToken - Expected token address (USDC)
   * @param params.expectedAmount - Expected transfer amount in raw units
   * @returns Verification result with actual transaction data
   */
  verify(params: {
    chainId: number;
    txHash: string;
    expectedTo: string;
    expectedToken: string;
    expectedAmount: bigint;
  }): Promise<VerificationResult>;
}
