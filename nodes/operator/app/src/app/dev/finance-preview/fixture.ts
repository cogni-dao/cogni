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

import type { AiFunding } from "@/app/(admin)/admin/payments/funding.server";
import type { FinanceReportModel, FinanceRow } from "@/features/finance/types";

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

function placeholder(
  plane: string,
  label: string,
  kind: MoneyPlaneRow["kind"],
  detail: string,
  reasonCode: MoneyPlaneRow["reasonCode"] = "unconfigured"
): FinanceRow {
  return {
    plane,
    label,
    kind,
    balance: null,
    currency: null,
    burnPerDay: null,
    runwayDays: null,
    grade: "UNKNOWN",
    reasonCode,
    observedAt: now,
    sourceObservedAt: null,
    freshness: "unknown",
    detail,
    payer: "Operator",
  };
}

/** Console credit + escrow ÷ fleet burn; the one row with a real runway on the operator today. */
function akashCredit(
  creditUsd: number,
  escrowUsd: number,
  burnPerDay: number
): FinanceRow {
  const balance = creditUsd + escrowUsd;
  const runwayDays = balance / burnPerDay;
  return {
    plane: "akash:credit",
    label: "Akash credit · fleet",
    kind: "prepaid",
    balance,
    currency: "USD",
    burnPerDay,
    runwayDays,
    grade: runwayDays < 7 ? "RED" : runwayDays < 21 ? "YELLOW" : "GREEN",
    observedAt: now,
    source:
      "Akash chain · Console grant + escrow · burn from lease prices at 5.884 s/block",
    sourceObservedAt: now,
    freshness: "current",
    payer: "Operator",
    rollup: true,
    parts: [
      {
        label: "Console credit",
        amount: String(Math.round(creditUsd * 1e6)),
        currency: "uact",
      },
      {
        label: "Escrow",
        amount: String(Math.round(escrowUsd * 1e6)),
        currency: "uact",
      },
    ],
  };
}

export const previewFunding: AiFunding = {
  openRouterRemainingUsd: 3.1,
  cherryRemaining: 12.4,
  cherryCurrency: "EUR",
  operatorWalletUsdc: 10.77,
  stewardWalletUsdc: 7.07,
  operatorWalletAddress: "0x2222222222222222222222222222222222222222",
  stewardWalletAddress: "0x3333333333333333333333333333333333333333",
};

export const liveShapedFinancePreview: FinanceReportModel = {
  takenAt: now,
  worst: "RED",
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
      plane: "cherry:team",
      label: "Cherry compute credit",
      kind: "prepaid",
      balance: 12.4,
      currency: "EUR",
      burnPerDay: 0.0143 * 24,
      runwayDays: 36,
      grade: "GREEN",
      observedAt: now,
      source: "Cherry team API · price per hour × 24 · vendor remaining time",
      sourceObservedAt: now,
      freshness: "current",
    },
    akashCredit(5.79, 2.1, 3.13),
    akash("poly", 1.57, "4210000"),
    {
      plane: "grafana:overage",
      label: "Grafana Cloud · overage this month",
      kind: "usage",
      balance: null,
      currency: "USD",
      burnPerDay: 252.65 / 26,
      runwayDays: null,
      grade: "INFO",
      observedAt: now,
      source: "Grafana Cloud usage metrics · verify against invoice",
      sourceObservedAt: now,
      freshness: "current",
      payer: "Operator",
      detail: "252.65 USD month to date · day 26",
      parts: [
        { label: "logs", amount: "180.1", currency: "USD" },
        { label: "metrics", amount: "60.55", currency: "USD" },
        { label: "traces", amount: "12", currency: "USD" },
      ],
    },
    {
      plane: "domain:cognidao.org",
      label: "Domain renewal · cognidao.org",
      kind: "expiry",
      balance: null,
      currency: null,
      burnPerDay: null,
      runwayDays: 161,
      grade: "GREEN",
      observedAt: now,
      source: "RDAP registry record",
      sourceObservedAt: now,
      freshness: "current",
      payer: "Operator",
      detail: "expires 2027-04-05",
    },
    placeholder(
      "rpc:alchemy",
      "Base RPC (Alchemy)",
      "usage",
      "no billing-scoped credential"
    ),
    placeholder(
      "tenant:system",
      "System tenant · internal credits",
      "prepaid",
      "no read wired; balance lives in the operator DB"
    ),
    placeholder(
      "saas:other",
      "Other SaaS · PostHog, Langfuse, Tavily, GitHub, DoltHub, SonarCloud, Privy",
      "fixed",
      "no billing read; declared costs not yet in repo-spec"
    ),
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
    placeholder(
      "cherry:team",
      "Cherry compute credit",
      "prepaid",
      "no Cherry credential in this runtime"
    ),
    {
      plane: "akash:credit",
      label: "Akash credit · fleet",
      kind: "prepaid",
      balance: null,
      currency: null,
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      observedAt: now,
      sourceObservedAt: null,
      freshness: "unknown",
      detail: "Akash chain read failed",
      payer: "Operator",
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
    placeholder(
      "grafana:overage",
      "Grafana Cloud · overage this month",
      "usage",
      "no Grafana credential"
    ),
    placeholder(
      "domain:cognidao.org",
      "Domain renewal · cognidao.org",
      "expiry",
      "registry read failed",
      "unreadable"
    ),
    placeholder(
      "rpc:alchemy",
      "Base RPC (Alchemy)",
      "usage",
      "no billing-scoped credential"
    ),
    placeholder(
      "tenant:system",
      "System tenant · internal credits",
      "prepaid",
      "no read wired; balance lives in the operator DB"
    ),
    placeholder(
      "saas:other",
      "Other SaaS · PostHog, Langfuse, Tavily, GitHub, DoltHub, SonarCloud, Privy",
      "fixed",
      "no billing read; declared costs not yet in repo-spec"
    ),
  ],
};
