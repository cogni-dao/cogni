# Alpha-leak debug — agent recipe pack

> When the operator dashboard's **Markets** tab (`MarketsTable.tsx`, server-pivoted in `nodes/poly/app/src/features/wallet-analysis/server/market-exposure-service.ts`) flags a market where targets beat us by ≥5pp on a position with positive dollar gap, this recipe walks the per-fill diff and **classifies why**. The Markets tab tells you _which_ market leaked. This pack tells you _why it leaked_ and _what to fix_.

## Discrepancy taxonomy (stack-ranked by P/L impact)

For any one alpha-leak market, walk this list in order. The first hit is usually the dominant cause; classify against later modes only if upstream modes are clean.

| #   | Mode                     | One-line                                                                                               | Detect with                                                          |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1   | **Wrong side**           | We landed on the opposite outcome token of the same condition — opposite P/L sign                      | Recipe 3                                                             |
| 2   | **Coverage gap**         | They fired N fills; we fired <N (skipped/errored/not-fired)                                            | Recipe 6                                                             |
| 3   | **VWAP gap**             | Same side + same token, but our entry price is materially worse                                        | Recipe 4                                                             |
| 4   | **Size cap asymmetry**   | They sized $5k, we capped at $5 — bounded edge, not a bug per se                                       | Recipe 4 (size_ratio col)                                            |
| 5   | **Timing lag**           | We filled later, price moved against us                                                                | Recipe 2 (`our_lag_s`)                                               |
| 6   | **pXX filter staleness** | Hardcoded p50/p75/p90/p95/p99 in `bet-sizer-v1` no longer matches the live distribution → wrong filter | Recipe 5                                                             |
| 7   | **Exit asymmetry**       | They SELL to close; we hold (or vice versa)                                                            | Recipe 2 (filter side='SELL')                                        |
| 8   | **Hedge mismatch**       | They hold offsetting legs across tokens; we mirrored only one                                          | Recipe 3 (compare net positions across both tokens of the condition) |

**Hardcoded pXX baseline** (from `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts`, captured 2026-05-03):

- RN1: p95 ≈ $51,811, p99 ≈ $300,659
- swisstony: p95 ≈ $7,394, p99 ≈ $9,809

Recipe 5 compares those numbers to the _current_ distribution.

## Pre-reqs

- `scripts/grafana-postgres-query.sh` works (`https://cognidao.org/knowledge/grafana-postgres-readonly`).
- Source `.env.cogni` + `.env.<env>` first; the recipes default to `--env candidate-a --node poly` but the helper accepts any env.
- `poly_copy_trade_attribution` is intended to back recipes 2 + 4 once the writer ships. Until then, the recipes derive the same fields directly from `poly_trader_fills` + `poly_copy_trade_decisions` + `poly_copy_trade_fills`. When attribution is populated, the agent prefers `poly_copy_trade_attribution` (it carries pre-computed `target_vwap` / `cogni_vwap`).

## Recipes

### Recipe 1 — Top alpha leaks (entry point)

Mirrors the **alpha-leak** filter in `MarketsTable.tsx:74-78` (`rateGapPct >= 0.05` AND `sizeScaledGapUsdc > 0`). Returns ≤10 rows.

```sql
-- recipes/sql/alpha-leaks.sql
-- Inputs: $1 = our_wallet_label (e.g. 'Tenant trading wallet'), $2 = lookback days (default 7)
with our_w as (select id from poly_trader_wallets where label = $1 limit 1),
     target_w as (select id, label from poly_trader_wallets where kind='copy_target')
select
  f.condition_id,
  m.title,
  -- size-scaled dollar gap = (target_return - our_return) * our_value_at_stake
  sum(case when f.trader_wallet_id = (select id from our_w) then f.size_usdc else 0 end)::numeric(20,2) as our_value_usdc,
  -- placeholder return calculations; the canonical math lives in market-return-math.ts
  count(*) filter (where f.trader_wallet_id = (select id from our_w))::int as our_fills,
  count(*) filter (where f.trader_wallet_id in (select id from target_w))::int as target_fills,
  string_agg(distinct tw.label, ',') filter (where tw.kind='copy_target') as targets
from poly_trader_fills f
join poly_trader_wallets tw on tw.id = f.trader_wallet_id
left join poly_market_metadata m on m.condition_id = f.condition_id
where f.observed_at >= now() - make_interval(days => $2)
group by 1, 2
having count(*) filter (where f.trader_wallet_id in (select id from target_w)) > 0
order by our_value_usdc desc nulls last
limit 10;
```

> ⚠️ The exact "alpha-leak" gap math (rate-of-return × size-scaled dollar gap) is canonical in `market-return-math.ts` + `market-exposure-service.ts:buildMarketExposureGroups`. For high-fidelity ranking, hit the existing `/api/v1/poly/research/market-exposure` endpoint instead of re-deriving here. **Use this SQL only when the endpoint is unavailable** (e.g. Loki-only debugging from a shell). Keep one source of truth for the gap formula.

