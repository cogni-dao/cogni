---
name: data-research
description: Standard for building Cogni research views — dashboard slices, wallet/market analytics, trader comparisons, P/L curves, bet histograms, anything that aggregates over `poly_trader_fills`, `poly_trader_position_snapshots`, `poly_market_outcomes`, or any other large operational table. Use this skill any time you are about to write a new database query that supports a research, dashboard, comparison, or analytics view — whether the user calls it a "research view", "comparison panel", "P/L tab", "histogram", "metric", "slice", "research tab", "dashboard chart", "scorecard", or anything similar. ALSO use this skill when migrating existing JavaScript-side aggregations to SQL, when investigating an OOM in any wallet/market/research read path, when reviewing PRs that add new SELECT queries against fills / snapshots / outcomes, when adding new entries to `/api/v1/poly/research/*`, when designing what goes on the Research tab, or when anyone proposes a `LIMIT N` band-aid on a fill-scanning query. Strongly prefer this skill — naively writing `db.select().from(polyTraderFills).where(...)` is the failure mode that produced bug.5012; this skill exists specifically to prevent that class of incident from recurring.
---

# data-research

Build research views that scale from one user to a million-fill wallet without OOMing the pod, without truncating the data, and without burning a per-query budget on naive scans.

## Why this skill exists

In bug.5012 (2026-05-05), poly prod OOM-crashlooped. Root cause was an unbounded `SELECT * FROM poly_trader_fills WHERE walletAddress = X ORDER BY observed_at` in `wallet-analysis-service.ts`. RN1's 800k-fill backfill put 250–400 MB of hydrated rows into V8, blew the heap, hard-crashed the pod, browser saw 502s.

The fix that landed was _not_ a `LIMIT N` band-aid — it was decomposing every metric in `computeWalletMetrics` into a SQL aggregation so V8 only ever sees ~14k unique-position rows regardless of fill count. That's the architecturally correct shape, and it's the standard this skill encodes.

