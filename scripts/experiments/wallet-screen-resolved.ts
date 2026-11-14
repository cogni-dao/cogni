// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/wallet-screen-resolved`
 * Purpose: spike.0323 expanded screen — union top-50 wallets across {DAY,WEEK,MONTH}×{PNL,VOL} → fetch trades + join each unique market against CLOB resolution data → compute TRUE per-wallet metrics (realized win rate, realized ROI, realized PnL, max drawdown on the realized-equity curve, median round-trip duration, trades/day) → apply hard filters and rank.
 * Scope: Read-only public Data API + CLOB market lookups. Does not authenticate, does not place orders, does not modify state.
 * Invariants: Global conditionId dedupe; CLOB concurrency bounded; per-wallet trade fetch bounded.
 * Side-effects: IO (HTTPS to data-api.polymarket.com + clob.polymarket.com; writes JSON fixture at docs/research/fixtures/poly-wallet-screen.json and markdown ranking to stdout).
 * Links: https://poly.cognidao.org/knowledge/poly-category-edge-scorecard
 * @internal — spike research, not production code.
 */

import fs from "node:fs";
import path from "node:path";

const BASE_DATA = "https://data-api.polymarket.com";
const BASE_CLOB = "https://clob.polymarket.com";
const LEADERBOARD_TOP_N = 50;
const TRADE_FETCH_LIMIT = 500;
const MARKET_FETCH_CONCURRENCY = 20;
const NOW_SEC = Math.floor(Date.now() / 1000);
const SEC_PER_DAY = 86400;

type TimePeriod = "DAY" | "WEEK" | "MONTH";
type OrderBy = "PNL" | "VOL";

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

interface MarketMeta {
  closed: boolean;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
}

interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string | null;
  vol: number;
  pnl: number;
}

async function fetchLeaderboard(
  timePeriod: TimePeriod,
  orderBy: OrderBy,
  limit: number
): Promise<LeaderboardEntry[]> {
  const u = `${BASE_DATA}/v1/leaderboard?timePeriod=${timePeriod}&orderBy=${orderBy}&limit=${limit}`;
  const j = (await (await fetch(u)).json()) as Array<Record<string, unknown>>;
  return j.map((e) => ({
    rank: String(e.rank),
    proxyWallet: String(e.proxyWallet).toLowerCase(),
    userName: e.userName ?? null,
    vol: Number(e.vol ?? 0),
    pnl: Number(e.pnl ?? 0),
  }));
}

async function fetchTrades(wallet: string): Promise<Trade[]> {
  const u = `${BASE_DATA}/trades?user=${wallet}&limit=${TRADE_FETCH_LIMIT}`;
  try {
    const j = (await (await fetch(u)).json()) as Array<Record<string, unknown>>;
    return j.map((t) => ({
      side: t.side,
      asset: String(t.asset),
      conditionId: String(t.conditionId),
      size: Number(t.size),
      price: Number(t.price),
      timestamp: Number(t.timestamp),
      title: t.title,
      outcome: t.outcome,
    }));
  } catch {
    return [];
  }
}

async function fetchMarket(cid: string): Promise<MarketMeta | null> {
  try {
    const r = await fetch(`${BASE_CLOB}/markets/${cid}`);
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    const rawTokens = (j.tokens as Array<Record<string, unknown>>) ?? [];
    return {
      closed: !!j.closed,
      tokens: rawTokens.map((t) => ({
        token_id: String(t.token_id),
        outcome: String(t.outcome),
        price: Number(t.price),
        winner: !!t.winner,
      })),
    };
  } catch {
    return null;
  }
}

async function fetchMany(cids: string[]): Promise<Map<string, MarketMeta>> {
  const out = new Map<string, MarketMeta>();
  let i = 0;
  const total = cids.length;
  async function worker() {
    while (i < total) {
      const idx = i++;
      const cid = cids[idx];
      const m = await fetchMarket(cid);
      if (m) out.set(cid, m);
      if (idx % 200 === 0)
        process.stderr.write(`    markets [${idx}/${total}]\r`);
    }
  }
  await Promise.all(Array.from({ length: MARKET_FETCH_CONCURRENCY }, worker));
  process.stderr.write(`    markets [${total}/${total}] done\n`);
  return out;
}

