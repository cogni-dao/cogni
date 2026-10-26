// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/dev/finance-preview/fixture`
 * Purpose: Explicitly synthetic data for the development-only finance preview, shaped like the live operator read.
 * Scope: Static fixture; never imports a live reader.
 * Invariants: Not a statement of actual balances or costs.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import type { MoneyPlaneRow } from "@cogni/money-plane";

import type { FinanceReportModel } from "@/features/finance/types";

const now = "2026-10-26T13:40:00.000Z";
export const previewTreasuryAddress =
  "0x1111111111111111111111111111111111111111";

function wallet(
  name: string,
  label: string,
  usdc: number,
  eth: string
): MoneyPlaneRow {
  return {
    plane: `base:${name}`,
    label,
    kind: "wallet",
    balance: usdc,
    currency: "USDC",
    burnPerDay: null,
    runwayDays: null,
    grade: "INFO",
    observedAt: now,
    source: "Base JSON-RPC",
    sourceObservedAt: now,
    freshness: "current",
    detail: `${eth} ETH`,
  };
}

function walletUnreadable(name: string, label: string): MoneyPlaneRow {
  return {
    plane: `base:${name}`,
    label,
    kind: "wallet",
    balance: null,
    currency: null,
    burnPerDay: null,
    runwayDays: null,
    grade: "UNKNOWN",
    reasonCode: "unreadable",
    observedAt: now,
    sourceObservedAt: null,
    freshness: "unknown",
    detail: "eth_call HTTP 503",
  };
}

/** $/day → the exact uact/block the chain would quote (1e6 uact per USD credit, 5.884 s/block). */
function akash(
  nodeId: string,
  usdPerDay: number,
  transferredUact?: string
): MoneyPlaneRow {
  const perBlock = ((usdPerDay * 1e6 * 5.884) / 86_400).toFixed(2);
  return {
    plane: `akash:${nodeId}`,
    label: `Akash hosting · ${nodeId}`,
    kind: "usage",
    balance: null,
    currency: "USD",
    burnPerDay: usdPerDay,
    runwayDays: null,
    grade: "INFO",
    observedAt: now,
    source: "On-chain lease price · 5.884 s/block",
    sourceObservedAt: null,
    freshness: "unknown",
    payer: "Operator",
    beneficiary: nodeId,
    coverage: "operator-covered",
    nativeRate: { amount: perBlock, currency: "uact", per: "block" },
    ...(transferredUact
      ? {
          cumulativeVendorTransfer: {
            amount: transferredUact,
            currency: "uact",
          },
        }
      : {}),
  };
}

export const liveShapedFinancePreview: FinanceReportModel = {
  takenAt: now,
  worst: "UNKNOWN",
  treasuryPlane: "base:dao-treasury",
  rows: [
    wallet("dao-treasury", "DAO treasury", 74.52, "0.0031"),
    wallet(
      "operator-wallet",
      "Operator wallet · working capital",
      10.77,
      "0.0008"
    ),
    wallet("steward-wallet", "Steward wallet · human custody", 7.07, "0.0012"),
    {
      plane: "openrouter:account",
      label: "OpenRouter credit",
      kind: "prepaid",
      balance: 3.1,
      currency: "USD",
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      reasonCode: "burn_unmeasured",
      observedAt: now,
      source: "OpenRouter credits API",
      sourceObservedAt: now,
      freshness: "current",
      usageTotal: 96.9,
    },
    {
      plane: "cherry:account",
      label: "Cherry compute credit",
      kind: "prepaid",
      balance: 12.4,
      currency: "EUR",
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      reasonCode: "burn_unmeasured",
      observedAt: now,
      source: "Cherry team balance",
      sourceObservedAt: now,
      freshness: "current",
    },
    akash("poly", 1.57, "4210000"),
    akash("red", 0.64),
    akash("toks5", 0.35),
    akash("levelup", 0.19),
    akash("beacon", 0.19),
    akash("node-template", 0.19),
  ],
};

export const sparseFinancePreview: FinanceReportModel = {
  takenAt: now,
  worst: "UNKNOWN",
  treasuryPlane: "base:dao-treasury",
  rows: [
    walletUnreadable("dao-treasury", "DAO treasury"),
    walletUnreadable("operator-wallet", "Operator wallet · working capital"),
    walletUnreadable("steward-wallet", "Steward wallet · human custody"),
    {
      plane: "openrouter:account",
      label: "OpenRouter credit",
      kind: "prepaid",
      balance: null,
      currency: null,
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
      observedAt: now,
      sourceObservedAt: null,
      freshness: "unknown",
      detail: "no OpenRouter key in this environment",
    },
    {
      plane: "cherry:account",
      label: "Cherry compute credit",
      kind: "prepaid",
      balance: null,
      currency: null,
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
      observedAt: now,
      sourceObservedAt: null,
      freshness: "unknown",
      detail: "no Cherry balance reported",
    },
    {
      plane: "akash:fleet",
      label: "Akash hosting",
      kind: "usage",
      balance: null,
      currency: null,
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      observedAt: now,
      sourceObservedAt: null,
      freshness: "unknown",
      detail: "cost ledger unavailable",
    },
  ],
};
