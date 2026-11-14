---
name: delta-minimizer
description: "Investigate ONE specific discrepancy between our wallet's position and a copy-trade target's position on Polymarket. Use whenever the user says 'why are we on the wrong side', 'why is our VWAP off', 'why didn't we mirror that fill', 'delta on market X', 'minimize delta', 'investigate copy-trade gap', '/delta-minimizer', or points at a single market/event on the dashboard and asks what happened. The copy-trade algorithm is known to have fundamental bugs; the skill's job is to find ONE bug, prove it with cited evidence, and stop."
---

# Δ-Minimizer

We copy-trade a target wallet (e.g. `swisstony`) on Polymarket. Our positions should match theirs. Every divergence is a bug. The algorithm has known fundamental issues — your job is to find ONE, prove it, file it, move on.

## Required reading BEFORE you query anything

You are expected to already understand the system. If you don't, read these — they are short and load-bearing:

- `https://poly.cognidao.org/knowledge/poly-copy-trade-pipeline` — mirror-side rules, decision-ledger contract, `MirrorPositionView` (per-condition cache; `our_token_id` = OUR dominant side), error codes, lifecycle, sizing surfaces. **Branch decision (post-bug.5048) is target-dominance-driven** — see the "Branch decision" table + skip-precedence + `TARGET_DOMINANCE_DRIVES_BRANCH` / `NEVER_PAY_ABOVE_TARGET_VWAP` / `NO_SELL_IN_MIRROR` / `OPTION_C_TOLERATES_MULTI_TARGET` invariants. When investigating wrong-side / wrong-size Δ, always check `state.target_position` side fractions, not just our position. The dashboard reads `current-position-read-model.ts` (chain-classified by `poly_market_outcomes`), NOT `MirrorPositionView` — never claim UI behavior without verifying the actual read model.
- `https://poly.cognidao.org/knowledge/poly-tenant-wallet-authorization` — per-tenant wallets, USDC.e (deposit) vs pUSD (the ONLY currency the CLOB spends), `authorizeIntent` pre-place gate (grants/caps, NOT balance), v0 default caps. `errorCode=insufficient_balance` ≠ "we ran out of money"; it specifically means the wallet has USDC.e but not pUSD (TEN:712).
- `nodes/poly/app/src/features/copy-trade/plan-mirror.ts` + `types.ts` — the `MirrorReason` enum (`below_target_percentile`, `followup_position_too_small`, `position_cap_reached`, `already_resting`, `layer_scale_in`, `target_dominant_other_side`, `vwap_floor_breach`, etc.) is in code, not the spec. `decideMirrorBranch` + `analyzeTargetDominance` + `targetVwapForToken` are the load-bearing helpers.

Canonical CLOB `errorCode` enum (EXEC:693): `insufficient_balance | insufficient_allowance | stale_api_key | invalid_signature | invalid_price_or_tick | below_min_order_size | empty_response | http_error | unknown`.

## Discipline (read this twice)

1. **One discrepancy per pass.** Not three. Not a top-K list. The user names ONE market, ONE token, ONE side — you investigate that. If they hand you several, ask which one first.
2. **Every claim must be backed by a specific DB row or a specific Loki log line, pasted in your response.** No "likely cause." No "probably." No agent-summarized narrative — those hallucinate conditionIds and event titles. If you can't paste the evidence, you don't make the claim.
3. **Verify the basics before theorizing.** Confirm the conditionId. Confirm the tokenId. Confirm whose wallet. Confirm timestamps.
4. **Drive through to logs in the same pass — never stop on a Postgres-only read.** Decision rows with `outcome='error', receipt=null` tell you NOTHING about why. The actual `errorCode` lives on the pino log line, not the DB row. A pass is not complete until you have both: the decisions/fills row AND the matching Loki line(s) for any non-`placed` outcome. If Loki retention has aged out (>7d), say so explicitly — don't infer.
5. **One verifiable finding per pass.** End the pass with: (a) the question, (b) the evidence rows/lines, (c) the conclusion, (d) the next narrower question. ONE finding does not mean ONE query — it means you keep digging until the finding is provable, then stop.
6. **Never theorize about UI behavior.** If the answer depends on what the dashboard shows or hides, read `nodes/poly/app/src/.../current-position-read-model.ts` (and the API route serving the panel) and paste the relevant code. Don't speculate that the UI "collapses" or "hides" anything.

