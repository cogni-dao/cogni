// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-balance-watch`
 * Purpose: Low-water alarm over the Akash Console managed-wallet balance (story.5013,
 *   bug.5302). The Console account silently reached $0 (HTTP 402 on deployment create) and the
 *   fleet's leases died one by one over hours with ZERO warning — nothing read or alerted on
 *   the balance. This module turns the balance read the actuator ALREADY performs at boot
 *   (`assertActuatorWalletAccount` consumes the same `/v1/wallets` response) into a periodic,
 *   structured observation Loki alerting can key on.
 * Scope: Pure classification + a bounded, swallow-all check runner. Reads no process env,
 *   opens no socket, starts no timer — the actuator composition root owns the interval and
 *   supplies the threshold (`AKASH_BALANCE_LOW_WATER`, USD major units).
 * Invariants:
 *   - ONE_CONSOLE_KEY_PER_ACCOUNT: this watch lives with the actuator — the one holder of the
 *     account's Console credential. The public app never gains a balance read from this.
 *   - NEVER_TAKES_THE_ACTUATOR_DOWN: a Console read failure is an `error` log line, never a
 *     throw — same doctrine as the stale-allocation sweeper.
 *   - HONEST_OR_SILENT_NEVER_WRONG: only USD-denominated wallets of the PINNED account count
 *     toward the threshold; when none are observable the emission says `unreadable` rather
 *     than pretending $0 or "ok".
 *   - STABLE_MARKERS: `akash_console_balance_low` is the alert key; `akash_console_balance_ok`
 *     and `akash_console_balance_unreadable` complete the state space so a dashboard can chart
 *     runway and a silent gap is itself a signal.
 * Side-effects: none (the injected `readBalances` performs the IO)
 * Links: ./akash-tx-wallet (`assertActuatorWalletAccount`),
 *   @adapters/server/compute/akash-compute.adapter (`balances()`),
 *   @bootstrap/akash-tx-actuator (wiring), story.5013, bug.5302
 * @internal
 */

import type { ComputeBalance } from "@cogni/ai-tools";

import type { AkashTxLogger } from "./akash-tx-actuator";

/**
 * Default low-water mark in USD. Sized to the observed burn shape: leases bill cents/hour and
 * the depletion incident took HOURS to kill the fleet from ~$0 — $10 leaves days, not minutes,
 * of human reaction time. Override per environment via `AKASH_BALANCE_LOW_WATER`.
 */
export const DEFAULT_AKASH_BALANCE_LOW_WATER_USD = 10;

/**
 * Parse `AKASH_BALANCE_LOW_WATER` (USD major units). Absent, non-numeric, non-finite or
 * non-positive values fall back to the default — a broken knob must degrade to a sane alarm,
 * never to no alarm.
 */
export function parseLowWaterUsd(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_AKASH_BALANCE_LOW_WATER_USD;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_AKASH_BALANCE_LOW_WATER_USD;
  }
  return value;
}

export type ConsoleBalanceStatus =
  | { readonly level: "low" | "ok"; readonly remainingUsd: number }
  /** No USD wallet observable for the pinned account — never coerced to $0 or "ok". */
  | { readonly level: "unreadable" };

/**
 * Classify the pinned account's USD runway against the low-water mark. Pure.
 *
 * Only wallets belonging to `expectedAccountId` AND denominated in USD participate: the
 * adapter labels non-USD denoms honestly (e.g. AKT), and mixing currencies into one number
 * would fabricate a runway figure the threshold cannot be honestly compared to.
 */
export function classifyConsoleBalance(
  balances: readonly ComputeBalance[],
  expectedAccountId: string,
  lowWaterUsd: number
): ConsoleBalanceStatus {
  const usdWallets = balances.filter(
    (wallet) =>
      wallet.accountId === expectedAccountId && wallet.currency === "USD"
  );
  if (usdWallets.length === 0) return { level: "unreadable" };
  const remainingUsd = usdWallets.reduce(
    (sum, wallet) => sum + wallet.remaining,
    0
  );
  return { level: remainingUsd < lowWaterUsd ? "low" : "ok", remainingUsd };
}

/** Emit exactly one structured line for an observation. WARN is the alertable severity. */
export function reportConsoleBalance(
  status: ConsoleBalanceStatus,
  context: {
    readonly expectedAccountId: string;
    readonly lowWaterUsd: number;
    readonly log: AkashTxLogger;
  }
): void {
  const fields = {
    accountId: context.expectedAccountId,
    lowWaterUsd: context.lowWaterUsd,
  };
  if (status.level === "unreadable") {
    context.log.warn(fields, "akash_console_balance_unreadable");
    return;
  }
  const withRemaining = { ...fields, remainingUsd: status.remainingUsd };
  if (status.level === "low") {
    context.log.warn(withRemaining, "akash_console_balance_low");
    return;
  }
  context.log.info(withRemaining, "akash_console_balance_ok");
}

/**
 * One bounded balance observation: read → classify → emit. NEVER throws — a Console outage
 * must not take the wallet writer down with it (sweeper doctrine); the next tick tries again.
 */
export async function checkConsoleBalance(params: {
  readonly readBalances: () => Promise<readonly ComputeBalance[]>;
  readonly expectedAccountId: string;
  readonly lowWaterUsd: number;
  readonly log: AkashTxLogger;
}): Promise<void> {
  let balances: readonly ComputeBalance[];
  try {
    balances = await params.readBalances();
  } catch (error) {
    params.log.error(
      {
        accountId: params.expectedAccountId,
        causeType: error instanceof Error ? error.name : "unknown",
        causeMessage: error instanceof Error ? error.message : "unknown cause",
      },
      "akash_console_balance_check_failed"
    );
    return;
  }
  reportConsoleBalance(
    classifyConsoleBalance(
      balances,
      params.expectedAccountId,
      params.lowWaterUsd
    ),
    params
  );
}
