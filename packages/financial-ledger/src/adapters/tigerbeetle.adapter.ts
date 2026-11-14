// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/financial-ledger/adapters/tigerbeetle`
 * Purpose: TigerBeetle implementation of FinancialLedgerPort.
 * Scope: Translates port operations to tigerbeetle-node client calls. Takes client as constructor arg. Does not load env vars or manage process lifecycle.
 * Invariants:
 *   - DOUBLE_ENTRY_CANONICAL: Balanced transfers enforced by TigerBeetle engine
 *   - ALL_MATH_BIGINT: All amounts are bigint/u128
 *   - ARCHITECTURE_ALIGNMENT: Pure adapter — no env loading, no process lifecycle
 * Side-effects: IO (TigerBeetle network calls)
 * Links: https://node-template.cognidao.org/knowledge/financial-ledger-tigerbeetle
 * @public
 */

import type {
  Account,
  Client,
  CreateAccountsError,
  CreateTransfersError,
} from "tigerbeetle-node";
import { createClient } from "tigerbeetle-node";

import { ACCOUNT_DEFINITIONS } from "../domain/accounts.js";
import {
  type AccountBalance,
  AccountInitError,
  AccountNotFoundError,
  type FinancialLedgerPort,
  type LedgerAccount,
  TransferError,
  type TransferParams,
} from "../port/financial-ledger.port.js";

// ─── Error code ranges for idempotent account creation ─────────────
// CreateAccountError.exists = 21 (idempotent OK)
// CreateAccountError.exists_with_different_* = 15-20 (field mismatch — fatal)
const ACCOUNT_EXISTS = 21;
const ACCOUNT_EXISTS_DIFF_MIN = 15;
const ACCOUNT_EXISTS_DIFF_MAX = 20;

// CreateTransferError.exists = 46 (idempotent OK)
const TRANSFER_EXISTS = 46;

function isAccountExistsOk(result: number): boolean {
  return result === ACCOUNT_EXISTS;
}

function isAccountExistsDifferent(result: number): boolean {
  return result >= ACCOUNT_EXISTS_DIFF_MIN && result <= ACCOUNT_EXISTS_DIFF_MAX;
}

function mapAccount(a: Account): LedgerAccount {
  return {
    id: a.id,
    debitsPending: a.debits_pending,
    debitsPosted: a.debits_posted,
    creditsPending: a.credits_pending,
    creditsPosted: a.credits_posted,
    ledger: a.ledger,
    code: a.code,
    userData128: a.user_data_128,
  };
}

/**
 * TigerBeetleAdapter — implements FinancialLedgerPort via tigerbeetle-node.
 *
 * Constructor takes a TigerBeetle Client instance (no env loading).
 * Lazily creates well-known accounts on first operation (idempotent).
 * Handles `exists` (OK) and `exists_with_different_fields` (fatal) explicitly.
 */
export class TigerBeetleAdapter implements FinancialLedgerPort {
  private initPromise: Promise<void> | null = null;

  constructor(private readonly client: Client) {}

  // ─── Lazy initialization ──────────────────────────────────────────

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.createWellKnownAccounts();
    }
    return this.initPromise;
  }

  private async createWellKnownAccounts(): Promise<void> {
    const accounts: Account[] = ACCOUNT_DEFINITIONS.map((def) => ({
      id: def.id,
      debits_pending: 0n,
      debits_posted: 0n,
      credits_pending: 0n,
      credits_posted: 0n,
      user_data_128: 0n,
      user_data_64: 0n,
      user_data_32: 0,
      reserved: 0,
      ledger: def.ledger,
      code: def.code,
      flags: 0,
      timestamp: 0n,
    }));

    const errors: CreateAccountsError[] =
      await this.client.createAccounts(accounts);

    for (const error of errors) {
      const def = ACCOUNT_DEFINITIONS[error.index];
      const name = def?.name ?? `index=${error.index}`;

      if (isAccountExistsOk(error.result)) {
        // Idempotent — account already exists with same fields
        continue;
      }

      if (isAccountExistsDifferent(error.result)) {
        throw new AccountInitError(
          name,
          `exists with different fields (code=${error.result}). Account definition has drifted.`
        );
      }

      throw new AccountInitError(
        name,
        `creation failed (code=${error.result})`
      );
    }
  }

  // ─── Port Implementation ──────────────────────────────────────────

  async transfer(params: TransferParams): Promise<void> {
    await this.ensureInit();

    const errors: CreateTransfersError[] = await this.client.createTransfers([
      {
        id: params.id,
        debit_account_id: params.debitAccountId,
        credit_account_id: params.creditAccountId,
        amount: params.amount,
        pending_id: 0n,
        user_data_128: params.userData128 ?? 0n,
        user_data_64: params.userData64 ?? 0n,
        user_data_32: params.userData32 ?? 0,
        timeout: 0,
        ledger: params.ledger,
        code: params.code,
        flags: 0,
        timestamp: 0n,
      },
    ]);

    const error = errors[0];
    if (error && error.result !== TRANSFER_EXISTS) {
      throw new TransferError(
        `Transfer failed (code=${error.result})`,
        error.index,
        error.result
      );
    }
  }

  async linkedTransfers(transfers: readonly TransferParams[]): Promise<void> {
    await this.ensureInit();

    if (transfers.length === 0) return;

    // Set linked flag on all transfers except the last one.
    // TigerBeetle's linked flag: if any transfer in the chain fails, all fail.
    const LINKED_FLAG = 1; // TransferFlags.linked

    const tbTransfers = transfers.map((params, i) => ({
      id: params.id,
      debit_account_id: params.debitAccountId,
      credit_account_id: params.creditAccountId,
      amount: params.amount,
      pending_id: 0n,
      user_data_128: params.userData128 ?? 0n,
      user_data_64: params.userData64 ?? 0n,
      user_data_32: params.userData32 ?? 0,
      timeout: 0,
      ledger: params.ledger,
      code: params.code,
      // Linked flag on all except the last transfer
      flags: i < transfers.length - 1 ? LINKED_FLAG : 0,
      timestamp: 0n,
    }));

    const errors: CreateTransfersError[] =
      await this.client.createTransfers(tbTransfers);

    for (const error of errors) {
      if (error.result === TRANSFER_EXISTS) {
        // Idempotent — all transfers already recorded
        continue;
      }
      throw new TransferError(
        `Linked transfer failed at index ${error.index} (code=${error.result})`,
        error.index,
        error.result
      );
    }
  }

  async lookupAccounts(ids: readonly bigint[]): Promise<LedgerAccount[]> {
    await this.ensureInit();

    if (ids.length === 0) return [];

    const accounts: Account[] = await this.client.lookupAccounts([...ids]);
    return accounts.map(mapAccount);
  }

  async getAccountBalance(id: bigint): Promise<AccountBalance> {
    await this.ensureInit();

    const accounts: Account[] = await this.client.lookupAccounts([id]);
    if (accounts.length === 0) {
      throw new AccountNotFoundError(id);
    }

    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const account = accounts[0]!;
    return {
      creditsPosted: account.credits_posted,
      debitsPosted: account.debits_posted,
      creditsPending: account.credits_pending,
      debitsPending: account.debits_pending,
    };
  }
}

/**
 * Create a TigerBeetleAdapter connected to the given address.
 * Wraps tigerbeetle-node createClient so callers don't import the N-API addon directly.
 */
export function createTigerBeetleAdapter(address: string): TigerBeetleAdapter {
  const client = createClient({
    cluster_id: 0n,
    replica_addresses: [address],
  });
  return new TigerBeetleAdapter(client);
}
