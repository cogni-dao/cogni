// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/wallet-screen-v2`
 * Purpose: spike.0323 Phase 2 expanded screen — union top-30 wallets across 8 Polymarket categories × 3 windows × 2 rankings, join every unique market against CLOB resolution with exponential backoff, compute true per-wallet metrics (realized win rate, realized ROI, realized PnL, max drawdown, median duration, trades/day), filter + rank with category specialty tagging.
 * Scope: Read-only public Data API + CLOB lookups. Does not authenticate, does not place orders.
 * Invariants: Category-filtered leaderboard; CLOB backoff on 429/503; concurrency bounded.
 * Side-effects: IO (HTTPS to data-api.polymarket.com + clob.polymarket.com; writes JSON fixture and markdown ranking).
 * Links: https://poly.cognidao.org/knowledge/poly-category-edge-scorecard
 * @internal — spike research, not production code.
 */

import fs from "node:fs";
import path from "node:path";

const BASE_DATA = "https://data-api.polymarket.com";
const BASE_CLOB = "https://clob.polymarket.com";
const CATEGORIES = [
  "politics",
  "sports",
  "crypto",
  "weather",
  "culture",
  "economics",
  "tech",
  "finance",
] as const;
const WINDOWS = ["DAY", "WEEK", "MONTH"] as const;
const ORDER_BYS = ["PNL", "VOL"] as const;
const LEADERBOARD_TOP_N = 30;
const TRADE_FETCH_LIMIT = 500;
const CLOB_CONCURRENCY = 12;
const TRADE_CONCURRENCY = 15;
const NOW_SEC = Math.floor(Date.now() / 1000);
const SEC_PER_DAY = 86400;

interface Trade {
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title?: string;
}
interface Market {
  closed: boolean;
  tokens: Array<{ token_id: string; winner: boolean }>;
}
interface LeaderboardEntry {
  proxyWallet: string;
  userName: string | null;
  vol: number;
  pnl: number;
  rank: string;
  category: string;
  timePeriod: string;
  orderBy: string;
}

async function fetchLeaderboard(
  category: string,
  timePeriod: string,
  orderBy: string
): Promise<LeaderboardEntry[]> {
  const u = `${BASE_DATA}/v1/leaderboard?category=${category}&timePeriod=${timePeriod}&orderBy=${orderBy}&limit=${LEADERBOARD_TOP_N}`;
  try {
    const j = (await (await fetch(u)).json()) as Array<Record<string, unknown>>;
    return j.map((e) => ({
      proxyWallet: String(e.proxyWallet).toLowerCase(),
      userName: (e.userName as string) ?? null,
      vol: Number(e.vol ?? 0),
      pnl: Number(e.pnl ?? 0),
      rank: String(e.rank),
      category,
      timePeriod,
      orderBy,
    }));
  } catch {
    return [];
  }
}

async function fetchTrades(wallet: string): Promise<Trade[]> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(
        `${BASE_DATA}/trades?user=${wallet}&limit=${TRADE_FETCH_LIMIT}`
      );
      if (r.status === 429 || r.status === 503) {
        await new Promise((x) => setTimeout(x, 500 * (i + 1)));
        continue;
      }
      if (!r.ok) return [];
      const j = (await r.json()) as Array<Record<string, unknown>>;
      return j.map((t) => ({
        side: t.side as "BUY" | "SELL",
        asset: String(t.asset),
        conditionId: String(t.conditionId),
        size: Number(t.size),
        price: Number(t.price),
        timestamp: Number(t.timestamp),
        title: t.title as string | undefined,
      }));
    } catch {
      await new Promise((x) => setTimeout(x, 400));
    }
  }
  return [];
}

