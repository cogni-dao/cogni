// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-balance-watch.test`
 * Purpose: Prove the low-water balance alarm (story.5013, bug.5302) is honest — the USD
 *   runway of the PINNED account alone decides low/ok, an unobservable balance says so
 *   instead of pretending, a broken threshold knob degrades to the default alarm rather than
 *   to no alarm, and a Console read failure is a log line, never a throw.
 * Scope: Pure unit tests. No env, no IO, no timers.
 * Side-effects: none
 * Links: ./akash-balance-watch, story.5013, bug.5302
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  checkConsoleBalance,
  classifyConsoleBalance,
  DEFAULT_AKASH_BALANCE_LOW_WATER_USD,
  parseLowWaterUsd,
  reportConsoleBalance,
} from "./akash-balance-watch";
import type { AkashTxLogger } from "./akash-tx-actuator";

const ACCOUNT = "akash1operatorsponsorwalletaddress";
const OTHER_ACCOUNT = "akash1someotherwalletaddress";

function balance(
  overrides: Partial<{
    accountId: string;
    currency: string;
    remaining: number;
  }> = {}
) {
  return {
    provider: "akash",
    accountId: ACCOUNT,
    currency: "USD",
    remaining: 25,
    asOf: "2026-09-29T00:00:00.000Z",
    estimatedDaysRemaining: null,
    ...overrides,
  };
}

function capturingLog(): AkashTxLogger & {
  lines: { level: string; fields: Record<string, unknown>; message: string }[];
} {
  const lines: {
    level: string;
    fields: Record<string, unknown>;
    message: string;
  }[] = [];
  return {
    lines,
    info: (fields, message) => lines.push({ level: "info", fields, message }),
    warn: (fields, message) => lines.push({ level: "warn", fields, message }),
    error: (fields, message) => lines.push({ level: "error", fields, message }),
  };
}

describe("parseLowWaterUsd", () => {
  it("parses a positive USD threshold", () => {
    expect(parseLowWaterUsd("42.5")).toBe(42.5);
  });

  it.each([
    undefined,
    "",
    "  ",
    "not-a-number",
    "0",
    "-3",
    "Infinity",
    "NaN",
  ])("falls back to the default for %j — a broken knob must not disable the alarm", (raw) => {
    expect(parseLowWaterUsd(raw)).toBe(DEFAULT_AKASH_BALANCE_LOW_WATER_USD);
  });
});

describe("classifyConsoleBalance", () => {
  it("is low when the pinned account's USD runway is under the mark", () => {
    expect(
      classifyConsoleBalance([balance({ remaining: 3 })], ACCOUNT, 10)
    ).toEqual({ level: "low", remainingUsd: 3 });
  });

  it("is ok at or above the mark", () => {
    expect(
      classifyConsoleBalance([balance({ remaining: 10 })], ACCOUNT, 10)
    ).toEqual({ level: "ok", remainingUsd: 10 });
  });

  it("sums multiple USD wallets of the pinned account", () => {
    expect(
      classifyConsoleBalance(
        [balance({ remaining: 4 }), balance({ remaining: 5 })],
        ACCOUNT,
        10
      )
    ).toEqual({ level: "low", remainingUsd: 9 });
  });

  it("ignores other accounts and non-USD denoms — never fabricates runway", () => {
    expect(
      classifyConsoleBalance(
        [
          balance({ accountId: OTHER_ACCOUNT, remaining: 1_000 }),
          balance({ currency: "AKT", remaining: 1_000 }),
          balance({ remaining: 2 }),
        ],
        ACCOUNT,
        10
      )
    ).toEqual({ level: "low", remainingUsd: 2 });
  });

  it("is unreadable when the pinned account has no USD wallet — never $0, never ok", () => {
    expect(
      classifyConsoleBalance(
        [balance({ accountId: OTHER_ACCOUNT }), balance({ currency: "AKT" })],
        ACCOUNT,
        10
      )
    ).toEqual({ level: "unreadable" });
    expect(classifyConsoleBalance([], ACCOUNT, 10)).toEqual({
      level: "unreadable",
    });
  });
});

describe("reportConsoleBalance", () => {
  it("emits the alertable WARN marker akash_console_balance_low", () => {
    const log = capturingLog();
    reportConsoleBalance(
      { level: "low", remainingUsd: 1.25 },
      { expectedAccountId: ACCOUNT, lowWaterUsd: 10, log }
    );
    expect(log.lines).toEqual([
      {
        level: "warn",
        fields: { accountId: ACCOUNT, lowWaterUsd: 10, remainingUsd: 1.25 },
        message: "akash_console_balance_low",
      },
    ]);
  });

  it("emits ok at info so runway is chartable without alerting", () => {
    const log = capturingLog();
    reportConsoleBalance(
      { level: "ok", remainingUsd: 50 },
      { expectedAccountId: ACCOUNT, lowWaterUsd: 10, log }
    );
    expect(log.lines).toEqual([
      {
        level: "info",
        fields: { accountId: ACCOUNT, lowWaterUsd: 10, remainingUsd: 50 },
        message: "akash_console_balance_ok",
      },
    ]);
  });

  it("emits unreadable at warn — a balance nobody can see is itself alarming", () => {
    const log = capturingLog();
    reportConsoleBalance(
      { level: "unreadable" },
      { expectedAccountId: ACCOUNT, lowWaterUsd: 10, log }
    );
    expect(log.lines).toEqual([
      {
        level: "warn",
        fields: { accountId: ACCOUNT, lowWaterUsd: 10 },
        message: "akash_console_balance_unreadable",
      },
    ]);
  });
});

describe("checkConsoleBalance", () => {
  it("reads, classifies and emits one line", async () => {
    const log = capturingLog();
    await checkConsoleBalance({
      readBalances: vi.fn().mockResolvedValue([balance({ remaining: 0.4 })]),
      expectedAccountId: ACCOUNT,
      lowWaterUsd: 10,
      log,
    });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]?.message).toBe("akash_console_balance_low");
  });

  it("NEVER throws on a Console read failure — it logs and yields to the next tick", async () => {
    const log = capturingLog();
    await expect(
      checkConsoleBalance({
        readBalances: vi.fn().mockRejectedValue(new Error("HTTP 503")),
        expectedAccountId: ACCOUNT,
        lowWaterUsd: 10,
        log,
      })
    ).resolves.toBeUndefined();
    expect(log.lines).toEqual([
      {
        level: "error",
        fields: {
          accountId: ACCOUNT,
          causeType: "Error",
          causeMessage: "HTTP 503",
        },
        message: "akash_console_balance_check_failed",
      },
    ]);
  });
});
