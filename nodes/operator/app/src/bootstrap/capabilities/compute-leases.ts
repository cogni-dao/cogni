// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/compute-leases`
 * Purpose: Factory for the READ-ONLY lease surface (story.5039) — the app-side view of the
 *   Akash allocation ledger plus the Console status read-back, so deploy-state and the env
 *   verb can enumerate live paid leases and prove their closure (bug.5189: CLOSE→VERIFY→CLEAR).
 * Scope: Wires `DrizzleAkashTxAllocationLedger` (scoped to the actuator wallet's account, via
 *   the SAME `accountWalletScope` derivation the actuator uses — one function, cannot drift)
 *   and reuses the compute capability's optional Console `status` read. Creates nothing that
 *   can spend: the app never holds the actuator's Console credential
 *   (NEVER_HOLDS_TWO_WALLETS), only the public account pin that names the ledger scope.
 * Invariants:
 *   - READ_ONLY_BY_CONSTRUCTION: the capability exposes `listAllocated` + `listReceipts` + a
 *     status read. No claim/prepare/record/fail path is reachable through it.
 *   - GRACEFUL_DEGRADATION: no `AKASH_ACTUATOR_ACCOUNT_ID` → undefined capability; routes
 *     surface "leases unwired" rather than an empty (and therefore lying) list.
 *   - SCOPED_LIKE_THE_WRITER: every ledger read is wallet-scoped exactly like the actuator's
 *     writes — the scope is receipt identity (SCOPE_IS_HALF_THE_LOOKUP_KEY), so an unscoped or
 *     differently-derived read silently sees nothing.
 * Side-effects: none (factory only)
 * Links: @adapters/server/compute/akash-tx-allocation-ledger.adapter,
 *   @features/compute/akash-tx/akash-tx-wallet (accountWalletScope),
 *   @bootstrap/capabilities/compute (the Console client's home), story.5039, bug.5189
 * @internal
 */

import type { ComputeResourcePort } from "@cogni/ai-tools";
import type { Database } from "@cogni/db-client";

import { DrizzleAkashTxAllocationLedger } from "@/adapters/server";
import { accountWalletScope } from "@/features/compute/akash-tx/akash-tx-wallet";
import type { LeaseStatusReader } from "@/features/compute/lease-closure-verification";
import type { AkashTxAllocationRecord } from "@/ports";
import type { ServerEnv } from "@/shared/env";

/** Read-only lease surface: ledger enumeration + optional Console status read-back. */
export interface LeaseReadCapability {
  /** Wallet-scoped enumeration of live paid leases — see `AkashTxAllocationLedgerPort.listAllocated`. */
  listAllocated(input: {
    nodeId?: string;
    environment?: string;
    limit: number;
  }): Promise<readonly AkashTxAllocationRecord[]>;
  /** Every-state receipt enumeration for generation derivation (task.5132) — see `AkashTxAllocationLedgerPort.listReceipts`. */
  listReceipts(input: {
    nodeId?: string;
    environment?: string;
    limit: number;
  }): Promise<readonly AkashTxAllocationRecord[]>;
  /** Console status read-back; undefined when the app holds no Console read credential. */
  readonly readLeaseStatus: LeaseStatusReader | undefined;
}

/**
 * Create the lease read capability, or undefined when the actuator account is not pinned on
 * the app runtime. The Console read-back rides the EXISTING compute capability's optional
 * `status` (AKASH_CONSOLE_API_KEY) — same client, same account custody rules; absent, closure
 * verification degrades to `unknown`, never to a fabricated `closed`.
 */
export function createLeaseReadCapability(
  env: ServerEnv,
  getDb: () => Promise<Database>,
  compute: ComputeResourcePort
): LeaseReadCapability | undefined {
  const accountId = env.AKASH_ACTUATOR_ACCOUNT_ID?.trim();
  if (!accountId) return undefined;
  const ledger = new DrizzleAkashTxAllocationLedger(
    getDb,
    accountWalletScope(accountId)
  );
  const status = compute.status?.bind(compute);
  return {
    listAllocated: (input) => ledger.listAllocated(input),
    listReceipts: (input) => ledger.listReceipts(input),
    readLeaseStatus: status
      ? async ({ leaseId }) => ({ state: (await status({ leaseId })).state })
      : undefined,
  };
}