interface WalletScore {
  wallet: string;
  userName: string;
  lbAppearances: number;
  lbMaxVol: number;
  lbMaxPnl: number;
  lbRoiPct: number;
  totalTrades: number;
  tradesPerDay30d: number;
  daysSinceLast: number;
  uniqueMarkets: number;
  resolvedPositions: number;
  wins: number;
  losses: number;
  trueWinRatePct: number;
  realizedPnlUsdc: number;
  realizedRoiPct: number;
  maxDrawdownUsdc: number;
  maxDrawdownPctOfPeak: number;
  peakEquityUsdc: number;
  medianDurationHours: number;
  p90DurationHours: number;
  openPositions: number;
  openNetCostUsdc: number;
  topTitles: string[];
  categoryHint: string;
}

function categorize(titles: string[]): string {
  const joined = titles.join(" ").toLowerCase();
  const scores: Record<string, number> = {};
  const add = (cat: string, re: RegExp) => {
    const m = joined.match(re);
    scores[cat] = (scores[cat] ?? 0) + (m ? m.length : 0);
  };
  add(
    "esports",
    /\b(lol|league of legends|dota|counter-strike|\bcs2?\b|valorant|overwatch|parivision|mouz|faze|liquid|sentinels|cloud9)\b/g
  );
  add(
    "nba",
    /\b(nba|lakers|warriors|nuggets|clippers|celtics|heat|knicks|timberwolves|mavericks|rockets|raptors|cavaliers|spread|o\/u)\b/g
  );
  add("nfl", /\b(nfl|cowboys|patriots|chiefs|ravens|eagles|packers|49ers)\b/g);
  add(
    "mlb",
    /\b(mlb|yankees|dodgers|orioles|angels|padres|rangers|red sox|braves|guardians|pirates)\b/g
  );
  add("nhl", /\b(nhl|rangers|bruins|stars|avalanche|flyers|devils|oilers)\b/g);
  add("tennis", /\b(alcaraz|sinner|djokovic|monte carlo|wimbledon|atp|wta)\b/g);
  add(
    "soccer",
    /\b(premier league|arsenal|chelsea|liverpool|tottenham|bayern|real madrid|barcelona|fifa|world cup|uefa)\b/g
  );
  add("ufc", /\b(ufc\b|fight night|octagon)\b/g);
  add("golf", /\b(masters|pga|golf|ryder cup)\b/g);
  add("crypto", /\b(bitcoin|btc|ethereum|eth\b|solana|crypto)\b/g);
  add("politics", /\b(trump|biden|election|president|senate|governor)\b/g);
  add(
    "geopolitics",
    /\b(iran|ukraine|israel|gaza|taiwan|ceasefire|nuclear)\b/g
  );
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : "mixed";
}

