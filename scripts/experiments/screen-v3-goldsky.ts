// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/screen-v3-goldsky`
 * Purpose: spike.0323 Phase 2 safe expansion — category-scoped wallet screen using Goldsky positions-subgraph for resolution data (batched conditions(id_in:) → payouts) and disk-cached CLOB for token→outcomeIndex fallback. Replaces the CLOB-blasting v2 screen with a rate-limit-friendly pipeline.
 * Scope: Read-only screening — does not authenticate, does not place orders, does not modify state. Data API + Goldsky subgraph + CLOB with rate-limited fallback.
 * Invariants: Goldsky batches of 100 cids; CLOB fallback pace ≤20 req/s; market metadata cached forever once closed.
 * Side-effects: IO (HTTPS to data-api.polymarket.com + api.goldsky.com + clob.polymarket.com; writes disk cache + fixture).
 * Links: https://poly.cognidao.org/knowledge/poly-wallet-selection-method
 * @internal — spike research, not production code.
 */

import fs from "node:fs";
import path from "node:path";

const BASE_DATA = "https://data-api.polymarket.com";
const BASE_CLOB = "https://clob.polymarket.com";
const GOLDSKY_POSITIONS =
  "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/positions-subgraph/0.0.7/gn";

const CACHE_DIR = path.resolve(
  __dirname,
  "../../docs/research/fixtures/market-cache"
);
fs.mkdirSync(CACHE_DIR, { recursive: true });

const CATEGORIES = process.argv[2]?.split(",") ?? [
  "weather",
  "tech",
  "finance",
  "culture",
];
const WINDOWS = ["WEEK", "MONTH"] as const;
const ORDER_BYS = ["PNL", "VOL"] as const;
const TOP_N = 30;
const TRADE_LIMIT = 500;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

interface Trade {
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title?: string;
  outcome?: string;
}

// --- Rate-limited fetch ---
class TokenBucket {
  private tokens: number;
  constructor(
    private capacity: number,
    private refillPerSec: number
  ) {
    this.tokens = capacity;
    setInterval(() => {
      this.tokens = Math.min(this.capacity, this.tokens + this.refillPerSec);
    }, 1000).unref();
  }
  async take(): Promise<void> {
    while (this.tokens <= 0) await new Promise((r) => setTimeout(r, 100));
    this.tokens -= 1;
  }
}
const clobBucket = new TokenBucket(20, 20); // 20/s sustained
const dataBucket = new TokenBucket(15, 15);

async function getJson<T>(url: string, bucket: TokenBucket): Promise<T | null> {
  await bucket.take();
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status === 503) {
        await new Promise((x) => setTimeout(x, 500 * (i + 1)));
        continue;
      }
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      await new Promise((x) => setTimeout(x, 400));
    }
  }
  return null;
}

// --- Goldsky batched resolution lookup ---
interface Condition {
  id: string;
  payouts: string[] | null;
}
async function fetchConditionsBatch(
  cids: string[]
): Promise<Map<string, Condition>> {
  const out = new Map<string, Condition>();
  const BATCH = 100;
  for (let i = 0; i < cids.length; i += BATCH) {
    const chunk = cids.slice(i, i + BATCH);
    const q = `{ conditions(where: { id_in: [${chunk.map((c) => `"${c}"`).join(",")}] }) { id payouts } }`;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const r = await fetch(GOLDSKY_POSITIONS, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        if (!r.ok) {
          await new Promise((x) => setTimeout(x, 500));
          continue;
        }
        const j = (await r.json()) as {
          data?: { conditions?: Condition[] };
        };
        if (j.data?.conditions) {
          for (const c of j.data.conditions) out.set(c.id, c);
        }
        break;
      } catch {
        await new Promise((x) => setTimeout(x, 500));
      }
    }
    if (i % 500 === 0 && i > 0)
      process.stderr.write(`    goldsky [${i}/${cids.length}]\n`);
  }
  return out;
}

