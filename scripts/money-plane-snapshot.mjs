#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/money-plane-snapshot`
 * Purpose: One read of every chain-readable Cogni money plane — Akash Console credit (grant) + escrow + burn → runway days, and Base USDC/ETH wallets — graded against a runway policy.
 * Scope: Read-only public Akash LCD + Base RPC reads; Cherry and OpenRouter balances only when CHERRY_AUTH_TOKEN / OPENROUTER_API_KEY are in env. Does not store a credential, move funds, or file work items.
 * Invariants: RUNWAY_IS_GRANT_PLUS_ESCROW (Console credit lives on-chain as the DepositAuthorization spend_limit, not the owner bank balance) ; MISSING_IS_UNKNOWN (an unreadable plane is never GREEN)
 * Side-effects: IO
 * Notes: Akash also reports the thinnest deployment escrow; pooled runway holds only while Console refills escrow.
 * Links: https://cognidao.org/knowledge/finances-expert, story.5068, infra/secrets-catalog.yaml (AKASH_ACTUATOR_ACCOUNT_ID pins), .cogni/repo-spec.yaml
 * @public
 *
 * Usage:
 *   node scripts/money-plane-snapshot.mjs [--json]
 * Exit code: 0 all GREEN · 1 worst YELLOW · 2 any RED or UNKNOWN.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LCD = process.env.AKASH_LCD_URL ?? "https://api.akashnet.net";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Runway policy (story.5068): warn under 21 days, page under 7. */
export const RUNWAY_DAYS = { yellow: 21, red: 7 };

/** Akash Console accounts pinned per env in infra/secrets-catalog.yaml (AKASH_ACTUATOR_ACCOUNT_ID). */
export const AKASH_ACCOUNTS = {
  production: "akash10auj6u6wr7aqjawuxurgue9w7wfnca50t8cr4l",
  "candidate-a": "akash12eh8xgpeyumar3sk6wp94y0tq9uh62mkezxjmt",
};

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

/** Base wallets named in repo-spec; DAO treasury holds governance funds, steward pays vendors. */
export function baseWallets() {
  const spec = readFileSync(resolve(ROOT, ".cogni/repo-spec.yaml"), "utf8");
  const pick = (re) => spec.match(re)?.[1] ?? null;
  return {
    "operator-wallet": pick(
      /operator_wallet:\s*\n\s*address:\s*"(0x[0-9a-fA-F]{40})"/
    ),
    "steward-wallet": pick(
      /steward_wallet:\s*\n\s*address:\s*"(0x[0-9a-fA-F]{40})"/
    ),
    "dao-treasury": pick(/dao_contract:\s*"(0x[0-9a-fA-F]{40})"/),
  };
}

async function getJson(url, init) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${new URL(url).host}`);
  return res.json();
}

const sum = (coins = [], denom = "uact") =>
  coins
    .filter((c) => c.denom === denom)
    .reduce((a, c) => a + Number(c.amount), 0);

async function blocksPerDay() {
  const tip = await getJson(
    `${LCD}/cosmos/base/tendermint/v1beta1/blocks/latest`
  );
  const h = Number(tip.block.header.height);
  const back = await getJson(
    `${LCD}/cosmos/base/tendermint/v1beta1/blocks/${h - 10_000}`
  );
  const secs =
    (Date.parse(tip.block.header.time) - Date.parse(back.block.header.time)) /
    1000;
  return (86_400 * 10_000) / secs;
}

/** Console credit = remaining DepositAuthorization spend_limit granted by Console's master wallet. */
export async function akashPlane(env, owner, bpd) {
  const q = `filters.owner=${owner}&filters.state=active&pagination.limit=500`;
  const [grants, deps, leases] = await Promise.all([
    getJson(`${LCD}/cosmos/authz/v1beta1/grants/grantee/${owner}`),
    getJson(`${LCD}/akash/deployment/v1beta4/deployments/list?${q}`),
    getJson(`${LCD}/akash/market/v1beta5/leases/list?${q}`),
  ]);
  const deposit = (grants.grants ?? []).find((g) =>
    g.authorization?.["@type"]?.endsWith("DepositAuthorization")
  );
  const creditUact = deposit ? sum(deposit.authorization.spend_limits) : null;
  const escrowUact = (deps.deployments ?? []).reduce(
    (a, d) => a + sum(d.escrow_account?.state?.funds),
    0
  );
  const ratePerBlock = (leases.leases ?? []).reduce(
    (a, l) =>
      a + (l.lease.price.denom === "uact" ? Number(l.lease.price.amount) : 0),
    0
  );
  const burnPerDay = (ratePerBlock * bpd) / 1e6;
  const rateByDseq = new Map(
    (leases.leases ?? []).map((l) => [
      l.lease.id.dseq,
      Number(l.lease.price.amount),
    ])
  );
  const escrowDays = (deps.deployments ?? [])
    .map((d) => {
      const rate = rateByDseq.get(d.deployment.id.dseq);
      return rate ? sum(d.escrow_account?.state?.funds) / (rate * bpd) : null;
    })
    .filter((v) => v !== null);
  const minEscrowDays = escrowDays.length ? Math.min(...escrowDays) : null;
  const credit = creditUact === null ? null : creditUact / 1e6;
  const escrow = escrowUact / 1e6;
  const runwayDays =
    credit === null
      ? null
      : burnPerDay > 0
        ? (credit + escrow) / burnPerDay
        : Infinity;
  return {
    plane: `akash:${env}`,
    account: owner,
    granter: deposit?.granter ?? null,
    consoleCreditAct: credit,
    escrowAct: escrow,
    activeLeases: (leases.leases ?? []).length,
    burnActPerDay: burnPerDay,
    minEscrowDays,
    runwayDays: Number.isFinite(runwayDays) ? runwayDays : null,
    noBurn: runwayDays === Infinity,
    grade: grade(runwayDays),
  };
}

async function ethCall(method, params) {
  const body = await getJson(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (body.error) throw new Error(body.error.message);
  return BigInt(body.result);
}

export async function baseWallet(name, address) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const [usdc, wei] = await Promise.all([
    ethCall("eth_call", [{ to: USDC_BASE, data }, "latest"]),
    ethCall("eth_getBalance", [address, "latest"]),
  ]);
  return {
    plane: `base:${name}`,
    account: address,
    usdc: Number(usdc) / 1e6,
    eth: Number(wei) / 1e18,
    grade: "INFO",
  };
}

export function grade(runwayDays) {
  if (runwayDays === null || Number.isNaN(runwayDays)) return "UNKNOWN";
  if (runwayDays < RUNWAY_DAYS.red) return "RED";
  if (runwayDays < RUNWAY_DAYS.yellow) return "YELLOW";
  return "GREEN";
}

/** Cherry team credit; the vendor serves its own €/h burn and runway hours. */
export async function cherryPlane(token) {
  const teams = await getJson("https://api.cherryservers.com/v1/teams", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const c = teams[0].credit;
  const perHour = c.resources.pricing.price;
  const runwayDays = c.resources.remaining.time / 24;
  return {
    plane: "cherry:team",
    account: String(teams[0].id),
    balance: c.account.remaining,
    currency: c.account.currency,
    burnPerDay: perHour * 24,
    runwayDays,
    grade: grade(runwayDays),
  };
}

/** OpenRouter account-wide credit; burn needs a management key, so runway stays UNKNOWN. */
export async function openRouterPlane(key) {
  const { data } = await getJson("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${key}` },
  });
  return {
    plane: "openrouter:account",
    balance: data.total_credits - data.total_usage,
    currency: "USD",
    burnPerDay: null,
    runwayDays: null,
    grade: "UNKNOWN",
  };
}