function computeScore(
  wallet: string,
  lb: { appearances: number; maxVol: number; maxPnl: number; userName: string },
  trades: Trade[],
  markets: Map<string, MarketMeta>
): WalletScore {
  const totalTrades = trades.length;
  const cutoff30 = NOW_SEC - 30 * SEC_PER_DAY;
  const t30 = trades.filter((t) => t.timestamp >= cutoff30).length;
  const latestTs = trades.length
    ? Math.max(...trades.map((t) => t.timestamp))
    : 0;
  const daysSinceLast = latestTs
    ? (NOW_SEC - latestTs) / SEC_PER_DAY
    : Infinity;

  // Per-token aggregation
  interface TokenAgg {
    buyUsdc: number;
    sellUsdc: number;
    buyShares: number;
    sellShares: number;
    title: string;
    outcome: string;
    conditionId: string;
    firstBuyTs: number;
    lastTradeTs: number;
  }
  const tokens = new Map<string, TokenAgg>();
  const markettitles = new Map<string, string>();
  for (const t of trades) {
    const a =
      tokens.get(t.asset) ??
      ({
        buyUsdc: 0,
        sellUsdc: 0,
        buyShares: 0,
        sellShares: 0,
        title: t.title || "",
        outcome: t.outcome || "",
        conditionId: t.conditionId,
        firstBuyTs: Infinity,
        lastTradeTs: 0,
      } as TokenAgg);
    const usd = t.size * t.price;
    if (t.side === "BUY") {
      a.buyUsdc += usd;
      a.buyShares += t.size;
      a.firstBuyTs = Math.min(a.firstBuyTs, t.timestamp);
    } else {
      a.sellUsdc += usd;
      a.sellShares += t.size;
    }
    a.lastTradeTs = Math.max(a.lastTradeTs, t.timestamp);
    tokens.set(t.asset, a);
    markettitles.set(t.conditionId, t.title || "");
  }

  interface Resolved {
    pnl: number;
    won: boolean;
    closeTs: number;
    durationSec: number;
    buyUsdc: number;
  }
  const resolved: Resolved[] = [];
  let openNetCost = 0;
  let openCount = 0;
  for (const [tokenId, a] of tokens.entries()) {
    const m = markets.get(a.conditionId);
    const actualTok = m?.tokens.find((x) => x.token_id === tokenId);
    if (m?.closed && actualTok) {
      const held = a.buyShares - a.sellShares;
      const payout = held > 0 && actualTok.winner ? held : 0;
      const pnl = a.sellUsdc + payout - a.buyUsdc;
      const dur = a.firstBuyTs !== Infinity ? a.lastTradeTs - a.firstBuyTs : 0;
      resolved.push({
        pnl,
        won: pnl > 0.5,
        closeTs: a.lastTradeTs,
        durationSec: dur,
        buyUsdc: a.buyUsdc,
      });
    } else {
      openNetCost += a.buyUsdc - a.sellUsdc;
      openCount++;
    }
  }

  const wins = resolved.filter((r) => r.won).length;
  const losses = resolved.filter((r) => r.pnl < -0.5).length;
  const winRate = resolved.length ? (wins / resolved.length) * 100 : 0;
  const pnl = resolved.reduce((s, r) => s + r.pnl, 0);
  const capital = resolved.reduce((s, r) => s + r.buyUsdc, 0);
  const roi = capital > 0 ? (pnl / capital) * 100 : 0;

  // Equity curve → max DD
  resolved.sort((a, b) => a.closeTs - b.closeTs);
  let equity = 0,
    peak = 0,
    maxDD = 0;
  for (const r of resolved) {
    equity += r.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDDPctOfPeak = peak > 0 ? (maxDD / peak) * 100 : 0;

  // Duration percentiles (for round-trip markets only — those with buy+sell activity)
  const durs = resolved
    .map((r) => r.durationSec)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const median = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
  const p90 = durs.length ? durs[Math.floor(durs.length * 0.9)] : 0;

  // Top titles + category
  const titleArr = [...markettitles.values()].filter(Boolean).slice(0, 20);
  const category = categorize(titleArr);

  const lbRoiPct = lb.maxVol > 0 ? (lb.maxPnl / lb.maxVol) * 100 : 0;

  return {
    wallet,
    userName: lb.userName,
    lbAppearances: lb.appearances,
    lbMaxVol: lb.maxVol,
    lbMaxPnl: lb.maxPnl,
    lbRoiPct: Number(lbRoiPct.toFixed(2)),
    totalTrades,
    tradesPerDay30d: Number((t30 / 30).toFixed(2)),
    daysSinceLast: Number(daysSinceLast.toFixed(1)),
    uniqueMarkets: tokens.size,
    resolvedPositions: resolved.length,
    wins,
    losses,
    trueWinRatePct: Number(winRate.toFixed(1)),
    realizedPnlUsdc: Number(pnl.toFixed(0)),
    realizedRoiPct: Number(roi.toFixed(1)),
    maxDrawdownUsdc: Number(maxDD.toFixed(0)),
    maxDrawdownPctOfPeak: Number(maxDDPctOfPeak.toFixed(1)),
    peakEquityUsdc: Number(peak.toFixed(0)),
    medianDurationHours: Number((median / 3600).toFixed(1)),
    p90DurationHours: Number((p90 / 3600).toFixed(1)),
    openPositions: openCount,
    openNetCostUsdc: Number(openNetCost.toFixed(0)),
    topTitles: titleArr.slice(0, 3),
    categoryHint: category,
  };
}

async function main(): Promise<void> {
  // 1. Gather wallet universe
  console.error(
    `[screen] fetching 6 leaderboards × top-${LEADERBOARD_TOP_N}...`
  );
  const combos: Array<[TimePeriod, OrderBy]> = [
    ["DAY", "PNL"],
    ["DAY", "VOL"],
    ["WEEK", "PNL"],
    ["WEEK", "VOL"],
    ["MONTH", "PNL"],
    ["MONTH", "VOL"],
  ];
  const walletLb = new Map<
    string,
    { appearances: number; maxVol: number; maxPnl: number; userName: string }
  >();
  for (const [tp, ob] of combos) {
    const entries = await fetchLeaderboard(tp, ob, LEADERBOARD_TOP_N);
    for (const e of entries) {
      const cur = walletLb.get(e.proxyWallet) ?? {
        appearances: 0,
        maxVol: 0,
        maxPnl: 0,
        userName: e.userName || "",
      };
      cur.appearances += 1;
      cur.maxVol = Math.max(cur.maxVol, e.vol);
      cur.maxPnl = Math.max(cur.maxPnl, e.pnl);
      if (!cur.userName && e.userName) cur.userName = e.userName;
      walletLb.set(e.proxyWallet, cur);
    }
  }
  const wallets = [...walletLb.keys()];
  console.error(`[screen] universe: ${wallets.length} unique wallets`);

  // 2. Fetch all trades + collect union of conditionIds
  console.error(`[screen] fetching trades for ${wallets.length} wallets...`);
  const allTrades = new Map<string, Trade[]>();
  const allCids = new Set<string>();
  let done = 0;
  const tradeQueue = [...wallets];
  async function tradeWorker() {
    while (tradeQueue.length) {
      const w = tradeQueue.shift();
      if (!w) return;
      const ts = await fetchTrades(w);
      allTrades.set(w, ts);
      for (const t of ts) allCids.add(t.conditionId);
      done++;
      if (done % 10 === 0)
        process.stderr.write(`    trades [${done}/${wallets.length}]\r`);
    }
  }
  await Promise.all(Array.from({ length: 10 }, tradeWorker));
  process.stderr.write(
    `    trades [${wallets.length}/${wallets.length}] done\n`
  );
  console.error(`[screen] unique conditionIds: ${allCids.size}`);

  // 3. Fetch market metadata
  console.error(`[screen] fetching market resolution data...`);
  const markets = await fetchMany([...allCids]);
  console.error(`[screen] got ${markets.size} / ${allCids.size} markets`);

  // 4. Score each wallet
  const scores: WalletScore[] = [];
  for (const w of wallets) {
    const lb = walletLb.get(w);
    const ts = allTrades.get(w) ?? [];
    if (!lb || ts.length === 0) continue;
    scores.push(computeScore(w, lb, ts, markets));
  }

  // 5. Write fixture
  const outPath = path.resolve(
    __dirname,
    "../../docs/research/fixtures/poly-wallet-screen.json"
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        universe: wallets.length,
        markets: markets.size,
        scores,
      },
      null,
      2
    )
  );
  console.error(`[screen] wrote fixture: ${outPath}`);

  // 6. Hard filter → rank
  const FILTERS = {
    minTradesPerDay: 1,
    maxDaysSinceLast: 5,
    minResolvedPositions: 15,
    minTrueWinRate: 52,
    minRealizedRoi: 10,
    maxMedianDurationHours: 9,
    maxDrawdownPctOfPeak: 40,
  };
  const filtered = scores.filter(
    (s) =>
      s.tradesPerDay30d >= FILTERS.minTradesPerDay &&
      s.daysSinceLast <= FILTERS.maxDaysSinceLast &&
      s.resolvedPositions >= FILTERS.minResolvedPositions &&
      s.trueWinRatePct >= FILTERS.minTrueWinRate &&
      s.realizedRoiPct >= FILTERS.minRealizedRoi &&
      s.medianDurationHours > 0 &&
      s.medianDurationHours <= FILTERS.maxMedianDurationHours &&
      s.maxDrawdownPctOfPeak <= FILTERS.maxDrawdownPctOfPeak
  );

  // Rank: composite = winRate × sqrt(ROI) × (100 / (DD_pct + 10))  (weighted toward clean curves)
  filtered.sort((a, b) => {
    const sA =
      a.trueWinRatePct *
      Math.sqrt(Math.max(0, a.realizedRoiPct)) *
      (100 / (a.maxDrawdownPctOfPeak + 10));
    const sB =
      b.trueWinRatePct *
      Math.sqrt(Math.max(0, b.realizedRoiPct)) *
      (100 / (b.maxDrawdownPctOfPeak + 10));
    return sB - sA;
  });

  console.log(
    `\n## Screen results — ${wallets.length}-wallet universe → ${filtered.length} pass all filters\n`
  );
  console.log(
    `**Filters:** ≥${FILTERS.minTradesPerDay} trades/day · active ≤${FILTERS.maxDaysSinceLast}d · ≥${FILTERS.minResolvedPositions} resolved posns · win rate ≥${FILTERS.minTrueWinRate}% · ROI ≥${FILTERS.minRealizedRoi}% · median dur ≤${FILTERS.maxMedianDurationHours}h · max DD ≤${FILTERS.maxDrawdownPctOfPeak}% of peak\n`
  );

  console.log(
    "| rank | wallet | name | cat | t/day | resolved | WR | ROI | realized PnL | max DD% | med dur | top market |"
  );
  console.log("|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  filtered.forEach((s, i) => {
    const title = s.topTitles[0]?.slice(0, 36) || "";
    console.log(
      `| ${i + 1} | \`${s.wallet.slice(0, 10)}…\` | ${(s.userName || "-").slice(0, 16)} | ${s.categoryHint} | ${s.tradesPerDay30d} | ${s.resolvedPositions} | **${s.trueWinRatePct}%** | ${s.realizedRoiPct}% | $${(s.realizedPnlUsdc / 1000).toFixed(0)}k | ${s.maxDrawdownPctOfPeak}% | ${s.medianDurationHours}h | ${title} |`
    );
  });

  // Also print: top-20 by raw realized PnL, so we can see anyone excluded by filters who is still interesting
  console.log(
    `\n## Excluded-but-notable — top 20 by realized PnL regardless of filters\n`
  );
  const byPnl = [...scores]
    .filter((s) => s.resolvedPositions >= 5)
    .sort((a, b) => b.realizedPnlUsdc - a.realizedPnlUsdc)
    .slice(0, 20);
  console.log(
    "| wallet | cat | t/day | resolved | WR | ROI | realized PnL | DD% | med dur | notes |"
  );
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const s of byPnl) {
    const passes = filtered.includes(s);
    const fails: string[] = [];
    if (s.tradesPerDay30d < 1) fails.push("slow");
    if (s.daysSinceLast > 5) fails.push(`cold(${s.daysSinceLast}d)`);
    if (s.resolvedPositions < 15) fails.push(`low-n(${s.resolvedPositions})`);
    if (s.trueWinRatePct < 52) fails.push(`wr(${s.trueWinRatePct}%)`);
    if (s.realizedRoiPct < 10) fails.push(`roi(${s.realizedRoiPct}%)`);
    if (s.medianDurationHours === 0 || s.medianDurationHours > 9)
      fails.push(`dur(${s.medianDurationHours}h)`);
    if (s.maxDrawdownPctOfPeak > 40)
      fails.push(`dd(${s.maxDrawdownPctOfPeak}%)`);
    const note = passes ? "✅ passes" : fails.join(",");
    console.log(
      `| \`${s.wallet.slice(0, 10)}…\` | ${s.categoryHint} | ${s.tradesPerDay30d} | ${s.resolvedPositions} | ${s.trueWinRatePct}% | ${s.realizedRoiPct}% | $${(s.realizedPnlUsdc / 1000).toFixed(0)}k | ${s.maxDrawdownPctOfPeak}% | ${s.medianDurationHours}h | ${note} |`
    );
  }
}

main().catch((e) => {
  console.error("[screen] unhandled:", e);
  process.exit(1);
});