### Recipe 2 — Per-fill diff for one condition

Side-by-side timeline of swisstony's fills, our matched decisions, and our matched fills. ≤200 rows for any single market.

```sql
-- recipes/sql/per-fill-diff.sql
-- Inputs: $1 = condition_id, $2 = target_label ('swisstony' | 'RN1'), $3 = our_label
with target_fills as (
  select f.id, f.observed_at, f.token_id, f.side, f.price, f.size_usdc, f.shares, f.native_id
  from poly_trader_fills f
  join poly_trader_wallets tw on tw.id = f.trader_wallet_id
  where tw.label = $2 and f.condition_id = $1
),
our_decisions as (
  select d.fill_id, d.outcome, d.reason, d.decided_at,
         (d.intent->>'mirror_usdc')::numeric as intended_usdc,
         (d.intent->>'fill_price_target')::numeric as price_target
  from poly_copy_trade_decisions d
  where d.fill_id in (select native_id from target_fills)
),
our_fills as (
  select cf.fill_id, cf.observed_at, cf.status,
         (cf.attributes->>'limit_price')::numeric as our_price,
         (cf.attributes->>'size_usdc')::numeric as our_size_usdc
  from poly_copy_trade_fills cf
  where cf.fill_id in (select native_id from target_fills) and cf.status = 'filled'
)
select
  tf.observed_at as their_t,
  tf.side, tf.price as their_px, tf.size_usdc as their_usdc, tf.shares as their_shares,
  od.outcome, od.reason,
  od.price_target,
  of.our_price, of.our_size_usdc,
  -- diagnostic columns
  case when of.our_price is not null then round((of.our_price - tf.price)::numeric, 4) end as vwap_gap,
  case when of.our_size_usdc is not null then round((tf.size_usdc / nullif(of.our_size_usdc,0))::numeric, 1) end as size_ratio,
  case when of.observed_at is not null then extract(epoch from (of.observed_at - tf.observed_at))::int end as our_lag_s,
  tf.token_id
from target_fills tf
left join our_decisions od on od.fill_id = tf.native_id
left join our_fills of on of.fill_id = tf.native_id
order by tf.observed_at;
```

### Recipe 3 — Side / token check (taxonomy modes 1 + 8)

Per-token net position for both wallets on one condition. If `(target_net_shares > 0)` and `(our_net_shares > 0)` are on different `token_id`s, we're holding the wrong outcome.

```sql
-- recipes/sql/side-check.sql
-- Inputs: $1 = condition_id, $2 = target_label, $3 = our_label
select
  tw.label,
  f.token_id,
  count(*)::int as fills,
  sum(case when f.side='BUY' then f.shares else -f.shares end)::numeric(20,4) as net_shares,
  sum(case when f.side='BUY' then f.size_usdc else -f.size_usdc end)::numeric(20,2) as net_usdc,
  min(f.observed_at) as first_t,
  max(f.observed_at) as last_t
from poly_trader_fills f
join poly_trader_wallets tw on tw.id = f.trader_wallet_id
where f.condition_id = $1 and tw.label in ($2, $3)
group by tw.label, f.token_id
order by tw.label, abs(net_usdc) desc;
```

Hedge-mismatch (mode 8) reads from the same output: if target has non-zero `net_shares` on **both** tokens of the condition (an explicit hedge) and we don't, that's the leak.

### Recipe 4 — VWAP comparison (taxonomy mode 3)

Time-weighted entry-price diff per (wallet, token, side). Uses `size_usdc` as the weight, matching how `poly_copy_trade_attribution.target_vwap` / `cogni_vwap` are intended to be computed.

```sql
-- recipes/sql/vwap-compare.sql
-- Inputs: $1 = condition_id, $2 = target_label, $3 = our_label, $4 = lookback days
select
  tw.label,
  f.token_id,
  f.side,
  count(*)::int as fills,
  (sum(f.price * f.size_usdc) / nullif(sum(f.size_usdc), 0))::numeric(8,4) as vwap,
  sum(f.size_usdc)::numeric(20,2) as total_usdc
from poly_trader_fills f
join poly_trader_wallets tw on tw.id = f.trader_wallet_id
where f.condition_id = $1
  and tw.label in ($2, $3)
  and f.observed_at >= now() - make_interval(days => $4)
group by tw.label, f.token_id, f.side
order by f.token_id, f.side, tw.label;
```

Pivot the output mentally: for each `(token, side)`, compare target VWAP vs our VWAP. >2% absolute diff is taxonomy mode 3.

### Recipe 5 — Current pXX vs hardcoded filter (taxonomy mode 6)

Computes the live percentile distribution of `cost_basis_usdc` for one target's open positions, against the values frozen in `bet-sizer-v1`.

