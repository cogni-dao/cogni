// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/finance`
 * Purpose: Compose every plane in the hub money-plane-registry for this node: repo-spec wallets, OpenRouter, Cherry, Akash credit
 *   and per-node hosting, Grafana overage, domain renewal, and the planes with no billing read (Alchemy, system tenant, other SaaS).
 * Scope: Runtime credentials and dependency wiring; no new financial authority.
 * Invariants: Read-only; credentials stay server-side; provider errors never reach the UI; a missing key is an UNKNOWN row, never a guess.
 * Side-effects: Existing compute cost read; readers perform bounded provider IO when run.
 * Links: https://cognidao.org/work/items/task.5347, https://cognidao.org/knowledge/money-plane-registry
 * @internal
 */
import {
  baseWalletReader,
  type FetchLike,
  openRouterReader,
  type PlaneReader,
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

/** Post-snapshot operator policy, re-exported so the app layer never imports adapters directly. */
export { restoreCostLineGrades } from "@/adapters/server";

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

  const bindings = uniqueWalletBindings([
    {
      name: "dao-treasury",
      isTreasury: true,
      label: "DAO treasury",
      address: getDaoTreasuryAddress(),
    },
    {
      name: "operator-wallet",
      label: "Operator wallet · working capital",
      address: getOperatorWalletConfig()?.address,
    },
    {
      name: "steward-wallet",
      label: "Steward wallet · human custody",
      address: getStewardWalletConfig()?.address,
    },
  ]);
  const treasury = bindings.find((binding) => binding.isTreasury);
  const wallets = bindings.map((binding) =>
    env.EVM_RPC_URL
      ? baseWalletReader({
          name: binding.name,
          label: binding.label,
          address: binding.address,
          rpcUrl: env.EVM_RPC_URL,
          fetch: safeFetch,
        })
      : unavailableFinanceReader(
          `base:${binding.name}`,
          binding.label,
          "wallet",
          "RPC unavailable",
          "unreadable"
        )
  );

  const openRouter = openRouterReader({
    apiKey: env.OPENROUTER_API_KEY,
    fetch: safeFetch,
    label: "OpenRouter credit",
  });
  const cherry = cherryFinanceReader({
    token: env.CHERRY_AUTH_TOKEN,
    fetch: safeFetch,
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
  const unread = [
    unavailableFinanceReader(
      "rpc:alchemy",
      "Base RPC (Alchemy)",
      "usage",
      "no billing-scoped credential",
      "unconfigured",
      "Operator"
    ),
    unavailableFinanceReader(
      "tenant:system",
      "System tenant · internal credits",
      "prepaid",
      "no read wired; balance lives in the operator DB",
      "unconfigured",
      "Operator"
    ),
    unavailableFinanceReader(
      "saas:other",
      "Other SaaS · PostHog, Langfuse, Tavily, GitHub, DoltHub, SonarCloud, Privy",
      "fixed",
      "no billing read; declared costs not yet in repo-spec",
      "unconfigured",
      "Operator"
    ),
  ];

  return {
    treasuryPlane: treasury ? `base:${treasury.name}` : null,
    readers: [
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
