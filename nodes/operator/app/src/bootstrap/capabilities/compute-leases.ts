// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/compute-leases`
 * Purpose: Factory for the READ-ONLY lease surface (story.5039) — the app-side view of the
 *   Akash allocation ledger, so deploy-state and the env verb can enumerate live paid leases.
 *   Closure PROOF (bug.5189 CLOSE→VERIFY→CLEAR) lives in the actuator pod, not here.
 * Scope: Wires `DrizzleAkashTxAllocationLedger` (scoped to the actuator wallet's account, via
 *   the SAME `accountWalletScope` derivation the actuator uses — one function, cannot drift)
 *   Creates nothing that can spend and reads no Console API: the app never holds ANY Console
 *   credential (ONE_CONSOLE_KEY_PER_ACCOUNT, task.5138), only the public account pin that
 *   names the ledger scope.
 * Invariants:
 *   - READ_ONLY_BY_CONSTRUCTION: the capability exposes `listAllocated` + `listReceipts`
 *     only. No claim/prepare/record/fail path — and no Console status read — is reachable
 *     through it.
 *   - GRACEFUL_DEGRADATION: no `AKASH_ACTUATOR_ACCOUNT_ID` → undefined capability; routes
 *     surface "leases unwired" rather than an empty (and therefore lying) list.
 *   - SCOPED_LIKE_THE_WRITER: every ledger read is wallet-scoped exactly like the actuator's
 *     writes — the scope is receipt identity (SCOPE_IS_HALF_THE_LOOKUP_KEY), so an unscoped or
 *     differently-derived read silently sees nothing.
 * Side-effects: none (factory only)
 * Links: @adapters/server/compute/akash-tx-allocation-ledger.adapter,
 *   @features/compute/akash-tx/akash-tx-wallet (accountWalletScope),
 *   story.5039, bug.5189, task.5138
 * @internal
 */

import type { Database } from "@cogni/db-client";

import { DrizzleAkashTxAllocationLedger } from "@/adapters/server";
import { accountWalletScope } from "@/features/compute/akash-tx/akash-tx-wallet";
import type { AkashTxAllocationRecord } from "@/ports";
import type { ServerEnv } from "@/shared/env";

/** Read-only lease surface: wallet-scoped ledger enumeration. */
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
}

/**
 * Create the lease read capability, or undefined when the actuator account is not pinned on
 * the app runtime. There is no Console read-back here: the app holds no Console credential
 * (ONE_CONSOLE_KEY_PER_ACCOUNT, task.5138), so closure verification reads `unknown` and the
 * authoritative CLOSE→VERIFY→CLEAR proof runs inside the actuator pod (bug.5189 runbook).
 */
export function createLeaseReadCapability(
  env: ServerEnv,
  getDb: () => Promise<Database>
): LeaseReadCapability | undefined {
  const accountId = env.AKASH_ACTUATOR_ACCOUNT_ID?.trim();
  if (!accountId) return undefined;
  const ledger = new DrizzleAkashTxAllocationLedger(
    getDb,
    accountWalletScope(accountId)
  );
  return {
    listAllocated: (input) => ledger.listAllocated(input),
    listReceipts: (input) => ledger.listReceipts(input),
  };
}
