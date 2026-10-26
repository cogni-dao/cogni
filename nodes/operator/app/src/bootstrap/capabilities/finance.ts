// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/finance`
 * Purpose: Compose this node's money-plane readers: repo-spec wallets, vendor credit it holds keys for, and the Akash fleet it pays for.
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
  akashHostingReaders,
  cherryCreditReader,
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
  const compute = container?.computeCapability;
  const cherry = cherryCreditReader(
    compute ? () => compute.balances() : undefined
  );
  const spend = container?.akashSpendReader;
  const akash = akashHostingReaders(
    await readAkashReports(spend ? () => spend.reportByNode() : undefined),
    new Date().toISOString()
  );

  return {
    treasuryPlane: treasury ? `base:${treasury.name}` : null,
    readers: [...wallets, openRouter, cherry, ...akash],
  };
}
