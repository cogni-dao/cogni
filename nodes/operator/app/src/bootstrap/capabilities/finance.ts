// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/finance`
 * Purpose: Compose every plane in the hub money-plane-registry for this node: repo-spec wallets, OpenRouter, Cherry, Akash credit
 *   and per-node hosting (collapsed under one Akash row), Grafana overage, domain renewal, the planes with no billing read
 *   (Alchemy, system tenant, other SaaS), and income (credited purchases; node services planned). Every row carries its rail.
 * Scope: Runtime credentials and dependency wiring; no new financial authority.
 * Invariants: Read-only; credentials stay server-side; provider errors never reach the UI; a missing key is an UNKNOWN row, never a guess.
 * Side-effects: Existing compute cost read; readers perform bounded provider IO when run.
 * Links: https://cognidao.org/work/items/task.5347, https://cognidao.org/knowledge/money-plane-registry
 * @internal
 */
import {
  baseWalletReader,
  creditPurchaseIncomeReader,
  type FetchLike,
  type MoneyPlaneRow,
  openRouterReader,
  type PayAction,
  type PlaneReader,
  type Rail,
} from "@cogni/money-plane";

import {
  AKASH_PRODUCTION_OWNER,
  akashCreditReader,
  akashHostingReaders,
  cherryFinanceReader,
  creditedPurchasesQuery,
  domainExpiryReader,
  grafanaOverageReader,
  readAkashBlocksPerDay,
  readAkashReports,
  unavailableFinanceReader,
} from "@/adapters/server";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import {
  getDaoTreasuryAddress,
  getOperatorWalletConfig,
  getStewardWalletConfig,
} from "@/shared/config";
import { serverEnv } from "@/shared/env";

import { getContainer } from "../container";
import { uniqueWalletBindings } from "./finance-wallets";

/** Post-snapshot operator composition, re-exported so the app layer never imports adapters directly. */
export { collapseAkash } from "@/adapters/server";

const safeFetch: FetchLike = async (url, init) => {
  try {
    const response = await fetch(url, { ...init, cache: "no-store" });
    return {
      ok: response.ok,
      status: response.status,
      async json() {
        try {
          return await response.json();
        } catch {
          throw new Error("Provider response unreadable");
        }
      },
    };
  } catch {
    throw new Error("Provider read failed");
  }
};

/** No config helper exposes the public apex today; the registry row is Cloudflare/Namecheap for cognidao.org. */
const OPERATOR_PUBLIC_DOMAIN = "cognidao.org";
/** Human checkouts, paid from the steward wallet (hub guide fund-cogni-vendors). */
const OPENROUTER_CHECKOUT: PayAction = {
  kind: "steward-checkout",
  vendor: "openrouter",
  checkoutUrl: "https://openrouter.ai/settings/credits",
};
const CHERRY_CHECKOUT: PayAction = {
  kind: "steward-checkout",
  vendor: "cherry",
  checkoutUrl: "https://portal.cherryservers.com/",
};
/** Console billing is card-only and sign-in gated (hub akash-crypto-selfcustody-fiat). */
const AKASH_CONSOLE_TOP_UP: PayAction = {
  kind: "external",
  url: "https://console.akash.network/",
  label: "Top up",
};
const FUND_STEWARD: PayAction = { kind: "fund-steward" };
const MONEY_CHAIN =
  "User payments → operator wallet → steward wallet → vendors";
const STEWARD_RAIL: Rail = { kind: "steward-manual", status: "supported" };
const NO_RAIL: Rail = { kind: "none", status: "unsupported" };
const OTHER_SAAS_VENDORS = [
  "PostHog",
  "Langfuse",
  "Tavily",
  "GitHub",
  "DoltHub",
  "SonarCloud",
  "Privy",
] as const;

export interface FinanceReaders {
  treasuryPlane: string | null;
  readers: PlaneReader[];
}

