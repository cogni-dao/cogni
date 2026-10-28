// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/dev/finance-preview/fixture`
 * Purpose: Explicitly synthetic data for the development-only finance preview, shaped like the live operator read.
 * Scope: Static fixture; never imports a live reader. Rows are projected to USD with a fixed ECB rate and summarized
 *   through the same package functions the page uses.
 * Invariants: Not a statement of actual balances or costs.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import {
  type MoneyPlaneRow,
  type Rail,
  summarize,
  toUsd,
  type UsdRate,
} from "@cogni/money-plane";

import type { FinanceReportModel } from "@/features/finance/types";

const now = "2026-10-26T13:40:00.000Z";
export const previewTreasuryAddress =
  "0x1111111111111111111111111111111111111111";
const RATE: UsdRate = {
  pair: "EURUSD",
  value: 1.1188,
  source: "ECB",
  date: "2026-10-26",
};
const STEWARD: Rail = { kind: "steward-manual", status: "supported" };
const NO_RAIL: Rail = { kind: "none", status: "unsupported" };
const CONSOLE: Rail = {
  kind: "card-manual",
  status: "planned",
  guide: "Console",
};
const AUTO_BILL: Rail = {
  kind: "card-manual",
  status: "planned",
  guide: "auto-bill",
};
const SPLIT: Rail = { kind: "split-inflow", status: "supported" };
const VENDORS = [
  "PostHog",
  "Langfuse",
  "Tavily",
  "GitHub",
  "DoltHub",
  "SonarCloud",
  "Privy",
];

function wallet(
  name: string,
  label: string,
  usdc: number,
  eth: string,
  extra: Partial<MoneyPlaneRow> = {}
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
    ...extra,
  };
}

type Overrides = { [K in keyof MoneyPlaneRow]?: MoneyPlaneRow[K] | undefined };
/** Spread overrides but drop explicit undefined so exactOptionalPropertyTypes holds. */
function withOverrides(base: MoneyPlaneRow, extra: Overrides): MoneyPlaneRow {
  const row: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete row[key];
    else row[key] = value;
  }
  return row as unknown as MoneyPlaneRow;
}

function placeholder(
  plane: string,
  label: string,
  kind: MoneyPlaneRow["kind"],
  detail: string,
  extra: Overrides = {}
): MoneyPlaneRow {
  return withOverrides(
    {
      plane,
      label,
      kind,
      balance: null,
      currency: null,
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
      observedAt: now,
      sourceObservedAt: null,
      freshness: "unknown",
      detail,
      payer: "Operator",
      rail: NO_RAIL,
    },
    extra
  );
}

