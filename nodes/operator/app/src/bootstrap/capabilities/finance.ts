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
  type PayAction,
  type PlaneReader,
  type Rail,
} from "@cogni/money-plane";

import {
  AKASH_PRODUCTION_OWNER,
  akashCreditReader,
  akashHostingReaders,
  cherryFinanceReader,
  domainExpiryReader,
  grafanaOverageReader,
  readAkashBlocksPerDay,
  readAkashReports,
  unavailableFinanceReader,
} from "@/adapters/server";
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

/** Budget for the Akash cadence probe that runs before the snapshot; a hung LCD falls back to 5.884 s/block. */
export const CADENCE_TIMEOUT_MS = 3000;

export interface FinanceReaders {
  treasuryPlane: string | null;
  readers: PlaneReader[];
  /** Explorer page of the steward wallet, for the "result unknown" check after a withdrawal. */
  stewardWalletUrl: string | null;
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

  // OpenRouter account-wide /credits needs a MANAGEMENT key, which is WRITE-capable
  // (it mints and revokes API keys). OpenRouter ships NO read-only credential for
  // /credits, so there is no key we can safely place in the app pod
  // (identity-keys-no-overload, guard-needs-proven-writer). The row stays honestly
  // UNKNOWN until the out-of-band read lands (task.5361): a trusted scheduled job
  // holds the management key, reads /credits, and writes the balance to a store the
  // app reads — the write key never enters the app pod. Top up stays reachable.
  const openRouter = unavailableFinanceReader(
    "openrouter:account",
    "OpenRouter credit",
    "prepaid",
    "needs an out-of-band scoped read · task.5361",
    "unconfigured",
    undefined,
    OPENROUTER_CHECKOUT,
    undefined,
    { rail: STEWARD_RAIL }
  );
  // Cherry billing read uses a SEPARATE report-only token, never the provisioning
  // write token CHERRY_AUTH_TOKEN (task.5382, identity-keys-no-overload). Cherry has
  // no read-only key scope (all keys are account-wide full-access), so this is a
  // distinct key for blast-radius isolation, not a scope-limited read.
  const cherry = cherryFinanceReader({
    token: env.CHERRY_REPORT_TOKEN,
    teamId: env.CHERRY_TEAM_ID,
    fetch: safeFetch,
    payAction: CHERRY_CHECKOUT,
  });
  const spend = container?.akashSpendReader;
  const [reports, blocksPerDay] = await Promise.all([
    readAkashReports(spend ? () => spend.reportByNode() : undefined),
    readAkashBlocksPerDay(
      safeFetch,
      undefined,
      AbortSignal.timeout(CADENCE_TIMEOUT_MS)
    ),
  ]);
  const akashCredit = akashCreditReader({
    // Public Console funding identity, independently verified for this managed account.
    expectedGranter: "akash17f8kfdvzaamk6gapy6tsrf8sg4cdd0296kkhnz",
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
    // The BYPASSRLS income query is wired in the DI container (the only
    // approved importer of the service-db adapter); never read it here.
    const query = container?.creditedPurchasesQuery;
    if (!query) throw new Error("credited-purchases query unavailable");
    purchases = creditPurchaseIncomeReader({ query });
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

  const stewardAddress = getStewardWalletConfig()?.address;
  return {
    treasuryPlane: treasury ? `base:${treasury.name}` : null,
    stewardWalletUrl: stewardAddress
      ? `https://basescan.org/address/${stewardAddress}`
      : null,
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