export async function createFinanceReaders(): Promise<FinanceReaders> {
  const env = serverEnv();
  let container: ReturnType<typeof getContainer> | undefined;
  try {
    container = getContainer();
  } catch {
    /* Other providers must not hide readable wallet evidence. */
  }

  const stewardConfigured = Boolean(getStewardWalletConfig()?.address);
  const bindings = uniqueWalletBindings([
    {
      name: "dao-treasury",
      isTreasury: true,
      label: "DAO treasury",
      address: getDaoTreasuryAddress(),
      rail: { kind: "dao-vote", status: "planned", guide: "governance" },
    },
    {
      name: "operator-wallet",
      label: "Operator wallet",
      address: getOperatorWalletConfig()?.address,
      // The only write on the page; needs a configured steward destination (AMOUNT_ONLY).
      ...(stewardConfigured
        ? { payAction: FUND_STEWARD, rail: STEWARD_RAIL }
        : { rail: { kind: "steward-manual", status: "unsupported" } }),
      note: MONEY_CHAIN,
    },
    {
      name: "steward-wallet",
      label: "Steward wallet",
      address: getStewardWalletConfig()?.address,
      note: "Human-custodied; pays both vendors in USDC",
      rail: NO_RAIL,
    },
  ]);
  const treasury = bindings.find((binding) => binding.isTreasury);
  const wallets = bindings.map((binding): PlaneReader => {
    const reader = env.EVM_RPC_URL
      ? baseWalletReader({
          name: binding.name,
          label: binding.label,
          address: binding.address,
          rpcUrl: env.EVM_RPC_URL,
          fetch: safeFetch,
          ...(binding.payAction ? { payAction: binding.payAction } : {}),
        })
      : unavailableFinanceReader(
          `base:${binding.name}`,
          binding.label,
          "wallet",
          "RPC unavailable",
          "unreadable",
          undefined,
          binding.payAction
        );
    const extras = {
      ...(binding.note ? { note: binding.note } : {}),
      ...(binding.rail ? { rail: binding.rail } : {}),
    };
    if (Object.keys(extras).length === 0) return reader;
    return {
      ...reader,
      read: async (signal) => ({ ...(await reader.read(signal)), ...extras }),
    };
  });

  const openRouterBase = openRouterReader({
    apiKey: env.OPENROUTER_API_KEY,
    fetch: safeFetch,
    label: "OpenRouter credit",
    payAction: OPENROUTER_CHECKOUT,
  });
  const openRouter: PlaneReader = {
    ...openRouterBase,
    read: async (signal) => ({
      ...(await openRouterBase.read(signal)),
      rail: STEWARD_RAIL,
    }),
  };
  const cherry = cherryFinanceReader({
    token: env.CHERRY_AUTH_TOKEN,
    fetch: safeFetch,
    payAction: CHERRY_CHECKOUT,
  });
  const spend = container?.akashSpendReader;
  const [reports, blocksPerDay] = await Promise.all([
    readAkashReports(spend ? () => spend.reportByNode() : undefined),
    readAkashBlocksPerDay(safeFetch),
  ]);
  const akashCredit = akashCreditReader({
    owner: env.AKASH_ACTUATOR_ACCOUNT_ID?.trim() || AKASH_PRODUCTION_OWNER,
    fetch: safeFetch,
    blocksPerDay,
    payAction: AKASH_CONSOLE_TOP_UP,
  });
  const akash = akashHostingReaders(
    reports,
    new Date().toISOString(),
    blocksPerDay
  );
  const grafana = grafanaOverageReader({
    url: env.GRAFANA_URL,
    token: env.GRAFANA_SERVICE_ACCOUNT_TOKEN,
    fetch: safeFetch,
  });
  const domain = domainExpiryReader({
    domain: OPERATOR_PUBLIC_DOMAIN,
    fetch: safeFetch,
  });
  const at = new Date().toISOString();
  const saasChild = (vendor: string): MoneyPlaneRow => ({
    plane: `saas:${vendor.toLowerCase()}`,
    label: vendor,
    kind: "fixed",
    balance: null,
    currency: null,
    burnPerDay: null,
    runwayDays: null,
    grade: "UNKNOWN",
    reasonCode: "unconfigured",
    observedAt: at,
    sourceObservedAt: null,
    freshness: "unknown",
    detail: "no billing read",
    payer: "Operator",
    rail: NO_RAIL,
  });
  const unread = [
    unavailableFinanceReader(
      "rpc:alchemy",
      "Alchemy RPC",
      "usage",
      "no billing-scoped credential",
      "unconfigured",
      "Operator",
      undefined,
      undefined,
      { rail: NO_RAIL }
    ),
    unavailableFinanceReader(
      "tenant:system",
      "System tenant",
      "prepaid",
      "no read wired; balance lives in the operator DB",
      "unconfigured",
      "Operator",
      undefined,
      undefined,
      { rail: NO_RAIL }
    ),
    unavailableFinanceReader(
      "saas:other",
      "Other SaaS",
      "fixed",
      "no billing read; declared costs not yet in repo-spec",
      "unconfigured",
      "Operator",
      undefined,
      OTHER_SAAS_VENDORS.join(", "),
      { rail: NO_RAIL, children: OTHER_SAAS_VENDORS.map(saasChild) }
    ),
  ];

  // Income: credited purchases from this node's own ledger; node services stay planned (x402).
  let purchases: PlaneReader;
  try {
    purchases = creditPurchaseIncomeReader({
      query: creditedPurchasesQuery(getServiceDb()),
    });
  } catch {
    purchases = unavailableFinanceReader(
      "income:credit-purchases",
      "Credit purchases",
      "income",
      "ledger unavailable",
      "unreadable",
      undefined,
      undefined,
      undefined,
      { rail: { kind: "split-inflow", status: "supported" } }
    );
  }
  const nodeServices = unavailableFinanceReader(
    "income:node-services",
    "Node services",
    "income",
    "no USDC service income yet",
    "unconfigured",
    undefined,
    undefined,
    undefined,
    {
      rail: {
        kind: "x402-auto",
        status: "planned",
        guide: "node-service-usdc-northstar",
      },
    }
  );

  return {
    treasuryPlane: treasury ? `base:${treasury.name}` : null,
    readers: [
      purchases,
      nodeServices,
      ...wallets,
      openRouter,
      cherry,
      akashCredit,
      ...akash,
      grafana,
      domain,
      ...unread,
    ],
  };
}
