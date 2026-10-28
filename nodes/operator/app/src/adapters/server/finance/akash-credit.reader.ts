// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/akash-credit.reader`
 * Purpose: Available Console credit and active lease burn provide an account top-up estimate.
 * Scope: Public Akash chain reads through injected fetch. All lists use bounded pagination.
 * Invariants: READERS_NEVER_THROW; invalid/incomplete evidence is UNKNOWN. The grant must match the
 *   injected funding identity, owner, deployment scope and expiry. Reserved escrow is source detail only,
 *   never available credit or grade. No active leases means INFO, not an urgent top-up.
 * Side-effects: IO (HTTPS GET via injected fetch)
 * Links: scripts/money-plane-snapshot.mjs, https://cognidao.org/knowledge/money-plane-registry, https://cognidao.org/work/items/task.5347
 * @public
 */
import {
  type FetchLike,
  gradeRunway,
  type MoneyPlaneRow,
  type PayAction,
  type PlaneReader,
  unknownRow,
} from "@cogni/money-plane";

/** Akash mainnet block cadence; the same parameter the operator's goal KPI script uses. */
export const AKASH_SECONDS_PER_BLOCK = 5.884;
export const FALLBACK_BLOCKS_PER_DAY = 86_400 / AKASH_SECONDS_PER_BLOCK;
export const AKASH_LCD_URL = "https://api.akashnet.net";
export const AKASH_CREDIT_PLANE = "akash:credit";
/** Pages followed per list before the row is marked "coverage incomplete". */
export const AKASH_MAX_PAGES = 5;
/**
 * The Console account that pays every node's hosting in production; AKASH_ACTUATOR_ACCOUNT_ID
 * overrides it when set. Registry: https://cognidao.org/knowledge/money-plane-registry
 */
export const AKASH_PRODUCTION_OWNER =
  "akash10auj6u6wr7aqjawuxurgue9w7wfnca50t8cr4l";
const UACT_PER_USD = 1e6;
const KNOWN_DENOMS = new Set(["uact", "uakt"]);

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

/** A shape problem the row must report instead of hiding behind a zero. */
class ShapeError extends Error {}

/** Follow `pagination.next_key` up to AKASH_MAX_PAGES; the list must be present and an array on every page. */
async function readList<T>(
  fetch: FetchLike,
  url: string,
  key: "leases" | "deployments" | "grants",
  signal?: AbortSignal
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let nextKey: string | null = null;
  for (let page = 0; page < AKASH_MAX_PAGES; page++) {
    const body = (await getJson(
      fetch,
      nextKey ? `${url}&pagination.key=${encodeURIComponent(nextKey)}` : url,
      signal
    )) as Record<string, unknown> | null;
    const list = body?.[key];
    if (!Array.isArray(list)) throw new ShapeError(`${key} list unavailable`);
    items.push(...(list as T[]));
    const next = (body?.pagination as { next_key?: unknown } | undefined)
      ?.next_key;
    if (next !== undefined && next !== null && typeof next !== "string")
      throw new ShapeError(`${key} pagination invalid`);
    nextKey = typeof next === "string" && next.length > 0 ? next : null;
    if (nextKey === null) return { items, complete: true };
  }
  return { items, complete: false };
}

export interface AkashCreditReaderOptions {
  owner: string;
  /** Trusted public Console funding identity, supplied by runtime composition. */
  expectedGranter: string;
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
  grantee?: unknown;
  expiration?: unknown;
  authorization?: {
    "@type"?: unknown;
    scopes?: unknown;
    spend_limits?: unknown;
    spend_limit?: unknown;
  };
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

/** Chain amounts must be explicit nonnegative decimal strings; never coerce absence to zero. */
function amountValue(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d+(?:\.\d+)?$/.test(value) ||
    !Number.isFinite(Number(value))
  )
    throw new ShapeError("fund amount invalid");
  return Number(value);
}

function verifiedUact(coins: unknown): number {
  if (!Array.isArray(coins)) throw new ShapeError("funds unavailable");
  let total = 0;
  for (const coin of coins as Coin[]) {
    const amount = amountValue(coin?.amount);
    if (coin?.denom === "uact") total += amount;
    else if (coin?.denom !== "uakt" || amount !== 0)
      throw new ShapeError("unsupported fund denomination");
  }
  if (!Number.isFinite(total)) throw new ShapeError("fund total invalid");
  return total;
}

function deploymentId(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new ShapeError("deployment identity unavailable");
  return value;
}

/** Exact per-block uact price of one lease; throws a ShapeError for an unparseable or unsupported price. */
function leasePriceUact(lease: Lease): number {
  const price = lease.lease?.price;
  const amount = Number(price?.amount);
  const denom = price?.denom;
  if (
    typeof price?.amount !== "string" ||
    !/^\d+(?:\.\d+)?$/.test(price.amount) ||
    !Number.isFinite(amount) ||
    amount < 0
  )
    throw new ShapeError("lease price invalid");
  if (typeof denom !== "string" || !KNOWN_DENOMS.has(denom))
    throw new ShapeError("lease price denom unknown");
  if (denom !== "uact")
    throw new ShapeError(`unsupported lease denom ${denom}`);
  return amount;
}

