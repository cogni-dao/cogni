// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/treasury.snapshot.v1`
 * Purpose: Treasury snapshot API contract for GET /api/v1/treasury/snapshot.
 * Scope: Request/response schemas for treasury balance endpoint. Read-only operation. Does not handle RPC calls or business logic.
 * Invariants: No request body (GET); response always returns 200 with optional staleWarning.
 * Side-effects: none (schema definition only)
 * Notes: Phase 2: ETH balance only. staleWarning indicates RPC timeout/error.
 * Links: https://node-template.cognidao.org/knowledge/onchain-read-ports
 * @public
 */

import { z } from "zod";

/**
 * Treasury snapshot request schema (GET, no body)
 */
export const TreasurySnapshotRequestV1 = z.object({});

export type TreasurySnapshotRequestV1 = z.infer<
  typeof TreasurySnapshotRequestV1
>;

/**
 * Token balance in response
 */
export const TokenBalanceV1 = z.object({
  /** Token symbol (e.g., 'ETH', 'USDC') */
  token: z.string(),
  /** Token address (null for native token like ETH) */
  tokenAddress: z.string().nullable(),
  /** Balance in smallest unit as string (wei for ETH) */
  balanceWei: z.string(),
  /** Balance formatted as decimal string */
  balanceFormatted: z.string(),
  /** Token decimals */
  decimals: z.number(),
});

export type TokenBalanceV1 = z.infer<typeof TokenBalanceV1>;

/**
 * Treasury snapshot response schema
 */
export const TreasurySnapshotResponseV1 = z.object({
  /** Treasury address */
  treasuryAddress: z.string(),
  /** Chain ID */
  chainId: z.number(),
  /** Block number as string */
  blockNumber: z.string(),
  /** Array of token balances */
  balances: z.array(TokenBalanceV1),
  /** Timestamp when snapshot was taken (ms since epoch) */
  timestamp: z.number(),
  /** Optional warning flag indicating stale/unavailable data due to RPC timeout */
  staleWarning: z.boolean().optional(),
});

export type TreasurySnapshotResponseV1 = z.infer<
  typeof TreasurySnapshotResponseV1
>;