// --- Goldsky token → outcomeIndex mapping (partial) ---
interface TokenMap {
  id: string;
  outcomeIndex: string;
  condition: { id: string };
}
async function fetchTokenMappings(
  tokenIds: string[]
): Promise<Map<string, { conditionId: string; outcomeIndex: number }>> {
  const out = new Map<string, { conditionId: string; outcomeIndex: number }>();
  const BATCH = 100;
  for (let i = 0; i < tokenIds.length; i += BATCH) {
    const chunk = tokenIds.slice(i, i + BATCH);
    const q = `{ tokenIdConditions(first: 1000, where: { id_in: [${chunk.map((c) => `"${c}"`).join(",")}] }) { id outcomeIndex condition { id } } }`;
    try {
      const r = await fetch(GOLDSKY_POSITIONS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const j = (await r.json()) as {
        data?: { tokenIdConditions?: TokenMap[] };
      };
      if (j.data?.tokenIdConditions) {
        for (const t of j.data.tokenIdConditions) {
          out.set(t.id, {
            conditionId: t.condition.id,
            outcomeIndex: Number(t.outcomeIndex),
          });
        }
      }
    } catch {}
  }
  return out;
}

// --- CLOB market metadata (disk-cached; for token→outcomeIndex fallback) ---
interface MarketCache {
  closed: boolean;
  tokens: Array<{ token_id: string; outcome: string; winner: boolean }>;
  fetchedAt: string;
}
function cachePath(cid: string): string {
  return path.join(CACHE_DIR, cid.slice(0, 4), `${cid}.json`);
}
function cacheGet(cid: string): MarketCache | null {
  const p = cachePath(cid);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as MarketCache;
  } catch {
    return null;
  }
}
function cacheSet(cid: string, m: MarketCache): void {
  const p = cachePath(cid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(m));
}
async function fetchMarketCached(cid: string): Promise<MarketCache | null> {
  const hit = cacheGet(cid);
  if (hit?.closed) return hit;
  const j = await getJson<Record<string, unknown>>(
    `${BASE_CLOB}/markets/${cid}`,
    clobBucket
  );
  if (!j) return hit;
  const toks = (j.tokens as Array<Record<string, unknown>>) ?? [];
  const m: MarketCache = {
    closed: !!j.closed,
    tokens: toks.map((t) => ({
      token_id: String(t.token_id),
      outcome: String(t.outcome),
      winner: !!t.winner,
    })),
    fetchedAt: new Date().toISOString(),
  };
  cacheSet(cid, m);
  return m;
}

// --- Leaderboard + trades ---
async function fetchLeaderboard(
  category: string,
  timePeriod: string,
  orderBy: string
): Promise<Array<{ wallet: string; userName: string }>> {
  const u = `${BASE_DATA}/v1/leaderboard?category=${category}&timePeriod=${timePeriod}&orderBy=${orderBy}&limit=${TOP_N}`;
  const j = await getJson<Array<Record<string, unknown>>>(u, dataBucket);
  if (!j) return [];
  return j.map((e) => ({
    wallet: String(e.proxyWallet).toLowerCase(),
    userName: (e.userName as string) || "",
  }));
}

async function fetchTrades(wallet: string): Promise<Trade[]> {
  const u = `${BASE_DATA}/trades?user=${wallet}&limit=${TRADE_LIMIT}`;
  const j = await getJson<Array<Record<string, unknown>>>(u, dataBucket);
  if (!j) return [];
  return j.map((t) => ({
    side: t.side as "BUY" | "SELL",
    asset: String(t.asset),
    conditionId: String(t.conditionId),
    size: Number(t.size),
    price: Number(t.price),
    timestamp: Number(t.timestamp),
    title: t.title as string | undefined,
    outcome: t.outcome as string | undefined,
  }));
}

// --- Score ---
interface Score {
  wallet: string;
  userName: string;
  lbCats: string[];
  tradeCount: number;
  tradesPerDay30d: number;
  daysSinceLast: number;
  uniqueTokens: number;
  uniqueMarkets: number;
  resolved: number;
  wins: number;
  losses: number;
  mappedViaGoldsky: number;
  mappedViaCache: number;
  winRatePct: number;
  pnl: number;
  capital: number;
  roiPct: number;
  maxDd: number;
  maxDdPct: number;
  peak: number;
  medianDurH: number;
  p90DurH: number;
  openPositions: number;
  composite: number;
  topTitles: string[];
}