## Evidence sources — these are the ONLY ones allowed

### Postgres (via Grafana proxy)

Datasource UID for prod: `cogni-production-poly-postgres`. Helper: `scripts/grafana-postgres-query.sh '<SQL>' --env production --node poly`. Read-only (SELECT/WITH/SHOW/EXPLAIN).

**Schema gotchas to know up front:**

- `poly_copy_trade_decisions.decided_at` (NOT `created_at`) is the timestamp column, **`timestamp with time zone`** — compare with `to_timestamp(<seconds>)`, not bare epoch ints.
- `poly_copy_trade_decisions.target_id` is a UUIDv5 derived from `(billing_account_id, target_wallet)` and does NOT FK to `poly_copy_trade_targets.id`. Joining the two tables on `target_id` returns zero rows. To find decisions for swisstony, filter by `intent->>'target_wallet'` or grab the v5 id from a sample row first.
- `intent->>'market_id'` has the form `prediction-market:polymarket:0xCONDITION_ID`, not the bare condition_id. `intent->>'position_token_id'` is often null on `new_entry` decisions; the actual token_id is in the `fill_id` string after the second `:`.
- `poly_trader_wallets.kind`: `copy_target` for the wallets we mirror, `cogni_wallet` for our own.

Most relevant tables (schemas in `nodes/poly/packages/db-schema/src/`):

| Table                       | What it holds                                                                                                                                           | Key cols                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `poly_copy_trade_targets`   | Targets we mirror                                                                                                                                       | `id`, `target_wallet`, `mirror_filter_percentile`, `mirror_max_usdc_per_trade`, `created_at`, `disabled_at`                                |
| `poly_trader_wallets`       | Wallet directory with labels (swisstony, RN1, our cogni_wallet)                                                                                         | `id`, `wallet_address`, `kind`, `label`                                                                                                    |
| `poly_trader_fills`         | Every fill we've seen for any tracked wallet (target's AND ours)                                                                                        | `id`, `trader_wallet_id`, `source`, `native_id`, `condition_id`, `token_id`, `side`, `price`, `shares`, `size_usdc`, `observed_at`         |
| `poly_copy_trade_decisions` | One row per (target fill → our decision). The truth of what the mirror chose to do. `receipt=null` is normal on `outcome='error'` — the WHY is in Loki. | `id`, `target_id` (UUIDv5), `fill_id`, `outcome` (`placed`/`skipped`/`error`), `reason`, `intent` (jsonb), `receipt` (jsonb), `decided_at` |
| `poly_copy_trade_fills`     | Our placed orders                                                                                                                                       | PK `(target_id, fill_id)`, `market_id`, `client_order_id`, `order_id`, `status`, `attributes` (jsonb)                                      |
| `poly_market_outcomes`      | Market resolution (chain-authoritative)                                                                                                                 | `(condition_id, token_id)`, `outcome`, `payout`, `resolved_at`                                                                             |

SQL templates:

```sql
-- 0. Find swisstony's deterministic target_id (sample one of its decisions)
select target_id, count(*) from poly_copy_trade_decisions
where intent->>'target_wallet' = '0x204f72f35326db932158cba6adff0b9a1da95e14'
group by target_id;

-- 1. All fills on a condition with wallet labels
select w.label, w.kind, f.side, f.token_id, f.price, f.shares, f.size_usdc, f.observed_at, f.native_id
from poly_trader_fills f join poly_trader_wallets w on w.id = f.trader_wallet_id
where f.condition_id = '0xCONDITION_ID_HERE'
order by f.observed_at asc;

-- 2. Every decision the mirror made for one target on one market (note the prefix on market_id)
select d.decided_at, d.fill_id, d.outcome, d.reason,
       d.intent->>'outcome' as outc, d.intent->>'side' as side,
       d.intent->>'fill_price_target' as p, d.intent->>'fill_size_usdc_target' as sz,
       d.intent->>'position_branch' as branch
from poly_copy_trade_decisions d
where d.target_id = '<UUIDv5 from query 0>'
  and d.intent->>'market_id' = 'prediction-market:polymarket:0xCONDITION_ID_HERE'
order by d.decided_at asc;

-- 3. Recent non-placed decisions, grouped by (reason, intent.outcome)
select reason, outcome, intent->>'outcome' as outc_name, count(*) as n
from poly_copy_trade_decisions
where decided_at > now() - interval '24 hours' and outcome != 'placed'
group by 1, 2, 3
order by n desc;
```

