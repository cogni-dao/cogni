// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/akash-credit.reader`
 * Purpose: Akash credit · fleet — Console credit (DepositAuthorization spend_limit) + deployment escrow ÷ lease burn → runway.
 * Scope: TypeScript port of `akashPlane()` and `blocksPerDay()` in scripts/money-plane-snapshot.mjs (PR #2874), same LCD
 *   endpoints, field paths and grading, behind the injected safe fetch. Keyless public reads only.
 * Invariants: READERS_NEVER_THROW — any failure is UNKNOWN "Akash chain read failed". uact is USD credit micro, never FX.
 *   RUNWAY_IS_GRANT_PLUS_ESCROW. Burn uses the measured chain cadence when supplied, else 5.884 s/block.
 * Side-effects: IO (HTTPS GET via injected fetch)
 * Links: scripts/money-plane-snapshot.mjs, https://cognidao.org/knowledge/money-plane-registry, https://cognidao.org/work/items/task.5347
 * @public
 */
import {
  type FetchLike,
  gradeRunway,
  type PayAction,
  type PlaneReader,
  unknownRow,
} from "@cogni/money-plane";

import type { FinanceRow } from "@/ports/finance-report.port";

/** Akash mainnet block cadence; the same parameter the operator's goal KPI script uses. */
export const AKASH_SECONDS_PER_BLOCK = 5.884;
export const FALLBACK_BLOCKS_PER_DAY = 86_400 / AKASH_SECONDS_PER_BLOCK;
export const AKASH_LCD_URL = "https://api.akashnet.net";
export const AKASH_CREDIT_PLANE = "akash:credit";
/**
 * The Console account that pays every node's hosting in production; AKASH_ACTUATOR_ACCOUNT_ID
 * overrides it when set. Registry: https://cognidao.org/knowledge/money-plane-registry
 */
export const AKASH_PRODUCTION_OWNER =
  "akash10auj6u6wr7aqjawuxurgue9w7wfnca50t8cr4l";
const UACT_PER_USD = 1e6;

interface Coin {
  denom?: unknown;
  amount?: unknown;
}
/** Σ amount of the uact coins in a Cosmos coin list (script `sum(coins, "uact")`). */
export function sumUact(coins: unknown): number {
  if (!Array.isArray(coins)) return 0;
  return (coins as Coin[]).reduce((sum, coin) => {
    const amount = Number(coin?.amount);
    return coin?.denom === "uact" && Number.isFinite(amount)
      ? sum + amount
      : sum;
  }, 0);
}

async function getJson(
  fetch: FetchLike,
  url: string,
  signal?: AbortSignal
): Promise<unknown> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Measured blocks/day over the last 10,000 blocks (script `blocksPerDay()`); null when unreadable. */
export async function readAkashBlocksPerDay(
  fetch: FetchLike,
  lcdUrl = AKASH_LCD_URL,
  signal?: AbortSignal
): Promise<number | null> {
  try {
    const tip = (await getJson(
      fetch,
      `${lcdUrl}/cosmos/base/tendermint/v1beta1/blocks/latest`,
      signal
    )) as { block?: { header?: { height?: unknown; time?: unknown } } };
    const height = Number(tip.block?.header?.height);
    const back = (await getJson(
      fetch,
      `${lcdUrl}/cosmos/base/tendermint/v1beta1/blocks/${height - 10_000}`,
      signal
    )) as { block?: { header?: { time?: unknown } } };
    const secs =
      (Date.parse(String(tip.block?.header?.time)) -
        Date.parse(String(back.block?.header?.time))) /
      1000;
    const perDay = (86_400 * 10_000) / secs;
    return Number.isFinite(perDay) && perDay > 0 ? perDay : null;
  } catch {
    return null;
  }
}

export interface AkashCreditReaderOptions {
  owner: string;
  fetch: FetchLike;
  /** Measured chain cadence from readAkashBlocksPerDay; null falls back to 5.884 s/block. */
  blocksPerDay: number | null;
  lcdUrl?: string;
  now?: () => Date;
  /** Carried on every row, readable or not, so the top-up stays reachable (ONE_ROW_MODEL). */
  payAction?: PayAction;
}

interface Grant {
  granter?: unknown;
  authorization?: { "@type"?: unknown; spend_limits?: unknown };
}
interface Deployment {
  deployment?: { id?: { dseq?: unknown } };
  escrow_account?: { state?: { funds?: unknown } };
}
interface Lease {
  lease?: {
    id?: { dseq?: unknown };
    price?: { denom?: unknown; amount?: unknown };
  };
}

export function akashCreditReader(
  options: AkashCreditReaderOptions
): PlaneReader {
  const plane = AKASH_CREDIT_PLANE;
  const label = "Akash credit";
  const lcd = options.lcdUrl ?? AKASH_LCD_URL;
  const now = options.now ?? (() => new Date());
  const withAction =
    options.payAction === undefined ? {} : { payAction: options.payAction };
  const unknown = (detail: string): FinanceRow => ({
    ...unknownRow({
      plane,
      label,
      kind: "prepaid",
      reasonCode: "unreadable",
      observedAt: now().toISOString(),
      detail,
    }),
    payer: "Operator",
    ...withAction,
  });
  return {
    plane,
    label,
    kind: "prepaid",
    ...withAction,
    async read(signal): Promise<FinanceRow> {
      try {
        const owner = encodeURIComponent(options.owner);
        const q = `filters.owner=${owner}&filters.state=active&pagination.limit=500`;
        const [grants, deps, leases] = (await Promise.all([
          getJson(
            options.fetch,
            `${lcd}/cosmos/authz/v1beta1/grants/grantee/${owner}`,
            signal
          ),
          getJson(
            options.fetch,
            `${lcd}/akash/deployment/v1beta4/deployments/list?${q}`,
            signal
          ),
          getJson(
            options.fetch,
            `${lcd}/akash/market/v1beta5/leases/list?${q}`,
            signal
          ),
        ])) as [
          { grants?: Grant[] } | null,
          { deployments?: Deployment[] } | null,
          { leases?: Lease[] } | null,
        ];
        const deposit = (grants?.grants ?? []).find((g) =>
          String(g.authorization?.["@type"] ?? "").endsWith(
            "DepositAuthorization"
          )
        );
        if (!deposit) return unknown("no Console credit grant");
        const creditUact = sumUact(deposit.authorization?.spend_limits);
        const deployments = deps?.deployments ?? [];
        const escrowUact = deployments.reduce(
          (sum, d) => sum + sumUact(d.escrow_account?.state?.funds),
          0
        );
        const activeLeases = leases?.leases ?? [];
        const ratePerBlock = activeLeases.reduce((sum, l) => {
          const amount = Number(l.lease?.price?.amount);
          return l.lease?.price?.denom === "uact" && Number.isFinite(amount)
            ? sum + amount
            : sum;
        }, 0);
        const measured = options.blocksPerDay;
        const bpd =
          measured !== null && Number.isFinite(measured) && measured > 0
            ? measured
            : FALLBACK_BLOCKS_PER_DAY;
        const burnPerDay = (ratePerBlock * bpd) / UACT_PER_USD;
        const rateByDseq = new Map(
          activeLeases.map((l) => [
            String(l.lease?.id?.dseq),
            Number(l.lease?.price?.amount),
          ])
        );
        const escrowDays = deployments.flatMap((d) => {
          const rate = rateByDseq.get(String(d.deployment?.id?.dseq));
          return rate
            ? [sumUact(d.escrow_account?.state?.funds) / (rate * bpd)]
            : [];
        });
        const minEscrowDays = escrowDays.length
          ? Math.min(...escrowDays)
          : null;
        const balance = (creditUact + escrowUact) / UACT_PER_USD;
        const observedAt = now().toISOString();
        const base: FinanceRow = {
          plane,
          label,
          kind: "prepaid",
          balance,
          currency: "USD",
          burnPerDay,
          runwayDays: null,
          grade: "UNKNOWN",
          observedAt,
          source: `Akash chain · Console grant + escrow · ${activeLeases.length} leases at ${Math.round(bpd).toLocaleString("en-US")} blocks/day (${measured ? "measured" : "5.884 s/block fallback"})`,
          sourceObservedAt: observedAt,
          freshness: "current",
          payer: "Operator",
          rollup: true,
          ...withAction,
          nativeRate: {
            amount: String(ratePerBlock),
            currency: "uact",
            per: "block",
          },
          parts: [
            {
              label: "Console credit",
              amount: String(creditUact),
              currency: "uact",
            },
            { label: "Escrow", amount: String(escrowUact), currency: "uact" },
          ],
          ...(minEscrowDays === null
            ? {}
            : { detail: `thinnest escrow ${minEscrowDays.toFixed(1)} d` }),
        };
        if (balance <= 0)
          return {
            ...base,
            runwayDays: 0,
            grade: "RED",
            detail: "credit exhausted",
          };
        if (burnPerDay === 0)
          return { ...base, grade: "GREEN", detail: "no priced lease" };
        const runwayDays = balance / burnPerDay;
        return { ...base, runwayDays, grade: gradeRunway(runwayDays) };
      } catch {
        return unknown("Akash chain read failed");
      }
    },
  };
}