export function akashCreditReader(
  options: AkashCreditReaderOptions
): PlaneReader {
  const plane = AKASH_CREDIT_PLANE;
  const label = "Akash credit";
  /** Console billing is card-only and sign-in gated; not from the steward wallet. */
  const rail = {
    kind: "card-manual" as const,
    status: "planned" as const,
    guide: "Console",
  };
  const lcd = options.lcdUrl ?? AKASH_LCD_URL;
  const now = options.now ?? (() => new Date());
  const withAction =
    options.payAction === undefined ? {} : { payAction: options.payAction };
  const unknown = (detail: string): MoneyPlaneRow => ({
    ...unknownRow({
      plane,
      label,
      kind: "prepaid",
      reasonCode: "unreadable",
      observedAt: now().toISOString(),
      detail,
    }),
    payer: "Operator",
    rail,
    ...withAction,
  });
  return {
    plane,
    label,
    kind: "prepaid",
    ...withAction,
    async read(signal): Promise<MoneyPlaneRow> {
      try {
        const owner = encodeURIComponent(options.owner);
        const q = `filters.owner=${owner}&filters.state=active&pagination.limit=500`;
        const grants = await readList<Grant>(
          options.fetch,
          `${lcd}/cosmos/authz/v1beta1/grants/grantee/${owner}?pagination.limit=500`,
          "grants",
          signal
        );
        if (!grants.complete)
          return unknown("coverage incomplete · more pages than read");
        const matches = grants.items.filter(
          (g) =>
            g?.granter === options.expectedGranter &&
            g?.grantee === options.owner &&
            g?.authorization?.["@type"] ===
              "/akash.escrow.v1.DepositAuthorization"
        );
        if (!options.expectedGranter || matches.length !== 1)
          return unknown("Console credit grant missing or ambiguous");
        const deposit = matches[0];
        const authorization = deposit?.authorization;
        const expiration =
          typeof deposit?.expiration === "string"
            ? Date.parse(deposit.expiration)
            : NaN;
        if (
          !Number.isFinite(expiration) ||
          expiration <= now().getTime() ||
          !Array.isArray(authorization?.scopes) ||
          !authorization.scopes.includes("deployment")
        )
          return unknown("Console credit grant scope or expiry invalid");
        const legacy = authorization.spend_limit as Coin | undefined;
        if (
          legacy !== undefined &&
          (verifiedUact([legacy]) !== 0 || amountValue(legacy.amount) !== 0)
        )
          return unknown("legacy grant credit unsupported");
        const creditUact = verifiedUact(authorization.spend_limits);
        const [deployments, leases] = await Promise.all([
          readList<Deployment>(
            options.fetch,
            `${lcd}/akash/deployment/v1beta4/deployments/list?${q}`,
            "deployments",
            signal
          ),
          readList<Lease>(
            options.fetch,
            `${lcd}/akash/market/v1beta5/leases/list?${q}`,
            "leases",
            signal
          ),
        ]);
        if (!deployments.complete || !leases.complete)
          return unknown("coverage incomplete · more pages than read");
        const escrowByDseq = new Map<string, number>();
        let escrowUact = 0;
        for (const deployment of deployments.items) {
          const dseq = deploymentId(deployment?.deployment?.id?.dseq);
          if (escrowByDseq.has(dseq))
            return unknown("duplicate deployment identity");
          const amount = verifiedUact(deployment.escrow_account?.state?.funds);
          escrowByDseq.set(dseq, amount);
          escrowUact += amount;
        }
        if (!Number.isFinite(escrowUact))
          return unknown("escrow total invalid");
        // Σ price per deployment: a deployment can hold several leases.
        const rateByDseq = new Map<string, number>();
        let ratePerBlock = 0;
        for (const lease of leases.items) {
          const price = leasePriceUact(lease);
          const dseq = deploymentId(lease.lease?.id?.dseq);
          if (!escrowByDseq.has(dseq))
            return unknown("lease escrow unavailable");
          rateByDseq.set(dseq, (rateByDseq.get(dseq) ?? 0) + price);
          ratePerBlock += price;
        }
        const measured = options.blocksPerDay;
        const bpd =
          measured !== null && Number.isFinite(measured) && measured > 0
            ? measured
            : FALLBACK_BLOCKS_PER_DAY;
        const burnPerDay = (ratePerBlock * bpd) / UACT_PER_USD;
        if (!Number.isFinite(burnPerDay)) return unknown("lease burn invalid");
        const perDeployment = [...rateByDseq].flatMap(([dseq, rate]) =>
          rate > 0
            ? [{ dseq, days: (escrowByDseq.get(dseq) ?? 0) / (rate * bpd) }]
            : []
        );
        const balance = creditUact / UACT_PER_USD;
        const observedAt = now().toISOString();
        const base: MoneyPlaneRow = {
          plane,
          label,
          kind: "prepaid",
          balance,
          currency: "USD",
          burnPerDay,
          runwayDays: null,
          grade: "UNKNOWN",
          observedAt,
          source: `Available Console credit · escrow excluded · ${leases.items.length} leases at ${Math.round(bpd).toLocaleString("en-US")} blocks/day (${measured ? "measured" : "5.884 s/block fallback"})`,
          sourceObservedAt: observedAt,
          freshness: "current",
          payer: "Operator",
          rail,
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
        };
        if (burnPerDay === 0)
          return {
            ...base,
            grade: "INFO",
            detail:
              leases.items.length === 0 ? "No active leases" : "No priced burn",
          };
        const runwayDays = balance / burnPerDay;
        if (!Number.isFinite(runwayDays))
          return unknown("credit runway invalid");
        return {
          ...base,
          runwayDays,
          grade: gradeRunway(runwayDays),
          detail: `Account top-up estimate, not shutdown time. Escrow at last settlement: ${perDeployment.map(({ dseq, days }) => `${dseq} ${days.toFixed(1)}d`).join("; ")}. Console normally refills escrow. Allowance does not prove provider solvency or refill success.`,
        };
      } catch (error) {
        return unknown(
          error instanceof ShapeError
            ? error.message
            : "Akash chain read failed"
        );
      }
    },
  };
}