### Loki (literal history tracing)

Helper: `scripts/loki-query.sh '<logql>' [minutes_back=30] [limit=200]`. Standard selector for prod poly node: `{env="production",service="app",pod=~"poly-node-app-.*"}`. **Retention is ~7 days** — if your incident is older, say so and don't fabricate.

`component` labels (pino) you'll actually use:

- `component="mirror-pipeline"` — the decision engine. Every non-`placed` decision row has a matching `level=50` log here carrying the real `errorCode` (which is NEVER in `decisions.receipt`).
- `component="copy-trade-executor"` — the CLOB place call. Look here for raw CLOB rejection bodies.
- `component="polymarket-ws-source"` — wallet-watch ingestion (target's fills entering our system).
- `component="order-reconciler"` — order-status sync back to DB.
- `component="mirror-job"` — outer scheduler.

Queries that actually return something:

```bash
# What did mirror-pipeline say for a given fill_id? (substring match on the fill_id)
scripts/loki-query.sh '{env="production",service="app"} | json | component="mirror-pipeline" |~ "FILL_HEX_PREFIX"' 1440 200

# Every place attempt on a tokenId in the last day
scripts/loki-query.sh '{env="production",service="app"} | json | component="copy-trade-executor" |~ "TOKEN_ID_HERE"' 1440 200

# Recent placement errors with their errorCode (most useful)
scripts/loki-query.sh '{env="production",service="app"} |~ "placement_failed"' 1440 50
```

## Example walkthrough — one pass

**User**: "Our wallet shows UNDER 41 sh on Chelsea v Nott Forest O/U 3.5 while swisstony shows OVER 31k sh. Why are we on the wrong side?"

**Step 1 — verify the basics.** Look up wallets in `poly_trader_wallets` (label = swisstony / our cogni_wallet). Find our 41.28-sh position via `poly_trader_fills` aggregation (group by `condition_id, token_id`, filter on share count + vwap). Pull the exact `condition_id` and `token_id`. Cross-check: did the target trade BOTH outcomes on this condition? `select … where condition_id=? group by token_id` — many "wrong-side" appearances are the target having scalped both sides; the apparent inversion is then a sizing/execution issue, not a side-flip.

**Step 2 — pull every decision the mirror made for that target on that condition.** Use query template #2. Read them in time order. Categorize each by `outcome` + `reason`. If all `placed` decisions are on token X and the target's actual fills are on token X, the mirror's side-selection is fine. If you see a meaningful number of `outcome='error'` rows, **that is the central failure**, not whichever side won.

**Step 3 — drive through to Loki in the SAME pass.** `decisions.receipt` is `null` on errors; the `errorCode` only lives on the Pino line. Paste the JSON line and read the `errorCode`. Cross-reference against the CLOB enum and the collateral spec. Only then write up.

**Step 4 — write up.** Question, 3–5 rows/lines of raw evidence, conclusion grounded in those rows, next narrower question. Do not theorize about UI behavior — if the UI is in play, read the read-model code.

## What this skill does NOT do

- No aggregate scorecards, no |Δ| histograms, no failure-mode taxonomies until a single case is fully proven.
- No auto-filing of work items. After a proven finding, the user (or you on explicit ask) files a concrete bug with evidence pasted inline.
- No reading from `/api/v1/poly/wallet/execution` — it aggregates server-side and obscures the underlying rows.
- No subagent reports as primary evidence. Subagents can fetch raw rows/lines; you read them yourself.
- **No claims about what the dashboard "shows" or "hides" without reading the read-model file.** `MirrorPositionView` has a dominant-side selection; the dashboard read model may or may not — find out by reading code, not by guessing.
- **No ending a pass with "Postgres said X, want me to check Loki?"** If Loki is the next step, just run it. Pareto baby step = one finding, not one query.