async function fetchMarket(cid: string): Promise<Market | null> {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${BASE_CLOB}/markets/${cid}`);
      if (r.status === 429 || r.status === 503) {
        await new Promise((x) =>
          setTimeout(x, 400 * (i + 1) + Math.random() * 300)
        );
        continue;
      }
      if (!r.ok) return null;
      const j = (await r.json()) as Record<string, unknown>;
      const toks = (j.tokens as Array<Record<string, unknown>>) ?? [];
      return {
        closed: !!j.closed,
        tokens: toks.map((t) => ({
          token_id: String(t.token_id),
          winner: !!t.winner,
        })),
      };
    } catch {
      await new Promise((x) => setTimeout(x, 300 * (i + 1)));
    }
  }
  return null;
}

interface WalletScore {
  wallet: string;
  userName: string;
  lbCategoriesSeen: string[];
  lbAppearances: number;
  lbMaxPnl: number;
  lbMaxVol: number;
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
  specialtyCategory: string;
  specialtyShare: number;
  topTitles: string[];
  compositeScore: number;
}

function classifyMarket(title: string): string {
  const t = title.toLowerCase();
  if (
    /\b(lol|dota|counter-strike|\bcs2?\b|valorant|overwatch|rocket league|\bsc2\b|starcraft|esl|iem|blast|lcs|lec|lpl|lck|sentinels|cloud9|faze|liquid|mouz|parivision)\b/.test(
      t
    )
  )
    return "esports";
  if (
    /\b(nba|lakers|warriors|spread|over\/under|o\/u|knicks|heat|celtics|nuggets|clippers|timberwolves)\b/.test(
      t
    )
  )
    return "nba";
  if (/\b(nfl|cowboys|patriots|chiefs|ravens|eagles|packers|49ers)\b/.test(t))
    return "nfl";
  if (
    /\b(mlb|yankees|red sox|dodgers|angels|padres|orioles|braves|cubs|guardians|pirates|rangers)\b/.test(
      t
    )
  )
    return "mlb";
  if (/\b(ipl|cricket|t20|odi|test cricket|delhi capitals|mumbai)\b/.test(t))
    return "cricket";
  if (/\b(atp|wimbledon|monte carlo|alcaraz|sinner|djokovic|nadal)\b/.test(t))
    return "tennis";
  if (/\b(ufc|fight night|octagon|mma)\b/.test(t)) return "ufc";
  if (/\b(pga|masters|ryder cup|golf|henley|cameron young)\b/.test(t))
    return "golf";
  if (/\b(nhl|bruins|oilers|flyers|rangers|stars|avalanche)\b/.test(t))
    return "nhl";
  if (
    /\b(premier league|arsenal|chelsea|liverpool|tottenham|bayern|real madrid|barcelona|fifa|uefa|world cup)\b/.test(
      t
    )
  )
    return "soccer";
  if (/vs\./.test(t)) return "sports-other";
  if (/\b(btc|bitcoin|eth|ethereum|solana|crypto|token launch)\b/.test(t))
    return "crypto";
  if (
    /\b(high temp|low temp|hurricane|rainfall|snow|weather|noaa|warmest)\b/.test(
      t
    )
  )
    return "weather";
  if (
    /\b(president|election|senate|governor|trump|biden|democrat|republican|primary|poll)\b/.test(
      t
    )
  )
    return "politics";
  if (/\b(iran|ukraine|israel|gaza|taiwan|ceasefire|nuclear)\b/.test(t))
    return "geopolitics";
  if (
    /\b(cpi|fed|fomc|rate|unemployment|jobs|inflation|powell|gdp|tariff)\b/.test(
      t
    )
  )
    return "economics";
  if (/\b(oscar|grammy|emmy|mvp|nobel)\b/.test(t)) return "awards";
  if (/\b(survivor|bachelor|reality|tiktok|celebrity)\b/.test(t))
    return "entertainment";
  return "other";
}

function computeScore(
  wallet: string,
  lb: { entries: LeaderboardEntry[]; userName: string },
  trades: Trade[],
  markets: Map<string, Market>
): WalletScore | null {
  if (trades.length === 0) return null;
  const cutoff30 = NOW_SEC - 30 * SEC_PER_DAY;
  const t30 = trades.filter((t) => t.timestamp >= cutoff30).length;
  const latest = Math.max(...trades.map((t) => t.timestamp));
  const daysSince = (NOW_SEC - latest) / SEC_PER_DAY;

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

  interface Resolved {
    pnl: number;
    won: boolean;
    closeTs: number;
    dur: number;
    buy: number;
    firstTs: number;
    cat: string;
  }
  const resolvedAll: Resolved[] = [];
  let openCount = 0;
  for (const [tid, a] of tokens.entries()) {
    const m = markets.get(a.cid);
    const tok = m?.tokens.find((x) => x.token_id === tid);
    const cat = classifyMarket(a.title);
    if (m?.closed && tok) {
      const held = a.buyShares - a.sellShares;
      const payout = held > 0 && tok.winner ? held : 0;
      const pnl = a.sell + payout - a.buy;
      resolvedAll.push({
        pnl,
        won: pnl > 0.5,
        closeTs: a.lastTs,
        dur: a.firstTs !== Infinity ? a.lastTs - a.firstTs : 0,
        buy: a.buy,
        firstTs: a.firstTs,
        cat,
      });
    } else {
      openCount++;
    }
  }

  // Restrict to last-30d resolved for primary metrics (freshness)
  const res30 = resolvedAll.filter((r) => r.firstTs >= cutoff30);
  const target = res30.length >= 15 ? res30 : resolvedAll;

  const wins = target.filter((r) => r.won).length;
  const losses = target.filter((r) => r.pnl < -0.5).length;
  const wr = target.length ? (wins / target.length) * 100 : 0;
  const pnl = target.reduce((s, r) => s + r.pnl, 0);
  const capital = target.reduce((s, r) => s + r.buy, 0);
  const roi = capital > 0 ? (pnl / capital) * 100 : 0;

  const sorted = [...target].sort((a, b) => a.closeTs - b.closeTs);
  let eq = 0,
    peak = 0,
    dd = 0;
  for (const r of sorted) {
    eq += r.pnl;
    if (eq > peak) peak = eq;
    dd = Math.max(dd, peak - eq);
  }
  const ddPct = peak > 0 ? (dd / peak) * 100 : 0;

  const durs = target
    .map((r) => r.dur)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const median = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
  const p90 = durs.length ? durs[Math.floor(durs.length * 0.9)] : 0;

  // Specialty = top category by trade count across ALL trades
  const catCounts = new Map<string, number>();
  for (const a of tokens.values()) {
    const c = classifyMarket(a.title);
    catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
  }
  const sortedCats = [...catCounts.entries()].sort((a, b) => b[1] - a[1]);
  const totalCats = [...catCounts.values()].reduce((s, x) => s + x, 0);
  const specialty = sortedCats[0]?.[0] ?? "other";
  const specialtyShare = totalCats ? (sortedCats[0][1] / totalCats) * 100 : 0;

  const topTitles = [...tokens.values()]
    .sort((a, b) => b.buy - a.buy)
    .slice(0, 3)
    .map((a) => a.title)
    .filter(Boolean);

  const composite = wr * Math.sqrt(Math.max(0, roi)) * (100 / (ddPct + 10));

  return {
    wallet,
    userName: lb.userName,
    lbCategoriesSeen: [...new Set(lb.entries.map((e) => e.category))],
    lbAppearances: lb.entries.length,
    lbMaxPnl: Math.max(...lb.entries.map((e) => e.pnl), 0),
    lbMaxVol: Math.max(...lb.entries.map((e) => e.vol), 0),
    totalTrades: trades.length,
    tradesPerDay30d: Number((t30 / 30).toFixed(2)),
    daysSinceLast: Number(daysSince.toFixed(1)),
    uniqueMarkets: tokens.size,
    resolvedPositions: target.length,
    wins,
    losses,
    trueWinRatePct: Number(wr.toFixed(1)),
    realizedPnlUsdc: Number(pnl.toFixed(0)),
    realizedRoiPct: Number(roi.toFixed(1)),
    maxDrawdownUsdc: Number(dd.toFixed(0)),
    maxDrawdownPctOfPeak: Number(ddPct.toFixed(1)),
    peakEquityUsdc: Number(peak.toFixed(0)),
    medianDurationHours: Number((median / 3600).toFixed(2)),
    p90DurationHours: Number((p90 / 3600).toFixed(2)),
    openPositions: openCount,
    specialtyCategory: specialty,
    specialtyShare: Number(specialtyShare.toFixed(1)),
    topTitles,
    compositeScore: Number(composite.toFixed(1)),
  };
}

async function main(): Promise<void> {
  console.error(
    `[v2] fetching ${CATEGORIES.length} cats × ${WINDOWS.length} windows × ${ORDER_BYS.length} rankings × top-${LEADERBOARD_TOP_N}`
  );
  const lbByWallet = new Map<
    string,
    { entries: LeaderboardEntry[]; userName: string }
  >();
  for (const c of CATEGORIES) {
    for (const w of WINDOWS) {
      for (const o of ORDER_BYS) {
        const entries = await fetchLeaderboard(c, w, o);
        for (const e of entries) {
          const cur = lbByWallet.get(e.proxyWallet) ?? {
            entries: [],
            userName: e.userName || "",
          };
          cur.entries.push(e);
          if (!cur.userName && e.userName) cur.userName = e.userName;
          lbByWallet.set(e.proxyWallet, cur);
        }
      }
    }
  }
  const wallets = [...lbByWallet.keys()];
  console.error(`[v2] universe: ${wallets.length} unique wallets`);

  console.error(`[v2] fetching trades...`);
  const allTrades = new Map<string, Trade[]>();
  const allCids = new Set<string>();
  let doneT = 0;
  const qT = [...wallets];
  async function tWorker() {
    while (qT.length) {
      const w = qT.shift();
      if (!w) return;
      const ts = await fetchTrades(w);
      allTrades.set(w, ts);
      for (const t of ts) allCids.add(t.conditionId);
      doneT++;
      if (doneT % 25 === 0)
        process.stderr.write(`    trades [${doneT}/${wallets.length}]\n`);
    }
  }
  await Promise.all(Array.from({ length: TRADE_CONCURRENCY }, tWorker));
  console.error(`[v2] unique conditionIds: ${allCids.size}`);

  console.error(`[v2] fetching markets with backoff...`);
  const markets = new Map<string, Market>();
  const cids = [...allCids];
  let doneM = 0;
  let imkt = 0;
  async function mWorker() {
    while (imkt < cids.length) {
      const idx = imkt++;
      const m = await fetchMarket(cids[idx]);
      if (m) markets.set(cids[idx], m);
      doneM++;
      if (doneM % 500 === 0)
        process.stderr.write(
          `    markets [${doneM}/${cids.length}] resolved=${markets.size}\n`
        );
    }
  }
  await Promise.all(Array.from({ length: CLOB_CONCURRENCY }, mWorker));
  console.error(
    `[v2] markets resolved: ${markets.size}/${cids.length} (${((markets.size / cids.length) * 100).toFixed(1)}%)`
  );

  const scores: WalletScore[] = [];
  for (const w of wallets) {
    const lb = lbByWallet.get(w);
    const ts = allTrades.get(w);
    if (!lb || !ts || ts.length === 0) continue;
    const s = computeScore(w, lb, ts, markets);
    if (s) scores.push(s);
  }

  const outPath = path.resolve(
    __dirname,
    "../../docs/research/fixtures/poly-wallet-screen-v2.json"
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        universeSize: wallets.length,
        marketsResolved: markets.size,
        marketsTotal: cids.length,
        scores,
      },
      null,
      2
    )
  );
  console.error(`[v2] wrote fixture: ${outPath}`);

  // Filters (same as v1 + active + sample floor)
  const FILTERS = {
    minTradesPerDay: 1,
    maxDaysSinceLast: 5,
    minResolvedPositions: 15,
    minWr: 55,
    minRoi: 15,
    maxMedianDurH: 9,
    maxDdPct: 30,
  };
  const pass = scores.filter(
    (s) =>
      s.tradesPerDay30d >= FILTERS.minTradesPerDay &&
      s.daysSinceLast <= FILTERS.maxDaysSinceLast &&
      s.resolvedPositions >= FILTERS.minResolvedPositions &&
      s.trueWinRatePct >= FILTERS.minWr &&
      s.realizedRoiPct >= FILTERS.minRoi &&
      s.medianDurationHours > 0 &&
      s.medianDurationHours <= FILTERS.maxMedianDurH &&
      s.maxDrawdownPctOfPeak <= FILTERS.maxDdPct
  );
  pass.sort((a, b) => b.compositeScore - a.compositeScore);

  console.log(
    `\n## v2 Screen — ${wallets.length}-wallet universe (8 cats × 3 windows × 2 rankings × top-${LEADERBOARD_TOP_N})\n`
  );
  console.log(
    `**Filters:** t/day≥${FILTERS.minTradesPerDay} · active≤${FILTERS.maxDaysSinceLast}d · resolved≥${FILTERS.minResolvedPositions} · WR≥${FILTERS.minWr}% · ROI≥${FILTERS.minRoi}% · median dur ≤${FILTERS.maxMedianDurH}h · DD ≤${FILTERS.maxDdPct}%\n`
  );
  console.log(`**Survivors:** ${pass.length}\n`);
  console.log(
    "| rank | wallet | name | specialty (share) | lb cats | t/day | resolved | WR | ROI | PnL | DD% | med dur | top market |"
  );
  console.log("|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (let i = 0; i < Math.min(pass.length, 20); i++) {
    const s = pass[i];
    const catStr = s.lbCategoriesSeen.slice(0, 3).join("/");
    const title = s.topTitles[0]?.slice(0, 36) || "";
    console.log(
      `| ${i + 1} | \`${s.wallet.slice(0, 10)}…\` | ${(s.userName || "-").slice(0, 16)} | ${s.specialtyCategory} (${s.specialtyShare}%) | ${catStr} | ${s.tradesPerDay30d} | ${s.resolvedPositions} | **${s.trueWinRatePct}%** | ${s.realizedRoiPct}% | $${(s.realizedPnlUsdc / 1000).toFixed(0)}k | ${s.maxDrawdownPctOfPeak}% | ${s.medianDurationHours}h | ${title} |`
    );
  }

  console.log(`\n## Top 20 by realized PnL regardless of filters\n`);
  const byPnl = [...scores]
    .filter((s) => s.resolvedPositions >= 10)
    .sort((a, b) => b.realizedPnlUsdc - a.realizedPnlUsdc)
    .slice(0, 20);
  console.log(
    "| wallet | name | specialty | lb cats | t/day | resolved | WR | ROI | PnL | DD% | notes |"
  );
  console.log("|---|---|---|---|---:|---:|---:|---:|---:|---:|---|");
  for (const s of byPnl) {
    const catStr = s.lbCategoriesSeen.slice(0, 3).join("/");
    const fails: string[] = [];
    if (s.tradesPerDay30d < FILTERS.minTradesPerDay) fails.push("slow");
    if (s.daysSinceLast > FILTERS.maxDaysSinceLast)
      fails.push(`cold(${s.daysSinceLast}d)`);
    if (s.resolvedPositions < FILTERS.minResolvedPositions)
      fails.push(`low-n(${s.resolvedPositions})`);
    if (s.trueWinRatePct < FILTERS.minWr)
      fails.push(`wr(${s.trueWinRatePct}%)`);
    if (s.realizedRoiPct < FILTERS.minRoi)
      fails.push(`roi(${s.realizedRoiPct}%)`);
    if (
      s.medianDurationHours === 0 ||
      s.medianDurationHours > FILTERS.maxMedianDurH
    )
      fails.push(`dur(${s.medianDurationHours}h)`);
    if (s.maxDrawdownPctOfPeak > FILTERS.maxDdPct)
      fails.push(`dd(${s.maxDrawdownPctOfPeak}%)`);
    const note = pass.includes(s) ? "✅ passes" : fails.join(",");
    console.log(
      `| \`${s.wallet.slice(0, 10)}…\` | ${(s.userName || "-").slice(0, 16)} | ${s.specialtyCategory} | ${catStr} | ${s.tradesPerDay30d} | ${s.resolvedPositions} | ${s.trueWinRatePct}% | ${s.realizedRoiPct}% | $${(s.realizedPnlUsdc / 1000).toFixed(0)}k | ${s.maxDrawdownPctOfPeak}% | ${note} |`
    );
  }
}

main().catch((e) => {
  console.error("[v2] unhandled:", e);
  process.exit(1);
});
