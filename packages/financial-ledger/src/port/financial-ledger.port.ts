// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/financial-ledger/port`
 * Purpose: Vendor-agnostic port for double-entry financial ledger operations.
 * Scope: Defines contract for money-movement recording. Does not contain implementations.
 * Invariants:
 *   - DOUBLE_ENTRY_CANONICAL: Every transfer is balanced (debit + credit)
 *   - LEDGER_PORT_IS_WRITE_PATH: All money-movement goes through this port
 *   - ALL_MATH_BIGINT: All monetary amounts are bigint (u128 compatible)
 * Side-effects: none (interface definition only)
 * Links: https://node-template.cognidao.org/knowledge/financial-ledger-tigerbeetle
 * @public
 */

// ─── Transfer Parameters ───────────────────────────────────────────

export interface TransferParams {
  /** Unique transfer ID (u128). Use uuidToBigInt() for deterministic IDs from Postgres UUIDs. */
  readonly id: bigint;
  /** Account to debit */
  readonly debitAccountId: bigint;
  /** Account to credit */
  readonly creditAccountId: bigint;
  /** Transfer amount (must be > 0) */
  readonly amount: bigint;
  /** Ledger ID — must match both accounts' ledger */
  readonly ledger: number;
  /** Transfer code (category — e.g., deposit, AI usage, expense) */
  readonly code: number;
  /** Links transfer to Postgres record (e.g., charge_receipt UUID as bigint) */
  readonly userData128?: bigint;
  /** Optional secondary user data */
  readonly userData64?: bigint;
  /** Optional tertiary user data */
  readonly userData32?: number;
}

// ─── Query Results ─────────────────────────────────────────────────

export interface LedgerAccount {
  readonly id: bigint;
  readonly debitsPending: bigint;
  readonly debitsPosted: bigint;
  readonly creditsPending: bigint;
  readonly creditsPosted: bigint;
  readonly ledger: number;
  readonly code: number;
  readonly userData128: bigint;
}

export interface AccountBalance {
  /** Total credits posted to this account */
  readonly creditsPosted: bigint;
  readonly debitsPosted: bigint;
  readonly creditsPending: bigint;
  readonly debitsPending: bigint;
}

// ─── Error Types ───────────────────────────────────────────────────

export class FinancialLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancialLedgerError";
  }
}

export class TransferError extends FinancialLedgerError {
  constructor(
    message: string,
    readonly transferIndex?: number,
    readonly resultCode?: number
  ) {
    super(message);
    this.name = "TransferError";
  }
}

export class AccountNotFoundError extends FinancialLedgerError {
  constructor(readonly accountId: bigint) {
    super(`Account ${accountId} not found in TigerBeetle`);
    this.name = "AccountNotFoundError";
  }
}

export class AccountInitError extends FinancialLedgerError {
  constructor(
    readonly accountName: string,
    readonly reason: string
  ) {
    super(`Failed to init account ${accountName}: ${reason}`);
    this.name = "AccountInitError";
  }
}

/** Type guard for FinancialLedgerError */
export function isFinancialLedgerError(
  err: unknown
): err is FinancialLedgerError {
  return err instanceof FinancialLedgerError;
}

// ─── Port Interface ────────────────────────────────────────────────

/**
 * FinancialLedgerPort — write path for all money-movement operations.
 *
 * Per LEDGER_PORT_IS_WRITE_PATH: all balance-changing events go through this port.
 * Per DOUBLE_ENTRY_CANONICAL: every transfer debits one account and credits another.
 *
 * Crawl scope: transfer, linkedTransfers, lookupAccounts, getAccountBalance.
 * Walk scope (task.0147): pendingTransfer, postTransfer, voidTransfer.
 */
export interface FinancialLedgerPort {
  /**
   * Execute a single-ledger transfer (debit one account, credit another).
   * Both accounts must be on the same ledger.
   * @throws TransferError if the transfer is rejected by the engine
   */
  transfer(params: TransferParams): Promise<void>;

  /**
   * Execute multiple transfers atomically (linked).
   * All succeed or all fail. Used for cross-ledger operations
   * (e.g., USDC deposit → clearing → credit mint).
   * @throws TransferError if any transfer in the chain is rejected
   */
  linkedTransfers(transfers: readonly TransferParams[]): Promise<void>;

  /**
   * Look up accounts by IDs. Returns only accounts that exist.
   */
  lookupAccounts(ids: readonly bigint[]): Promise<LedgerAccount[]>;

  /**
   * Get balance for a single account.
   * @throws AccountNotFoundError if the account does not exist
   */
  getAccountBalance(id: bigint): Promise<AccountBalance>;
}