function score(
  wallet: string,
  userName: string,
  lbCats: string[],
  trades: Trade[],
  conditions: Map<string, Condition>,
  tokenMaps: Map<string, { conditionId: string; outcomeIndex: number }>,
  marketsCache: Map<string, MarketCache>
): Score | null {
  if (trades.length === 0) return null;

  const cutoff30 = NOW - 30 * DAY;
  const t30 = trades.filter((t) => t.timestamp >= cutoff30).length;
  const latest = Math.max(...trades.map((t) => t.timestamp));
  const daysSince = (NOW - latest) / DAY;

  interface TokenAgg {
    buy: number;
    sell: number;
    buyShares: number;
    sellShares: number;
    cid: string;
    firstTs: number;
    lastTs: number;
    title: string;
  }
  const tokens = new Map<string, TokenAgg>();
  for (const t of trades) {
    const a = tokens.get(t.asset) ?? {
      buy: 0,
      sell: 0,
      buyShares: 0,
      sellShares: 0,
      cid: t.conditionId,
      firstTs: Infinity,
      lastTs: 0,
      title: t.title ?? "",
    };
    const u = t.size * t.price;
    if (t.side === "BUY") {
      a.buy += u;
      a.buyShares += t.size;
      a.firstTs = Math.min(a.firstTs, t.timestamp);
    } else {
      a.sell += u;
      a.sellShares += t.size;
    }
    a.lastTs = Math.max(a.lastTs, t.timestamp);
    tokens.set(t.asset, a);
  }

  interface R {
    pnl: number;
    won: boolean;
    closeTs: number;
    dur: number;
    buy: number;
    firstTs: number;
  }
  const resolved: R[] = [];
  let openCount = 0;
  let mappedGoldsky = 0;
  let mappedCache = 0;

  for (const [tid, a] of tokens.entries()) {
    // Determine outcomeIndex
    let outcomeIndex: number | null = null;
    const g = tokenMaps.get(tid);
    if (g) {
      outcomeIndex = g.outcomeIndex;
      mappedGoldsky++;
    } else {
      const mc = marketsCache.get(a.cid);
      if (mc) {
        const idx = mc.tokens.findIndex((x) => x.token_id === tid);
        if (idx >= 0) {
          outcomeIndex = idx;
          mappedCache++;
        }
      }
    }
    if (outcomeIndex === null) {
      openCount++;
      continue;
    }

    const cond = conditions.get(a.cid);
    if (!cond || !cond.payouts) {
      openCount++;
      continue;
    }
    const payoutMul = Number(cond.payouts[outcomeIndex] ?? 0);
    const held = a.buyShares - a.sellShares;
    const payout = held > 0 ? held * payoutMul : 0;
    const pnl = a.sell + payout - a.buy;
    resolved.push({
      pnl,
      won: pnl > 0.5,
      closeTs: a.lastTs,
      dur: a.firstTs !== Infinity ? a.lastTs - a.firstTs : 0,
      buy: a.buy,
      firstTs: a.firstTs,
    });
  }

  const wins = resolved.filter((r) => r.won).length;
  const losses = resolved.filter((r) => r.pnl < -0.5).length;
  const wr = resolved.length ? (wins / resolved.length) * 100 : 0;
  const pnl = resolved.reduce((s, r) => s + r.pnl, 0);
  const capital = resolved.reduce((s, r) => s + r.buy, 0);
  const roi = capital > 0 ? (pnl / capital) * 100 : 0;

  const sorted = [...resolved].sort((a, b) => a.closeTs - b.closeTs);
  let eq = 0,
    peak = 0,
    dd = 0;
  for (const r of sorted) {
    eq += r.pnl;
    if (eq > peak) peak = eq;
    dd = Math.max(dd, peak - eq);
  }
  const ddPct = peak > 0 ? (dd / peak) * 100 : 0;

  const durs = resolved
    .map((r) => r.dur)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const median = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
  const p90 = durs.length ? durs[Math.floor(durs.length * 0.9)] : 0;

  const topTitles = [...tokens.values()]
    .sort((a, b) => b.buy - a.buy)
    .slice(0, 3)
    .map((a) => a.title)
    .filter(Boolean);

  const composite = wr * Math.sqrt(Math.max(0, roi)) * (100 / (ddPct + 10));

  return {
    wallet,
    userName,
    lbCats,
    tradeCount: trades.length,
    tradesPerDay30d: Number((t30 / 30).toFixed(2)),
    daysSinceLast: Number(daysSince.toFixed(1)),
    uniqueTokens: tokens.size,
    uniqueMarkets: new Set([...tokens.values()].map((a) => a.cid)).size,
    resolved: resolved.length,
    wins,
    losses,
    mappedViaGoldsky: mappedGoldsky,
    mappedViaCache: mappedCache,
    winRatePct: Number(wr.toFixed(1)),
    pnl: Number(pnl.toFixed(0)),
    capital: Number(capital.toFixed(0)),
    roiPct: Number(roi.toFixed(1)),
    maxDd: Number(dd.toFixed(0)),
    maxDdPct: Number(ddPct.toFixed(1)),
    peak: Number(peak.toFixed(0)),
    medianDurH: Number((median / 3600).toFixed(2)),
    p90DurH: Number((p90 / 3600).toFixed(2)),
    openPositions: openCount,
    composite: Number(composite.toFixed(1)),
    topTitles,
  };
}

