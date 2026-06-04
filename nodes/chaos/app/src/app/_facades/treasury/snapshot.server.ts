// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/treasury/snapshot.server`
 * Purpose: App-layer facade for treasury snapshot reads with timeout handling.
 * Scope: Server-only. Resolves TreasuryReadPort from DI, calls with strict timeout, maps to contract DTO. Does not perform RPC calls directly or handle routing.
 * Invariants: Timeout enforced (3-5s); returns staleWarning on timeout/error instead of throwing.
 * Side-effects: IO (via TreasuryReadPort → EvmOnchainClient RPC)
 * Notes: No authentication required (public data). Returns 200 with staleWarning on RPC failure.
 * Links: docs/spec/onchain-readers.md
 * @public
 */

import type { TreasurySnapshotResponseV1 } from "@cogni/node-contracts";
import { CHAIN_ID, EVENT_NAMES } from "@cogni/node-shared";
import { getContainer } from "@/bootstrap/container";
import { getDaoConfig } from "@/shared/config/repoSpec.server";
import type { RequestContext } from "@/shared/observability";

const TREASURY_RPC_TIMEOUT_MS = 10_000; // 10s — generous for slow RPC; calls are parallelized

/**
 * Wraps a promise with a timeout
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}

/**
 * Gets treasury snapshot facade with timeout and graceful error handling.
 * Returns staleWarning: true on RPC timeout/error instead of throwing.
 *
 * @param ctx - Request context for logging
 * @returns Treasury snapshot or fallback with staleWarning
 */
export async function getTreasurySnapshotFacade(
  ctx: RequestContext
): Promise<TreasurySnapshotResponseV1> {
  const { treasuryReadPort } = getContainer();
  const daoConfig = getDaoConfig();
  if (!daoConfig) {
    ctx.log.error(
      {
        event: EVENT_NAMES.TREASURY_CONFIG_MISSING,
        errorCode: "TREASURY_NO_DAO_CONFIG",
      },
      "cogni_dao section missing or incomplete in repo-spec"
    );
    throw new Error("cogni_dao config missing from repo-spec");
  }

  const treasuryAddress = daoConfig.dao_contract;
  const start = performance.now();

  try {
    const snapshot = await withTimeout(
      treasuryReadPort.getTreasurySnapshot({
        chainId: CHAIN_ID,
        treasuryAddress,
        tokenAddresses: [], // Phase 2: ETH only
      }),
      TREASURY_RPC_TIMEOUT_MS,
      "Treasury RPC timeout exceeded"
    );

    ctx.log.info(
      {
        event: EVENT_NAMES.TREASURY_SNAPSHOT_COMPLETE,
        outcome: "success",
        chainId: CHAIN_ID,
        treasuryAddress,
        blockNumber: snapshot.blockNumber.toString(),
        balances: snapshot.balances.length,
        durationMs: performance.now() - start,
      },
      "treasury_rpc_success"
    );

    return {
      treasuryAddress: snapshot.treasuryAddress,
      chainId: snapshot.chainId,
      blockNumber: snapshot.blockNumber.toString(),
      balances: snapshot.balances.map((b) => ({
        token: b.token,
        tokenAddress: b.tokenAddress,
        balanceWei: b.balanceWei.toString(),
        balanceFormatted: b.balanceFormatted,
        decimals: b.decimals,
      })),
      timestamp: snapshot.timestamp,
      staleWarning: false,
    };
  } catch {
    const durationMs = performance.now() - start;

    ctx.log.warn(
      {
        event: EVENT_NAMES.TREASURY_SNAPSHOT_COMPLETE,
        outcome: "error",
        errorCode: "TREASURY_RPC_FAILURE",
        chainId: CHAIN_ID,
        treasuryAddress,
        durationMs,
      },
      "treasury_rpc_failure"
    );

    return {
      treasuryAddress,
      chainId: CHAIN_ID,
      blockNumber: "0",
      balances: [],
      timestamp: Date.now(),
      staleWarning: true,
    };
  }
}
