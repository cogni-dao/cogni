// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/financial-ledger/domain/accounts`
 * Purpose: Well-known TigerBeetle account IDs, ledger IDs, account codes, and transfer codes.
 * Scope: Pure constants — no I/O, no imports from adapters or app code. Does not contain runtime logic.
 * Invariants:
 *   - MULTI_INSTRUMENT: Separate ledger ID per asset type
 *   - ALL_MATH_BIGINT: All account IDs are bigint (u128)
 *   - MVP_MINIMAL: Only accounts for flows that exist today (credits + USDC)
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/financial-ledger-tigerbeetle
 * @public
 */

// ─── Ledger IDs (Asset Types) ──────────────────────────────────────
// One ledger per asset type. TigerBeetle enforces transfers only within a ledger.

export const LEDGER = {
  /** On-chain stablecoin (USDC on Base, scale=6, 1 USDC = 1_000_000) */
  USDC: 2,
  /** Internal AI credits (scale=0, 10M credits = 1 USD) */
  CREDIT: 200,
} as const;

/**
 * Namespace UUID for deterministic TigerBeetle transfer IDs.
 * Used with uuid v5 to derive transfer IDs from (paymentIntentId, stepCode).
 * Generated once, never changes.
 */
export const TB_TRANSFER_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

// ─── Account Codes (Categories) ────────────────────────────────────

export const ACCOUNT_CODE = {
  ASSETS: 1,
  LIABILITY: 2,
  REVENUE: 3,
  EQUITY: 5,
} as const;

// ─── Transfer Codes ────────────────────────────────────────────────
// One code per business event. Used for reporting/filtering.

export const TRANSFER_CODE = {
  /** User deposits USDC → credits minted */
  CREDIT_DEPOSIT: 1,
  /** AI usage consumes credits */
  AI_USAGE: 2,
  /** Split distributes USDC: treasury → operator wallet */
  SPLIT_DISTRIBUTE: 3,
  /** Operator wallet tops up OpenRouter */
  PROVIDER_TOPUP: 4,
} as const;

// ─── Well-Known Account IDs ────────────────────────────────────────
// 6 accounts across 2 ledgers. Expand only when a real flow requires it.
//
// CREDIT ledger (1xxx):
//   Credit issuance → user liability → revenue on consumption
//
// USDC ledger (2xxx):
//   Treasury holds USDC → operator float after Split distribute → provider float after top-up
//
// Future accounts (add when flows exist):
//   - COGNI/EUR ledgers (when token distribution or hosting expense tracking ships)

export const ACCOUNT = {
  // --- CREDIT ledger (200) ---

  /** Credits owed to users. Increases on deposit/bonus, decreases on AI spend. */
  LIABILITY_USER_CREDITS: 1001n,
  /** Credits consumed by AI usage. Terminal — credits flow here and stop. */
  REVENUE_AI_USAGE: 1002n,
  /** Offset for all credit creation (deposit-backed and bonus).
   *  Every credit minted debits this account to keep the ledger balanced. */
  EQUITY_CREDIT_ISSUANCE: 1003n,

  // --- USDC ledger (2) ---

  /** USDC held in Split contract / DAO treasury (on-chain). */
  ASSETS_TREASURY: 2001n,
  /** USDC in operator wallet — post Split distribute, pre OpenRouter top-up. */
  ASSETS_OPERATOR_FLOAT: 2002n,
  /** Prepaid provider credits (OpenRouter). Asset, not expense. Expense on usage/reconciliation. */
  ASSETS_PROVIDER_FLOAT: 2003n,
} as const;

// ─── Account Definitions (for idempotent creation) ─────────────────

export interface AccountDefinition {
  readonly id: bigint;
  readonly ledger: number;
  readonly code: number;
  readonly name: string;
}

/** All well-known accounts with their ledger and code mappings. */
export const ACCOUNT_DEFINITIONS: readonly AccountDefinition[] = [
  // CREDIT ledger
  {
    id: ACCOUNT.LIABILITY_USER_CREDITS,
    ledger: LEDGER.CREDIT,
    code: ACCOUNT_CODE.LIABILITY,
    name: "Liability:UserCredits",
  },
  {
    id: ACCOUNT.REVENUE_AI_USAGE,
    ledger: LEDGER.CREDIT,
    code: ACCOUNT_CODE.REVENUE,
    name: "Revenue:AIUsage",
  },
  {
    id: ACCOUNT.EQUITY_CREDIT_ISSUANCE,
    ledger: LEDGER.CREDIT,
    code: ACCOUNT_CODE.EQUITY,
    name: "Equity:CreditIssuance",
  },
  // USDC ledger
  {
    id: ACCOUNT.ASSETS_TREASURY,
    ledger: LEDGER.USDC,
    code: ACCOUNT_CODE.ASSETS,
    name: "Assets:Treasury:USDC",
  },
  {
    id: ACCOUNT.ASSETS_OPERATOR_FLOAT,
    ledger: LEDGER.USDC,
    code: ACCOUNT_CODE.ASSETS,
    name: "Assets:OperatorFloat:USDC",
  },
  {
    id: ACCOUNT.ASSETS_PROVIDER_FLOAT,
    ledger: LEDGER.USDC,
    code: ACCOUNT_CODE.ASSETS,
    name: "Assets:ProviderFloat:USDC",
  },
];