async function settle(plane, fn) {
  try {
    return await fn();
  } catch (err) {
    return { plane, grade: "UNKNOWN", error: String(err.message ?? err) };
  }
}

async function main() {
  const json = process.argv.includes("--json");
  const bpd = await blocksPerDay().catch(() => 86_400 / 6);
  const rows = await Promise.all([
    ...Object.entries(AKASH_ACCOUNTS).map(([env, owner]) =>
      settle(`akash:${env}`, () => akashPlane(env, owner, bpd))
    ),
    settle("cherry:team", () =>
      process.env.CHERRY_AUTH_TOKEN
        ? cherryPlane(process.env.CHERRY_AUTH_TOKEN)
        : Promise.reject(new Error("set CHERRY_AUTH_TOKEN to read"))
    ),
    settle("openrouter:account", () =>
      process.env.OPENROUTER_API_KEY
        ? openRouterPlane(process.env.OPENROUTER_API_KEY)
        : Promise.reject(new Error("set OPENROUTER_API_KEY to read"))
    ),
    ...Object.entries(baseWallets()).map(([name, addr]) =>
      settle(`base:${name}`, () =>
        addr
          ? baseWallet(name, addr)
          : Promise.reject(new Error("no address in repo-spec"))
      )
    ),
  ]);
  if (json) {
    console.log(
      JSON.stringify(
        { asOf: new Date().toISOString(), blocksPerDay: bpd, rows },
        null,
        2
      )
    );
  } else {
    const f = (n, d = 2) =>
      n === null || n === undefined
        ? "?"
        : Number.isFinite(n)
          ? n.toFixed(d)
          : "∞";
    for (const r of rows) {
      if (r.error)
        console.log(`${r.grade.padEnd(8)} ${r.plane.padEnd(24)} ${r.error}`);
      else if (r.plane.startsWith("akash"))
        console.log(
          `${r.grade.padEnd(8)} ${r.plane.padEnd(24)} credit ${f(r.consoleCreditAct)} ACT + escrow ${f(r.escrowAct)} ACT / burn ${f(r.burnActPerDay, 3)} ACT/d (${r.activeLeases} leases) = ${r.noBurn ? "∞ (no leases)" : `${f(r.runwayDays, 1)} days`} · thinnest escrow ${f(r.minEscrowDays, 1)} d`
        );
      else if (r.currency)
        console.log(
          `${r.grade.padEnd(8)} ${r.plane.padEnd(24)} ${f(r.balance)} ${r.currency} / burn ${f(r.burnPerDay, 3)} ${r.currency}/d = ${f(r.runwayDays, 1)} days`
        );
      else
        console.log(
          `${r.grade.padEnd(8)} ${r.plane.padEnd(24)} ${f(r.usdc)} USDC · ${f(r.eth, 5)} ETH · ${r.account}`
        );
    }
  }
  const worst = rows.map((r) => r.grade);
  process.exitCode = worst.some((g) => g === "RED" || g === "UNKNOWN")
    ? 2
    : worst.includes("YELLOW")
      ? 1
      : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