/** $/day → the exact uact/block the chain would quote (1e6 uact per USD credit, 5.884 s/block). */
function akashNode(
  nodeId: string,
  usdPerDay: number,
  transferredUact?: string
): MoneyPlaneRow {
  const perBlock = ((usdPerDay * 1e6 * 5.884) / 86_400).toFixed(2);
  return {
    plane: `akash:${nodeId}`,
    label: `Akash · ${nodeId}`,
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

const AKASH_NODES = [
  akashNode("poly", 1.57, "4210000"),
  akashNode("red", 0.64),
  akashNode("toks5", 0.35),
  akashNode("levelup", 0.19),
  akashNode("beacon", 0.19),
  akashNode("node-template", 0.19),
];

/** Demo available credit ÷ fleet burn; reserved escrow stays separate in Source details. */
function akash(creditUsd: number, escrowUsd: number): MoneyPlaneRow {
  const balance = creditUsd;
  const burnPerDay = AKASH_NODES.reduce(
    (sum, n) => sum + (n.burnPerDay ?? 0),
    0
  );
  const runwayDays = balance / burnPerDay;
  return {
    plane: "akash:credit",
    label: "Akash credit",
    kind: "prepaid",
    balance,
    currency: "USD",
    burnPerDay,
    runwayDays,
    grade: runwayDays < 7 ? "RED" : runwayDays < 21 ? "YELLOW" : "GREEN",
    observedAt: now,
    source: "Available Console credit · escrow excluded · demo lease burn",
    sourceObservedAt: now,
    freshness: "current",
    payer: "Operator",
    rail: CONSOLE,
    payAction: {
      kind: "external",
      url: "https://console.akash.network/",
      label: "Top up",
    },
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
    detail:
      "Account top-up estimate, not shutdown time. Escrow is reserved by deployment; Console normally refills it.",
    children: AKASH_NODES,
  };
}

function grafanaChild(product: string, monthToDate: number): MoneyPlaneRow {
  return {
    plane: `grafana:overage:${product}`,
    label: `Grafana · ${product}`,
    kind: "usage",
    balance: null,
    currency: "USD",
    burnPerDay: monthToDate / 26,
    runwayDays: null,
    grade: "INFO",
    observedAt: now,
    source: "Grafana Cloud usage metrics · verify against invoice",
    sourceObservedAt: now,
    freshness: "current",
    payer: "Operator",
    detail: `${monthToDate.toFixed(2)} USD month to date`,
  };
}

function income(
  perDay: number,
  purchases: number,
  totalUsd: number
): MoneyPlaneRow {
  return {
    plane: "income:credit-purchases",
    label: "Credit purchases",
    kind: "income",
    balance: null,
    currency: "USD",
    burnPerDay: perDay,
    runwayDays: null,
    grade: "INFO",
    observedAt: now,
    source: "payment_events · CREDITED · trailing 30 days",
    sourceObservedAt: now,
    freshness: "current",
    detail: `${purchases} purchases · ${totalUsd.toFixed(2)} USD in 30d`,
    rail: SPLIT,
  };
}

const nodeServices = placeholder(
  "income:node-services",
  "Node services",
  "income",
  "no USDC service income yet",
  {
    payer: undefined,
    rail: {
      kind: "x402-auto",
      status: "planned",
      guide: "node-service-usdc-northstar",
    },
  }
);

/** OpenRouter /credits needs a management key; the inference key never reads it (task.5361). */
const openRouterUnknown = placeholder(
  "openrouter:account",
  "OpenRouter credit",
  "prepaid",
  "needs a management key · task.5361",
  {
    payer: undefined,
    rail: STEWARD,
    payAction: {
      kind: "steward-checkout",
      vendor: "openrouter",
      checkoutUrl: "https://openrouter.ai/settings/credits",
    },
  }
);

function liveRows(creditPurchases: MoneyPlaneRow): MoneyPlaneRow[] {
  return [
    creditPurchases,
    nodeServices,
    wallet("dao-treasury", "DAO treasury", 74.52, "0.0031", {
      rail: { kind: "dao-vote", status: "planned", guide: "governance" },
    }),
    wallet("operator-wallet", "Operator wallet", 10.77, "0.0008", {
      payAction: { kind: "fund-steward" },
      rail: STEWARD,
      note: "User payments → operator wallet → steward wallet → vendors",
    }),
    wallet("steward-wallet", "Steward wallet", 7.07, "0.0012", {
      note: "Human-custodied; pays both vendors in USDC",
      rail: NO_RAIL,
    }),
    openRouterUnknown,
    {
      plane: "cherry:team",
      label: "Cherry credit",
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
      rail: STEWARD,
      payAction: {
        kind: "steward-checkout",
        vendor: "cherry",
        checkoutUrl: "https://portal.cherryservers.com/",
      },
    },
    akash(5.79, 2.1),
    {
      plane: "grafana:overage",
      label: "Grafana overage",
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
      rail: AUTO_BILL,
      detail: "252.65 USD month to date · day 26",
      children: [
        grafanaChild("logs", 180.1),
        grafanaChild("metrics", 60.55),
        grafanaChild("traces", 12),
      ],
    },
    {
      plane: "domain:cognidao.org",
      label: "Domain cognidao.org",
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
      rail: { kind: "card-manual", status: "planned", guide: "registrar" },
      detail: "expires 2027-04-05",
    },
    placeholder(
      "rpc:alchemy",
      "Alchemy RPC",
      "usage",
      "no billing-scoped credential"
    ),
    placeholder(
      "tenant:system",
      "System tenant",
      "prepaid",
      "no read wired; balance lives in the operator DB"
    ),
    placeholder(
      "saas:other",
      "Other SaaS",
      "fixed",
      "no billing read; declared costs not yet in repo-spec",
      {
        beneficiary: VENDORS.join(", "),
        children: VENDORS.map((vendor) =>
          placeholder(
            `saas:${vendor.toLowerCase()}`,
            vendor,
            "fixed",
            "no billing read"
          )
        ),
      }
    ),
  ];
}

function model(
  rows: MoneyPlaneRow[],
  worst: MoneyPlaneRow["grade"]
): FinanceReportModel {
  const projected = rows.map((row) => toUsd(row, [RATE]));
  return {
    takenAt: now,
    worst,
    treasuryPlane: "base:dao-treasury",
    rows: projected,
    summary: summarize(
      { rows: projected },
      { treasuryPlane: "base:dao-treasury" }
    ),
    stewardWalletUrl:
      "https://basescan.org/address/0x3333333333333333333333333333333333333333",
  };
}

export const liveShapedFinancePreview = model(liveRows(income(0, 0, 0)), "RED");
/** Three purchases totalling $45 in the trailing 30 days → $1.50/day. */
export const withIncomeFinancePreview = model(
  liveRows(income(1.5, 3, 45)),
  "RED"
);

export const sparseFinancePreview: FinanceReportModel = {
  takenAt: now,
  worst: "UNKNOWN",
  treasuryPlane: "base:dao-treasury",
  summary: summarize({ rows: [] }),
  stewardWalletUrl:
    "https://basescan.org/address/0x3333333333333333333333333333333333333333",
  rows: [
    placeholder(
      "income:credit-purchases",
      "Credit purchases",
      "income",
      "ledger unavailable",
      {
        payer: undefined,
        reasonCode: "unreadable",
        rail: SPLIT,
      }
    ),
    nodeServices,
    ...(
      [
        [
          "dao-treasury",
          "DAO treasury",
          {
            rail: { kind: "dao-vote", status: "planned", guide: "governance" },
          },
        ],
        [
          "operator-wallet",
          "Operator wallet",
          {
            payAction: { kind: "fund-steward" },
            rail: STEWARD,
            note: "User payments → operator wallet → steward wallet → vendors",
          },
        ],
        ["steward-wallet", "Steward wallet", { rail: NO_RAIL }],
      ] satisfies readonly (readonly [string, string, Overrides])[]
    ).map(([name, label, extra]) =>
      withOverrides(
        {
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
        },
        extra
      )
    ),
    openRouterUnknown,
    placeholder(
      "cherry:team",
      "Cherry credit",
      "prepaid",
      "no Cherry credential in this runtime",
      {
        payer: undefined,
        rail: STEWARD,
        payAction: {
          kind: "steward-checkout",
          vendor: "cherry",
          checkoutUrl: "https://portal.cherryservers.com/",
        },
      }
    ),
    placeholder(
      "akash:credit",
      "Akash credit",
      "prepaid",
      "Akash chain read failed",
      {
        reasonCode: "unreadable",
        rail: CONSOLE,
        payAction: {
          kind: "external",
          url: "https://console.akash.network/",
          label: "Top up",
        },
        children: [
          placeholder(
            "akash:fleet",
            "Akash · fleet",
            "usage",
            "cost ledger unavailable",
            { reasonCode: "unreadable", rail: undefined }
          ),
        ],
      }
    ),
    placeholder(
      "grafana:overage",
      "Grafana overage",
      "usage",
      "no Grafana credential",
      { rail: AUTO_BILL }
    ),
    placeholder(
      "domain:cognidao.org",
      "Domain cognidao.org",
      "expiry",
      "registry read failed",
      {
        reasonCode: "unreadable",
        rail: { kind: "card-manual", status: "planned", guide: "registrar" },
      }
    ),
    placeholder(
      "rpc:alchemy",
      "Alchemy RPC",
      "usage",
      "no billing-scoped credential"
    ),
    placeholder(
      "tenant:system",
      "System tenant",
      "prepaid",
      "no read wired; balance lives in the operator DB"
    ),
    placeholder(
      "saas:other",
      "Other SaaS",
      "fixed",
      "no billing read; declared costs not yet in repo-spec",
      {
        beneficiary: VENDORS.join(", "),
        children: VENDORS.map((vendor) =>
          placeholder(
            `saas:${vendor.toLowerCase()}`,
            vendor,
            "fixed",
            "no billing read"
          )
        ),
      }
    ),
  ],
};