The Research tab will host 100+ views over time (see the node repo's `app/src/app/(app)/research/`): target-overlap, P/L curves, fills histograms, USDC-flow, size-vs-P/L, trade-size distributions, entry-price quantiles, time-in-position, entries-by-outcome, hour-of-day, bets-per-market. Every one of those is an aggregation over millions of rows. **Every one of them must follow this skill or the next bug.5012 ships itself.**

## Core principle 1: dashboards read from our DB, never from upstream on render

`PAGE_LOAD_DB_ONLY` and `SAVED_FACTS_ONLY` are non-negotiable invariants on every research/dashboard route. A research-view request handler may **only** read from our own Postgres tables (`poly_trader_fills`, `poly_trader_position_snapshots`, `poly_trader_current_positions`, `poly_trader_user_pnl_points`, `poly_market_outcomes`, `poly_market_metadata`, `poly_market_price_history`, etc.). It must not fan out to Polymarket's CLOB, Data API, Gamma, or any other upstream during the render path.

Upstream is hit exactly once, in one place: the **trader-observation tick** (and adjacent ingestion jobs) that polls Polymarket on a schedule, persists the response, and exits. Everything else — every wallet drawer, every research panel, every comparison chart — reads the saved facts.

Why this rule:

- **Page latency is bounded by Postgres, not by Polymarket.** A flaky upstream can't 502 the dashboard. A slow upstream can't make page load take 8 seconds.
- **Per-render fan-out is a quadratic load source.** N concurrent users × M positions per page × upstream rate-limits = page rot. The observation tick polls once per N seconds for the wallet population, regardless of who's looking.
- **A single source of truth is auditable.** When a number on the page disagrees with another number, the question "did one of these reach upstream and the other didn't?" has a definitive answer: no, both came from the DB, so the divergence is a code bug we can localize.
- **The persisted payload often already contains what JS is about to derive.** When upstream returns a structured row (e.g., Polymarket `/positions` returns `cashPnl`, `percentPnl`, `redeemable`, `curPrice`), persist the full payload as `raw jsonb` and read fields back via `(raw->>'…')::type` instead of recomputing. JS-side derivation invents a metric; the persisted vendor field is the metric. (bug.5020 was exactly this failure: derived `currentValue − costBasis` instead of reading `raw->>'cashPnl'`.)

If a render-path read needs data we haven't persisted yet, the right answer is: **add a column or extend the observation writer**, then read from the DB. Never reach for an upstream client in a route handler "just this once."

The wallet-analysis services already encode this — every server-side service file has a `PAGE_LOAD_DB_ONLY` invariant in its module docstring. New services must do the same. Routes that violate it will fail review.

## Core principle 2: aggregations belong in SQL

Postgres can do every aggregation a JS reduce can do, against the indexed table, at constant memory cost. V8 cannot — every row crossing the wire becomes a hydrated object whose footprint is many times larger than the row's storage size.

The decision is not "add a LIMIT" or "bump the heap." The decision is **whether raw rows ever enter V8 at all**. The answer in a research view is: **only when the result set is bounded by something other than the fill count** (e.g., the ≤20 currently-open positions; the 30 days of a chart; the top 10 events).

If the cardinality of what you need scales with N (where N is fill count, market count, target-trade count), the work belongs in SQL.

## Core principle 3: name the metric you're querying — primitive vs decision-relevant

Many research questions look like "what's the pXX of swisstony's bets?" That phrasing hides a fork: there is a **primitive** (each individual fill's `size_usdc`, recorded in `poly_trader_fills`) and a **decision-relevant aggregate** (cumulative cost basis on a (token, side) position, recorded in `poly_trader_current_positions.cost_basis_usdc` and reflected in mirror logs as `target_token_cost_usdc`). They are not interchangeable. The dollar figures look similar in shape; they answer different questions.

- **Primitive (`poly_trader_fills.size_usdc`)** — descriptive of bet-shape behavior. "How big is each individual fill?" Useful for histograms of trade-size distribution, hour-of-day patterns, fill-size vs market-resolution analysis.
- **Decision-relevant (`poly_trader_current_positions.cost_basis_usdc` / log field `target_token_cost_usdc`)** — what bet-sizer-v1 and most other gates actually compare against. "How much capital has the target accumulated on this token-side?" Useful for filter-staleness checks, position-cap analysis, anything tied to a config knob in `copy-trade-mirror.job.ts`.

Before writing the query, ask: **does the comparison the dashboard makes use the primitive or the aggregate?** Read the relevant mirror code or log line — they make this explicit. If you compare a primitive percentile to a baseline that was captured against the aggregate, you will produce numbers that look credible (USD, similar magnitude) and are completely meaningless. bug.5034 (filed 2026-05-07, closed without action) was this exact failure: a 30,216-fill `size_usdc` distribution compared against a 1,085-position baseline, surfacing -73% to -80% drift that did not exist on the filter-relevant metric.

Where this matters in practice:

- `bet-sizer-v1` filter (`sizing_min_target_usdc` interpolated from `TOP_TARGET_SIZE_SNAPSHOTS`) compares to `target_token_cost_usdc` — **decision-relevant**.
- `mirror_max_usdc_per_trade` is a hard cap on our intent's `size_usdc` — **primitive**.
- "Trade size distribution" histograms on the Research tab — **primitive**.
- "Position size distribution" / cost-basis histograms — **decision-relevant**.

When in doubt, surface **both** and label which one drives the decision. Future agents should not have to redo the metric-shape analysis to know what they're looking at.

## KPIs the Research tab tracks

When a new research view ships, its purpose is usually to answer one of the questions below. If your view doesn't fit any of these, ask before building it — we may already have a better surface for it.

| KPI                                           | Source                                                                                              | What it answers                                                              | Invariant                                                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Decision coverage**                         | `count(poly_copy_trade_decisions) / count(poly_trader_fills)` per (target, hour)                    | "Did the mirror pipeline emit a decision for every observed target fill?"    | Should be ≈1.0 post bug.5032 cutover (2026-05-07 05:19 UTC). Sustained <0.95 is an ingestion regression.                                                            |
| **Placed-rate**                               | `count(decisions.outcome='placed') / count(decisions)` per (target, day)                            | "What fraction of emitted decisions resulted in a placed mirror order?"      | Health metric. Drops indicate filter or executor regression.                                                                                                        |
| **Skip-by-reason histogram**                  | `count(*) FILTER (WHERE outcome='skipped') GROUP BY reason` per (target, day)                       | "Why did we skip the rest?"                                                  | Use to surface filter staleness, layer-up blocking, hedge-leg gaps.                                                                                                 |
| **VWAP gap (us vs target)**                   | weighted avg of `price * size_usdc` per (token, side, wallet), see Recipe 4                         | "When we did mirror, did we pay materially worse?"                           | <2% absolute on the median market; >2% surfaces taxonomy mode 3.                                                                                                    |
| **Position cost-basis pXX (filter-relevant)** | `percentile_disc(*) on poly_trader_current_positions.cost_basis_usdc` per target                    | "Is the bet-sizer-v1 baseline still calibrated?"                             | Drift on each pXX < 25% vs frozen baseline (Recipe 5 threshold).                                                                                                    |
| **Fill size_usdc pXX (descriptive)**          | `percentile_disc(*) on poly_trader_fills.size_usdc` per target, time-windowed                       | "How is the target's bet shape evolving?"                                    | No invariant — purely descriptive. Always pair with the position-cost view above; never substitute for it.                                                          |
| **Already-resting hit-rate**                  | `count(*) FILTER (WHERE outcome='skipped' AND reason='already_resting') / count(decisions emitted)` | "How often does the dedupe gate block a layer-up?"                           | Tracks bug.5035 fix progress. Pre-fix this should be high on bursty markets; post-fix should approach the rate at which we genuinely have material covering orders. |
| **Realized P/L per market (us vs target)**    | `(s.raw->>'cashPnl')::numeric` from latest `poly_trader_position_snapshots` per (wallet, condition) | "Where did the leak land in real cash terms?"                                | Used to rank alpha-leak markets. Drives the dated `/research/<date>` report cadence.                                                                                |
| **Cost-basis ratio (us/target)** per market   | `our.cost / their.cost` per condition                                                               | "How much smaller are we sized than the target?"                             | Defines the floor on capturable edge — a 1000× ratio means we capture ≤0.1% even on a perfect mirror.                                                               |
| **Coverage-gap by reason**                    | Recipe 6 — per-market histogram                                                                     | "Of the fills the mirror missed, was it never_emitted, errored, or skipped?" | Diagnoses taxonomy mode 2 vs others on a single market.                                                                                                             |

If a metric a research view depends on isn't in this table, write down which question it answers in the page's module docstring, and consider whether it deserves promotion here. If two views depend on the same metric, define the SQL once and reuse — don't reinvent the aggregation per page.

## Persisting research as knowledge

A research view's dashboard answers "what is the state now?" The harder question — "is it better than yesterday, and which fix moved it?" — needs a durable record of past runs. That record's home is the per-node `knowledge` table on Doltgres: `entry_type ∈ {scorecard, rule, finding}`, `confidence_pct`, citation DAG, `draft → candidate → established → canonical` status promotion. The HTTP wrapper for internal writes is **in design** (PR #1133) — once landed, agents call `core__knowledge_write` (direct to `main` for internal callers) or `POST /api/v1/knowledge/contributions/*` (branch-per-PR with diff/merge for reviewed entries). Corpus-as-knowledge (PR #1175) adds the `work_item_artifacts` join from scorecard rows → bugs/tasks/spikes.

**Until that lands, persistence is markdown on disk** — `docs/research/<date>-<skill>.md` for scorecards, `nodes/<node>/app/src/app/(app)/research/<date>/page.tsx` for dated dashboard reports. Shape each markdown to match the future row so the migration is mechanical:

| Knowledge row field   | Markdown convention                                                                   |
| --------------------- | ------------------------------------------------------------------------------------- |
| `domain`              | path segment or frontmatter (`poly_delta_minimizer`, `alpha_leak`, …)                 |
| `entry_type`          | `scorecard` / `rule` / `finding` in title or frontmatter                              |
| `confidence_pct`      | implicit 40 (draft) until promoted; surface in title when raised                      |
| `tags`                | hashtag list at end of doc                                                            |
| `citations`           | inline `[supersedes](path)` / `[cites](path)` markdown links (knowledge ↔ knowledge) |
| `work_item_artifacts` | inline `bug.NNNN` / `task.NNNN` / `spike.NNNN` references (knowledge → work item)     |

Once the API lands, two flows route differently:

- **`scorecard`** (high-frequency, append-only): internal `core__knowledge_write` direct to `main`. No review.
- **`rule` + `finding`** (decision-shaping): external-contribution flow with diff/merge gates.

Do not wait — write markdown today. The future migration is a `git ls-files docs/research/*.md | …` walk; the structured-frontmatter convention is the contract.

### What each entry type captures

- **`scorecard`** — one per loop tick (`/delta-minimizer` run, `/validate-candidate` matrix). Matrix + raw inputs + verdict. Δ-vs-prev computed by reading the previous scorecard in the same domain.
- **`rule`** — a strategy or invariant ("if `mirror.dropped` count rises across 3 consecutive tick scorecards, escalate to bug"). Promotes 40 → 60 → 80 → 95 as scorecards confirm. Superseded versions stay (with a `supersedes` citation) — never overwrite, never delete.
- **`finding`** — a root-cause memo written when an `unattributed` spike resolves. Cites the spike, the merged PR, and the first scorecard where the bucket dropped to zero.

### Loop persistence pattern (deterministic, zero LLM cost)

```
on each tick:
  1. read live state (DB queries per Core principles 1+2)
  2. classify outliers via taxonomy → matrix
  3. read prior scorecard (file glob today; knowledge_search post-API)
  4. compute Δ-vs-prev columns
  5. write scorecard markdown (file today; knowledge_write post-API)
  6. for each unattributed → file spike via operator work-items API
  7. for active buckets trending up → PATCH heartbeat on tracking item
  8. if a rule's last 3 scorecards confirm bucket flat/shrinking → write a superseding rule at +20 confidence
```

The taxonomy is deterministic; the markdown is a heredoc. LLM cycles enter only when `/triage` picks up an unattributed spike.

## The pattern

For every research view, follow this sequence. Don't skip steps; the order matters.

### 1. Decompose the output into named aggregates

Look at the data shape your view returns. Every field is either:

- **A constant-cardinality aggregate** — `count(*)`, `sum(...)`, `avg(...)`, `max(...)`, `count(distinct ...)`. One number. Always SQL.
- **A bounded-row aggregate** — top-N, GROUP BY day/hour/event, histogram buckets. Bounded by an axis size, not by N. Always SQL.
- **A small per-entity rollup** — one row per (wallet, market) or per (token, condition). Bounded by the unique-entity count, which for our domain is tens of thousands at most. SQL.
- **A bounded set of detail rows** — the 20 open positions, the 200 most-recent trades for a paginated view. Bounded by a UI cap, not by N. Either a SQL `LIMIT` (cursor-paginated) or a SQL `IN (...)` against a small driver set.

If a field doesn't fit one of these four buckets, you are either computing the wrong thing or you need to think harder about what shape it actually has. Don't punt to "load all rows and reduce in JS."

### 2. Write the SQL aggregates first

Before writing any TypeScript, write the SQL. One query per aggregate group, joined where it makes sense, but **never one query that returns more than the bounded result set**. Use Postgres features liberally — they exist for this:

| Need                 | SQL form                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| Counts by day        | `date_trunc('day', observed_at) GROUP BY 1`                             |
| Histogram buckets    | `width_bucket(value, lo, hi, n) GROUP BY`                               |
| Per-position rollup  | `GROUP BY (token_id, condition_id)` with conditional aggregates         |
| Top-N                | `ORDER BY count DESC LIMIT 10`                                          |
| Quantiles            | `PERCENTILE_DISC` or `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ...)` |
| Conditional counts   | `count(*) FILTER (WHERE status = 'pending')`                            |
| Two-table comparison | one query joining both, never two queries reduced in JS                 |
| Time-windowed slice  | `WHERE observed_at >= now() - interval '30 days'`                       |

### 3. EXPLAIN every query against worst-case data

Worst case in our world today is RN1's ~825k fills (or whatever has replaced it as the largest target). Run `EXPLAIN ANALYZE` against candidate-a's data, capture the plan, attach to the PR. What you're looking for:

- **Sort over the full table.** If the plan shows `Sort (rows=825K)` and the query result is small, you're missing an index or a `WHERE` push-down.
- **Sequential Scan when an index exists.** Sometimes pg ignores the index for cardinality reasons; other times the WHERE clause prevents index usage.
- **Hash Aggregate over millions.** Generally fine — `GROUP BY` over a full table scan with hash aggregation is what we want; it's V8 hydration that's expensive, not Postgres aggregation.
- **Latency budget: 200ms p95 on candidate-a's worst-case wallet.** If a query exceeds that, fix it before the PR merges. A research view that takes 5s to render isn't research, it's a timeout.

The EXPLAIN output goes in the PR description, not just in a comment. Future agents reviewing the PR shouldn't have to re-derive the plan to know it was checked.

### 4. Wrap multi-query bundles in a transaction

If a single research view emits multiple SQL queries (typical for histogram + summary combos), wrap them in a single transaction so they share a snapshot:

```ts
return db.transaction(async (tx) => {
  const histogram = await readHistogram(tx, addr);
  const summary = await readSummary(tx, addr);
  return { histogram, summary };
});
```

Without this, a fill landing mid-bundle gives you "the histogram counts don't sum to the summary total." The bug looks like a math error, the cause is read-skew, and you'll spend hours chasing the wrong thing. Wrap the txn — it's free and saves an incident.

### 5. Build a parity oracle when migrating from JS

When replacing a JS-side aggregation with SQL (the bug.5012 pattern), do _not_ just delete the JS function. Build a parameterized parity test:

```ts
describe.each(generateSyntheticWallets())(
  "wallet-analysis SQL parity",
  (wallet) => {
    it("SQL output equals JS output for every metric", async () => {
      const fromJs = computeWalletMetrics(wallet.fills);
      const fromSql = await readWalletMetricsFromDb(testDb, wallet.addr);
      expect(fromSql).toEqual(fromJs);
    });
  }
);
```

The synthetic generator must include **boundary cases**: a wallet with 0 fills, a wallet with 1 fill, fills exactly on histogram bucket edges (`x=0`, `x=999.9999`, `x=1000`, `x=1000.0001`), fills at midnight UTC and one second before, percentile inputs that match `PERCENTILE_DISC` exactly and ones that need interpolation. **Off-by-one bugs at bucket edges will only surface here.** RN1's organic data will paper over them in production for months and then a single screenshot will catch it.

Once parity is proven on synthetic data, run the parity check once on real candidate-a data (RN1, swisstony, a tenant) as smoke. Then it's safe to delete the JS path — but only then.

### 6. Preserve percentile method

Postgres has two percentile functions and they are not interchangeable:

- `PERCENTILE_CONT(0.5)` — linear interpolation between the two middle values. Matches typical "median = average of two middle values" semantics. Use this when migrating from `lodash.median`-style JS.
- `PERCENTILE_DISC(0.5)` — nearest-rank, returns an actual value from the set. Use this when the JS source returns "an actual element."

When migrating, **read the existing JS implementation first** to determine which method matches. Silently swapping `_CONT` for `_DISC` is the kind of metric drift that gets noticed three months later when a number doesn't match a screenshot.

### 7. Wire to the research tab

Research views land at:

- **HTTP**: `<node-repo>/app/src/app/api/v1/<node>/research/<view>/route.ts` — Zod-validated request + response, partial-failure-returns-200-with-warnings semantics (see `trader-comparison/route.ts` for the canonical shape).
- **Contract**: `<node-repo>/packages/node-contracts/src/<node>.research-<view>.v1.contract.ts` — request + response Zod schemas. **Always v1; never re-version unless we have users.**
- **Service**: `<node-repo>/app/src/features/research/server/<view>-service.ts` (mirror of `features/wallet-analysis/server/`). The SQL-aggregated readers live here; the route is a thin handler.
- **UI**: `<node-repo>/app/src/app/(app)/research/` — the Research page tabs. Each new view is a tab.

The Research tab pattern is **comparative + time-windowed**: most views show 2–3 wallets side-by-side over a 1D / 1W / 1M / ALL window. Design your SQL with this in mind: a `wallet_id IN ($1, $2, $3)` filter and a `WHERE observed_at >= $window_start` clause are virtually guaranteed inputs.

### 8. Avoid the band-aids you'll be tempted to use

| Band-aid                                                 | Why it's wrong                                                                                           | Real fix                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Call Polymarket (CLOB / Data API / Gamma) from a route   | Violates `PAGE_LOAD_DB_ONLY`. Couples page latency + uptime to a vendor. Per-user fan-out scales badly.  | Persist via observation tick, read DB.                             |
| Re-derive a metric the vendor already returns            | If `cashPnl`, `redeemable`, `curPrice`, etc. are in the response, derivation invents drift (bug.5020).   | Persist full payload as `raw jsonb`, read `(raw->>'field')::type`. |
| `.limit(N)` on raw fills                                 | Silently truncates power-traders to most-recent-N. Defeats the backfill goal.                            | SQL aggregation.                                                   |
| `--max-old-space-size` bump                              | Buys a quarter-decade. Next backfill breaks.                                                             | SQL aggregation.                                                   |
| Streaming pg cursor + JS fold                            | Works for sums; breaks on quantiles, sorts, medians. Same byte cost.                                     | SQL aggregation.                                                   |
| Pre-aggregate to per-position synthetic rows then run JS | Bypasses dailyCounts, tradesLast30 — still need SQL for those. More code, no win.                        | SQL aggregation, fully.                                            |
| Cache the aggregate result client-side or in Redis       | Adds invalidation as a new bug class. The query is fast in SQL — cache only when EXPLAIN says you can't. | EXPLAIN first; cache only as proven need.                          |
| Bump container Tier                                      | See heap bump.                                                                                           | SQL aggregation.                                                   |

If you find yourself reaching for any of these without first writing the SQL aggregation, stop. The SQL is almost always shorter and always more correct.

## Validation checklist (runs in PR)

Before opening a research-view PR, the author confirms:

- [ ] **No upstream call on the render path.** Route handler imports only DB-reading services. No CLOB / Data-API / Gamma client appears in the import graph reachable from the route. Module docstring carries `PAGE_LOAD_DB_ONLY` (and `SAVED_FACTS_ONLY` if the data is observed).
- [ ] **Vendor-published metrics are read, not re-derived.** If the field exists in the persisted `raw` payload, the SQL extracts it (e.g., `(raw->>'cashPnl')::numeric`) instead of computing a substitute.
- [ ] No raw-row read whose cardinality scales with N reaches V8.
- [ ] EXPLAIN ANALYZE captured for each new query against worst-case wallet (currently RN1 ~825k fills); plan and total-runtime in PR body.
- [ ] Each new query under 200ms p95 against that worst case.
- [ ] Multi-query bundles wrapped in `db.transaction(...)`.
- [ ] If migrating from JS: parameterized parity test with boundary cases (zero rows, single row, bucket edges, percentile inputs that need interpolation, midnight-UTC time boundaries).
- [ ] If using percentiles: explicit choice of `PERCENTILE_CONT` vs `PERCENTILE_DISC`, with comment justifying which matches the JS source.
- [ ] Zod contract for request + response, with `(time_window, [wallet_addrs])` as standard input shape.
- [ ] Partial-failure path returns 200 with warnings, never throws to the user.
- [ ] Loki observability: emits `feature.poly_research.<view>.complete` with `status=ok|warn|error` and `latencyMs`.

## When to load this skill

- Adding any new view under `app/(app)/research/` or `app/api/v1/poly/research/`
- Adding any new aggregate to `wallet-analysis-service.ts` or any feature-service that reads `poly_trader_fills`, `poly_trader_position_snapshots`, `poly_copy_trade_fills`, `poly_market_outcomes`
- Reviewing a PR that adds a new SELECT against a 100k-plus-row table
- Reviewing a PR that imports a Polymarket / CLOB / Data-API / Gamma client from anywhere reachable by a route handler — `PAGE_LOAD_DB_ONLY` is the load-bearing rule
- Considering a derived metric (`currentValue − costBasis`, hand-rolled win-rate, JS-side P/L roll-up) when the vendor already publishes the field in a payload we persist
- Migrating existing JS-side aggregation to SQL
- Investigating an OOM whose stack trace ends in V8 row hydration
- Investigating any divergence between two PnL/notional/count numbers shown on the same page (mismatched sources is the antipattern)
- Anyone proposing a `LIMIT N` cap as a "fix" for an OOMing read path
- Designing a new comparison / scorecard / chart view, regardless of how the user phrases the request

## Recipes (reusable agent loops)

Recurring research investigations live as recipe files in `.claude/skills/data-research/recipes/`. Each recipe is a single self-contained markdown file with: a stack-ranked taxonomy of the failure modes it diagnoses, a small set of bounded SQL queries (≤200 rows out, no V8 hydration), and a playbook prescribing the order to run them. Load the recipe, run the queries via `scripts/grafana-postgres-query.sh`, emit a scorecard.

| Recipe                        | When to load                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `recipes/alpha-leak-debug.md` | An "alpha leak" market is visible on the dashboard's Markets tab and someone asks "why is target ahead of us on this market?" |

Add a new recipe when a debugging path has been walked twice. The bar is reuse, not novelty — one-off investigations stay in the conversation. Recipes that don't change the underlying data model belong here, not as new endpoints.

## Reference incidents and patterns

- **bug.5012** — poly prod OOM crashloop. Reading `wallet-analysis-service.ts:readDbFillsAsOrderFlowTrades` against RN1's 825k-fill backfill (spike.5024) blew the heap. Fix: SQL aggregation per `computeWalletMetrics` field, no raw fills in V8.
- **PR #1257** (`cc0e70fe8`) — heap-bump + `pLimit(4)` cap on the redeem-catchup boot loop. Stops a _different_ OOM (boot-fan-out), not the read-path one. Sometimes both apply; they're orthogonal.
- **`docs/research/nextjs-node-memory-sizing.md`** — Tier 0/1 sizing standard. Useful background but **not a substitute for SQL aggregation**. Tier 1 buys ~3× the heap; one big SELECT eats it.
- **`features/wallet-analysis/server/wallet-analysis-service.ts`** — the canonical "before" (V8 reduce) and "after" (SQL aggregate) example once the SQL refactor lands.
- **`app/api/v1/poly/research/trader-comparison/route.ts`** — canonical research-route shape (Zod, partial-failure-200, service-DB delegation).

## Out of scope

- **OLAP / data-warehouse offload.** When research traffic genuinely outgrows OLTP capacity, the answer is materialized views or a read replica — not yet, but don't be surprised when this skill grows a section on that.
- **Real-time streaming aggregates.** Today's research is on-demand-aggregate-from-source. Live streaming to the UI (websockets pushing updates as new fills land) is a separate problem that earns its own skill when it arrives.
- **Cross-node research.** Querying two nodes together is x402 territory, not in this skill.