```sql
-- recipes/sql/current-pxx.sql
-- Inputs: $1 = target_label
with positions as (
  select cost_basis_usdc::numeric
  from poly_trader_current_positions cp
  join poly_trader_wallets tw on tw.id = cp.trader_wallet_id
  where tw.label = $1 and cp.active and cp.cost_basis_usdc > 0
)
select
  count(*)::int as positions,
  percentile_disc(0.50) within group (order by cost_basis_usdc)::numeric(20,2) as p50,
  percentile_disc(0.75) within group (order by cost_basis_usdc)::numeric(20,2) as p75,
  percentile_disc(0.90) within group (order by cost_basis_usdc)::numeric(20,2) as p90,
  percentile_disc(0.95) within group (order by cost_basis_usdc)::numeric(20,2) as p95,
  percentile_disc(0.99) within group (order by cost_basis_usdc)::numeric(20,2) as p99,
  max(cost_basis_usdc)::numeric(20,2) as max
from positions;
```

`PERCENTILE_DISC` is chosen to match the JS percentile semantics in `plan-mirror.ts` (returns an actual element from the set). Compare to the hardcoded snapshot values in `copy-trade-mirror.job.ts`. Drift >25% on any percentile → mirror filter is mis-tuned.

### Recipe 6 — Coverage gap by reason (taxonomy mode 2)

For one market, _why_ did we miss the fills we missed?

```sql
-- recipes/sql/coverage-gap.sql
-- Inputs: $1 = condition_id, $2 = target_label
with target_fills as (
  select f.native_id
  from poly_trader_fills f
  join poly_trader_wallets tw on tw.id = f.trader_wallet_id
  where tw.label = $2 and f.condition_id = $1
)
select
  coalesce(d.outcome, 'no_decision') as outcome,
  coalesce(d.reason, 'never_emitted') as reason,
  count(*)::int as n
from target_fills tf
left join poly_copy_trade_decisions d on d.fill_id = tf.native_id
group by 1, 2
order by n desc;
```

Output is a small histogram: `placed/ok | error/placement_failed | skipped/below_target_percentile | skipped/position_cap_reached | no_decision/never_emitted`, etc. The dominant row is the dominant fix.

## Playbook (the recurring loop)

```
For each session driven by an alpha leak surfaced on the Markets tab:

1. Run Recipe 1 (or hit /api/v1/poly/research/market-exposure?alpha_leak=true).
   Output: top-10 leaking markets. Pick row 1 (or the row Derek calls out).

2. Run Recipe 2 with that condition_id. Read the timeline.
   Eyeball-gate: are most rows (outcome=error reason=placement_failed)?
   → Mode 2 dominant. The "fix" is operational (creds rotation), not an algo change.
   Stop here, log finding, move on.

3. Otherwise classify against the taxonomy in order. For each mode you suspect:
   - Mode 1/8: run Recipe 3.
   - Mode 3/4: run Recipe 4 (and read size_ratio + vwap_gap from Recipe 2).
   - Mode 5: read our_lag_s in Recipe 2; >30s on the median = mode 5.
   - Mode 6: run Recipe 5; >25% drift on any pXX = mode 6.
   - Mode 7: filter Recipe 2 to side='SELL'; if target SELLs and we have no
     'sell_close' decisions, mode 7.

4. Emit a 6-line scorecard:
     market    : <title> (<condition_id>)
     their pnl : $<X> realized + $<Y> open
     our pnl   : $<X> realized + $<Y> open  (gap = $<Z>)
     dom mode  : <#: name>            ← from taxonomy
     evidence  : <one-line, e.g. "39/40 fills outcome=error reason=stale_api_key">
     fix class : <ops | algo | filter | scope>

5. If the same dom_mode hits ≥3 of the top-10 alpha leaks, escalate:
   it's systemic, not market-specific. File one bug at the systemic level,
   not one bug per market.
```

## When to load this skill recipe

- An "alpha leak" is visible on the Markets tab and Derek (or another agent) asks "why?"
- A research session needs to answer **"is the gap between target P/L and our P/L driven by execution, sizing, filtering, or selection?"**
- Tuning `mirror_filter_percentile` or `mirror_max_usdc_per_trade` — Recipes 4 + 5 are the data inputs.
- Reviewing whether `poly_copy_trade_attribution` is being populated correctly (Recipe 2 should match its `target_vwap` / `cogni_vwap` once the writer ships).

## Out of scope

- Market resolution / outcome-based P/L attribution → use `market-outcome-service.ts` + `poly_market_outcomes` directly. This pack is about **per-fill** discrepancy, not **post-resolution** P/L reconciliation.
- Cross-target overlap (RN1 ∩ swisstony) → `target-overlap-service.ts` already covers it.
- Streaming / real-time alerts on alpha leaks → P4 (task.0322); not this pack.
