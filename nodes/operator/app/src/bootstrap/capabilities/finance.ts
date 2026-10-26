// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/finance`
 * Purpose: Compose shared finance readers with existing operator compute and funding sources.
 * Scope: Runtime credentials and dependency wiring; no new financial authority.
 * Invariants: Read-only; provider errors never enter UI; no fabricated burn or FX totals.
 * Side-effects: Existing compute cost read; readers perform bounded provider IO when run.
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import {
  baseWalletReader,
  type FetchLike,
  type PlaneReader,
} from "@cogni/money-plane";

import {
  computeCostReaders,
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

export async function createFinanceReaders() {
  const env = serverEnv();
  let container: ReturnType<typeof getContainer> | undefined;
  try {
    container = getContainer();
  } catch {
    /* Other providers must not hide readable wallet evidence. */
  }
  const spend = container?.akashSpendReader;
  const compute = await computeCostReaders(
    spend ? () => spend.reportByNode() : undefined
  );
  const wallet = (
    name: string,
    label: string,
    address: string | undefined,
    beneficiary: string,
    payer: string
  ): PlaneReader => {
    if (!env.EVM_RPC_URL)
      return unavailableFinanceReader(
        `base:${name}`,
        label,
        "wallet",
        "Wallet RPC unavailable"
      );
    const reader = baseWalletReader({
      name,
      label,
      address,
      rpcUrl: env.EVM_RPC_URL,
      fetch: safeFetch,
    });
    return {
      ...reader,
      async read(signal) {
        return {
          ...(await reader.read(signal)),
          payer,
          beneficiary,
          coverage: "unknown",
        };
      },
    };
  };
  const bindings = uniqueWalletBindings([
    {
      name: "dao-treasury",
      isTreasury: true,
      label: "DAO treasury",
      address: getDaoTreasuryAddress(),
      beneficiary: "DAO treasury",
      payer: "DAO",
    },
    {
      name: "operator-wallet",
      label: "Operator working capital",
      address: getOperatorWalletConfig()?.address,
      beneficiary: "Operator",
      payer: "Operator DAO",
    },
    {
      name: "steward-wallet",
      label: "Steward custody",
      address: getStewardWalletConfig()?.address,
      beneficiary: "Human-custodied wallet",
      payer: "Not established",
    },
  ]);
  const treasury = bindings.find((binding) => binding.isTreasury);
  return {
    treasuryPlane: treasury ? `base:${treasury.name}` : null,
    configuredWalletPlanes: bindings
      .filter((binding) => binding.configured)
      .map((binding) => `base:${binding.name}`),
    costRateEvidence: compute.costRateEvidence,
    readers: [
      ...bindings.map((binding) =>
        wallet(
          binding.name,
          binding.label,
          binding.address,
          binding.beneficiary,
          binding.payer
        )
      ),
      unavailableFinanceReader(
        "openrouter",
        "OpenRouter",
        "prepaid",
        "Balance unavailable; provider account scope and read-only access pending task.5361"
      ),
      unavailableFinanceReader(
        "cherry:account",
        "Cherry compute",
        "prepaid",
        "Balance unavailable; provider read-only access pending task.5361"
      ),
      ...compute.readers,
      unavailableFinanceReader(
        "ai:provider-usage",
        "AI provider usage",
        "usage",
        "Provider burn not yet available; user charges excluded"
      ),
      unavailableFinanceReader(
        "grafana:usage",
        "Grafana",
        "usage",
        "Usage cost not connected"
      ),
      unavailableFinanceReader(
        "github:subscription",
        "GitHub",
        "fixed",
        "Subscription amount not connected"
      ),
      unavailableFinanceReader(
        "domain:renewal",
        "Domain renewal",
        "fixed",
        "Renewal cost not connected"
      ),
    ],
  };
}
