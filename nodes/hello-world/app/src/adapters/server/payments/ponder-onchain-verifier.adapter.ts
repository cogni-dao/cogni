// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/payments/ponder-onchain-verifier`
 * Purpose: Ponder-backed on-chain verifier adapter (stubbed for MVP, real Ponder queries in Phase 3).
 * Scope: Implements OnChainVerifier port. Does not perform business logic or state transitions.
 * Invariants: MVP returns stubbed VERIFIED; Phase 3 will query Ponder indexer for real validation.
 * Side-effects: IO (will query Ponder in Phase 3; currently no I/O)
 * Notes: Stub always returns VERIFIED with expected values echoed back. Replace stub logic with Ponder queries in Phase 3.
 * Links: Implements OnChainVerifier port
 * @public
 */

import { MIN_CONFIRMATIONS } from "@cogni/node-shared";
import type { OnChainVerifier, VerificationResult } from "@/ports";

/**
 * Ponder-backed on-chain verifier (stubbed for MVP)
 * Phase 3: Will query Ponder indexer for USDC Transfer events
 */
export class PonderOnChainVerifierAdapter implements OnChainVerifier {
  async verify(params: {
    chainId: number;
    txHash: string;
    expectedTo: string;
    expectedToken: string;
    expectedAmount: bigint;
  }): Promise<VerificationResult> {
    // MVP STUB: Always return VERIFIED with expected values
    // Phase 3 TODO: Query Ponder GraphQL endpoint for indexed Transfer event
    // Phase 3 TODO: Validate actualFrom, actualTo, actualAmount, confirmations
    // Phase 3 TODO: Return PENDING if not indexed, FAILED with errorCode if validation fails

    return {
      status: "VERIFIED",
      actualFrom: null, // Unknown in stub - will be from Ponder in Phase 3
      actualTo: params.expectedTo,
      actualAmount: params.expectedAmount,
      confirmations: MIN_CONFIRMATIONS, // Use canonical constant
    };
  }
}