async function main(): Promise<void> {
  console.error(`[v3] categories: ${CATEGORIES.join(", ")}`);

  // 1. Build wallet universe from category-filtered leaderboards
  const walletSet = new Map<string, { userName: string; cats: Set<string> }>();
  for (const c of CATEGORIES) {
    for (const w of WINDOWS) {
      for (const o of ORDER_BYS) {
        const entries = await fetchLeaderboard(c, w, o);
        for (const e of entries) {
          const cur = walletSet.get(e.wallet) ?? {
            userName: e.userName,
            cats: new Set<string>(),
          };
          if (!cur.userName && e.userName) cur.userName = e.userName;
          cur.cats.add(c);
          walletSet.set(e.wallet, cur);
        }
      }
    }
  }
  const wallets = [...walletSet.keys()];
  console.error(`[v3] universe: ${wallets.length} unique wallets`);

  // 2. Fetch trades (rate-limited via dataBucket)
  const allTrades = new Map<string, Trade[]>();
  const allCids = new Set<string>();
  const allTokens = new Set<string>();
  let done = 0;
  await Promise.all(
    wallets.map(async (w) => {
      const t = await fetchTrades(w);
      allTrades.set(w, t);
      for (const x of t) {
        allCids.add(x.conditionId);
        allTokens.add(x.asset);
      }
      done++;
      if (done % 20 === 0)
        process.stderr.write(`    trades [${done}/${wallets.length}]\n`);
    })
  );
  console.error(
    `[v3] ${allCids.size} unique cids, ${allTokens.size} unique tokens`
  );

  // 3. Bulk resolution lookup via Goldsky
  console.error("[v3] fetching conditions from Goldsky...");
  const conditions = await fetchConditionsBatch([...allCids]);
  const resolvedCount = [...conditions.values()].filter(
    (c) => c.payouts
  ).length;
  console.error(
    `[v3] goldsky conditions returned: ${conditions.size}; resolved: ${resolvedCount}`
  );

  // 4. Token→outcomeIndex via Goldsky
  console.error("[v3] fetching token mappings from Goldsky...");
  const tokenMaps = await fetchTokenMappings([...allTokens]);
  console.error(
    `[v3] goldsky tokens mapped: ${tokenMaps.size}/${allTokens.size} (${((tokenMaps.size / allTokens.size) * 100).toFixed(0)}%)`
  );

  // 5. CLOB fallback for unmapped tokens — only for CIDS we need and that are resolved
  const unmappedTokens: string[] = [];
  for (const tok of allTokens)
    if (!tokenMaps.has(tok)) unmappedTokens.push(tok);
  // Group unmapped tokens by their conditionId (we don't know cid for unmapped tokens; but we know the cid from trades)
  const tokenToCid = new Map<string, string>();
  for (const ts of allTrades.values()) {
    for (const t of ts) tokenToCid.set(t.asset, t.conditionId);
  }
  const unmappedCids = new Set<string>();
  for (const tok of unmappedTokens) {
    const c = tokenToCid.get(tok);
    if (c && conditions.get(c)?.payouts) unmappedCids.add(c);
  }
  console.error(
    `[v3] CLOB fallback needed for ${unmappedCids.size} cids (wallets with unmapped resolved tokens)`
  );
  const marketsCache = new Map<string, MarketCache>();
  let mc = 0;
  const cidArr = [...unmappedCids];
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (cidArr.length) {
        const cid = cidArr.shift();
        if (!cid) return;
        const m = await fetchMarketCached(cid);
        if (m) marketsCache.set(cid, m);
        mc++;
        if (mc % 100 === 0)
          process.stderr.write(`    clob-cache [${mc}/${unmappedCids.size}]\n`);
      }
    })
  );

  // 6. Score all wallets
  const scores: Score[] = [];
  for (const w of wallets) {
    const lb = walletSet.get(w);
    const ts = allTrades.get(w);
    if (!lb || !ts) continue;
    const s = score(
      w,
      lb.userName,
      [...lb.cats],
      ts,
      conditions,
      tokenMaps,
      marketsCache
    );
    if (s) scores.push(s);
  }

  // 7. Filter + rank
  const F = {
    minTpd: 1,
    maxDaysSince: 7,
    minResolved: 15,
    minWr: 55,
    minRoi: 10,
    maxMedDurH: 9,
    maxDdPct: 30,
  };
  const pass = scores.filter(
    (s) =>
      s.tradesPerDay30d >= F.minTpd &&
      s.daysSinceLast <= F.maxDaysSince &&
      s.resolved >= F.minResolved &&
      s.winRatePct >= F.minWr &&
      s.roiPct >= F.minRoi &&
      s.medianDurH > 0 &&
      s.medianDurH <= F.maxMedDurH &&
      s.maxDdPct <= F.maxDdPct
  );
  pass.sort((a, b) => b.composite - a.composite);

  // 8. Write fixture
  const catSlug = CATEGORIES.join("-");
  const outPath = path.resolve(
    __dirname,
    `../../docs/research/fixtures/poly-wallet-screen-v3-${catSlug}.json`
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        categories: CATEGORIES,
        universeSize: wallets.length,
        cidsTotal: allCids.size,
        cidsResolvedViaGoldsky: resolvedCount,
        tokensTotal: allTokens.size,
        tokensMappedViaGoldsky: tokenMaps.size,
        marketsCacheFetched: marketsCache.size,
        scores,
      },
      null,
      2
    )
  );
  console.error(`[v3] wrote: ${outPath}`);

  // 9. Print ranking
  console.log(
    `\n## v3 Goldsky screen — categories: ${CATEGORIES.join(", ")}\n`
  );
  console.log(
    `**Universe:** ${wallets.length} wallets · ${allCids.size} cids · ${resolvedCount} resolved · ${tokenMaps.size}/${allTokens.size} tokens mapped via Goldsky`
  );
  console.log(
    `**Filters:** t/day≥${F.minTpd} · active≤${F.maxDaysSince}d · resolved≥${F.minResolved} · WR≥${F.minWr}% · ROI≥${F.minRoi}% · median dur ≤${F.maxMedDurH}h · DD≤${F.maxDdPct}%\n`
  );
  console.log(`**Survivors: ${pass.length}**\n`);
  console.log(
    "| rank | wallet | name | lb cats | t/day | resolved | WR | ROI | PnL | DD% | med dur | top market |"
  );
  console.log("|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (let i = 0; i < Math.min(pass.length, 20); i++) {
    const s = pass[i];
    const title = s.topTitles[0]?.slice(0, 36) || "";
    console.log(
      `| ${i + 1} | \`${s.wallet.slice(0, 10)}…\` | ${(s.userName || "-").slice(0, 16)} | ${s.lbCats.join("/")} | ${s.tradesPerDay30d} | ${s.resolved} | **${s.winRatePct}%** | ${s.roiPct}% | $${(s.pnl / 1000).toFixed(0)}k | ${s.maxDdPct}% | ${s.medianDurH}h | ${title} |`
    );
  }

  console.log(`\n## Top 20 by realized PnL regardless of filters\n`);
  const byPnl = [...scores]
    .filter((s) => s.resolved >= 5)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 20);
  console.log(
    "| wallet | name | lb cats | resolved | WR | ROI | PnL | DD% | med dur | passes? |"
  );
  console.log("|---|---|---|---:|---:|---:|---:|---:|---:|---|");
  for (const s of byPnl) {
    console.log(
      `| \`${s.wallet.slice(0, 10)}…\` | ${(s.userName || "-").slice(0, 16)} | ${s.lbCats.join("/")} | ${s.resolved} | ${s.winRatePct}% | ${s.roiPct}% | $${(s.pnl / 1000).toFixed(0)}k | ${s.maxDdPct}% | ${s.medianDurH}h | ${pass.includes(s) ? "✅" : "—"} |`
    );
  }
}

main().catch((e) => {
  console.error("[v3]", e);
  process.exit(1);
});
