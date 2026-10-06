---
name: poly-dev-manager
description: "Top-level router for Cogni's Polymarket poly node. Load this skill for any poly work; it routes you to the right specialty skill (copy-trading loops, market-data / CLOB / Data-API, or auth & wallets). Use when starting a poly task, triaging a poly bug, reviewing a poly PR, or anytime the work smells poly-adjacent but you don't yet know which sub-domain. Also triggers for: 'work on the poly node', 'poly bug', 'review this poly PR', 'what does the poly node do', 'which poly skill do I need', 'poly roadmap', 'Phase 3 / Phase 4', 'task.0318 / task.0315 / task.0322', 'mirror trade Polymarket wallet', 'fix poly in candidate-a'."
---

# Poly Dev Manager

You are the orientation layer for Cogni's poly node. This file is intentionally short: it gets you to the specialty skill you actually need.

## What the poly node does (one paragraph)

Takes a Polymarket wallet that demonstrably trades with edge and mirrors its fills onto a Cogni-controlled trading wallet. Target wallet trades → `wallet-watch` detects (Data-API `/trades` poll, with WS wake-up after #1172) → `mirror-coordinator` decides → `INSERT_BEFORE_PLACE` ledger row lands → `PolymarketClobAdapter` signs via Privy HSM → CLOB receipt. v0 shipped single-operator; Phase A shipped RLS on copy-trade tables; Phase B (task.0318, `deploy_verified` 2026-04-22) shipped per-tenant Privy trading wallets. Phase 4 (task.0322) will swap the 30s poll for CLOB WebSocket + adversarial-robust target ranking.

## Current Status Card (2026-05-06)

**Where the work is right now:** the mirror loop is stable; energy has shifted to the **research / data-science surface** and the **historical backfill** that powers it. Most active code lives under `nodes/poly/app/src/features/wallet-analysis/server/` and `app/(app)/research/`, not in the mirror coordinator. When in doubt about where a new task belongs, default to: trading-algorithm tuning ⇒ `poly-copy-trading`; building or querying a research view ⇒ `data-research`; backfill / data-coverage gap ⇒ both.

**Recent ground-shifts to know before editing anything:**

- **SQL-aggregation is the standard for any read over `poly_trader_fills` / `poly_trader_position_snapshots` / `poly_market_*`.** bug.5012 (2026-05-05) — poly OOM-crashlooped on RN1's 825k-fill backfill; fix was a per-field SQL refactor of `wallet-analysis-service.ts` across cp1–cp7. Naively writing `db.select().from(polyTraderFills).where(...)` is the canonical anti-pattern. See [`data-research`](../data-research/SKILL.md).
- **Backfill is the live operational concern.** Several derived tables (`poly_trader_position_snapshots`, `poly_market_metadata`, `poly_market_outcomes`, `poly_market_price_history`) started writing only May 1–5; pre-cutover history must be backfilled from `poly_trader_fills` (SQL-derived), `poly_copy_trade_decisions.receipt` (JSONB-derived), or Polymarket APIs (reuse the forward-fill writer with a one-shot driver — never hand-rolled). See coverage caveats in the operational-data-tables block below.
- **Canonical market-metadata table (#1265, #1270).** `poly_market_metadata` is now the source of titles/event metadata. Older code paths that decoded titles out of jsonb on every query are being retired.
- **Research tab is the active product surface.** target-overlap, market-exposure, P/L overlay, target-size PnL, trader-comparison, copy-target benchmarks, market-aggregation views all landed since #1215. New views must follow [`data-research`](../data-research/SKILL.md).

**Active copy-trade behavior (mirror policy v0):**

- New entries for curated targets use `target_percentile_scaled`: the target condition/token position cost basis must be at or above that wallet's configured pXX threshold before we mirror it.
- Default pXX is p75. p50/p75/p90/p95/p99 are hardcoded; unsupported values interpolate between known points and clamp outside the known range.
- Accepted BUY branches size from market minimum toward `max_usdc_per_trade`, scaled by how far the target position is between pXX and p99.
- Existing mirror positions add branch context through `position_followup`: same-token `layer`, opposite-token `hedge`, SELL `sell_close`. Follow-ups still respect market floors, per-position caps, local mirror exposure thresholds, idempotency, tenant grant authorization, and CLOB placement checks.

**Hardcoded position pXX baked into bootstrap config (still current as of 2026-05-06):**

| target    | p50 |  p75 |  p90 |    p95 |    p99 | sample                                                                                   |
| --------- | --: | ---: | ---: | -----: | -----: | ---------------------------------------------------------------------------------------- |
| RN1       | $40 | $200 | $733 | $1,811 | $5,659 | 3,990 token positions, Data API `/positions?sizeThreshold=0`, captured 2026-05-03T02:34Z |
| swisstony | $31 | $146 | $665 | $1,394 | $4,809 | 1,085 token positions, Data API `/positions?sizeThreshold=0`, captured 2026-05-03T02:34Z |

Position follow-up defaults: `min_mirror_position_usdc=5`, `market_floor_multiple=5`, `min_target_hedge_ratio=0.02`, `min_target_hedge_usdc=5`, `max_hedge_fraction_of_position=0.25`, `max_layer_fraction_of_position=0.5`. Source of truth: `nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts`. Re-flight after any edit to that file.

**Observability reality:** Loki is the current operational truth. Query `event="poly.mirror.decision"` for processed fills; position-aware branches include `position_branch`, `position_qty_shares`, `position_token_id`, `target_position_usdc`, `target_hedge_ratio`. Research-view emissions follow `feature.poly_research.<view>.complete`. Metrics are still mostly `noopMetrics` in candidate-a bootstrap; do not assume Prometheus counters exist.

## Which skill to load

| If you're doing…                                                                                                                                                                            | Load                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Mirror pipeline, coordinator, wallet-watch, `poly_copy_trade_*` tables, v0 caps, poll cadence, shared-poller, Phase-4 streaming prep                                                        | [`poly-copy-trading`](../poly-copy-trading/SKILL.md) |
| CLOB order placement, Data-API reads, fill-id semantics, EOA-vs-Safe-proxy gotchas, target-wallet screening / ranking research                                                              | [`poly-market-data`](../poly-market-data/SKILL.md)   |
| Per-tenant `/api/v1/poly/wallet/connect`, Privy provisioning, `poly_wallet_connections`, CTF + USDC.e approvals, AEAD at rest, CustodialConsent, validating `deploy_verified`               | [`poly-auth-wallets`](../poly-auth-wallets/SKILL.md) |
| Research views, dashboard slices, P/L curves, histograms, comparison panels, SQL-vs-V8 aggregation, OOM diagnosis on `poly_trader_fills` / `poly_trader_position_snapshots` reads, backfill | [`data-research`](../data-research/SKILL.md)         |

Load multiple if you're crossing domains (e.g., a research view that drives a target-ranking change is `data-research` + `poly-copy-trading`). Each specialty skill is self-contained; there is no "base" you have to load first.

## Canonical references (cross-cutting)

**Specs (as-built):**

- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — Phase 1 layer boundaries, invariants, `fill_id` shape
- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — order status vs position lifecycle vs redeem job state machine
- [docs/spec/poly-tenant-and-collateral.md](../../../docs/spec/poly-tenant-and-collateral.md) — Phase A tenant-scoped copy-trade tables + RLS
- [docs/spec/poly-tenant-and-collateral.md](../../../docs/spec/poly-tenant-and-collateral.md) — Phase B `PolyTraderWalletPort` (AEAD, consent, invariants)

**Current design/research pointers:**

- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — `MirrorPositionView`, position authority boundaries, follow-up branch predicates, decision-log observability contract
- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — canonical position model; do not confuse local mirror policy cache with chain/Data API authority
- [docs/spec/poly-copy-trade-execution.md](../../../docs/spec/poly-copy-trade-execution.md) — current as-built hardcoded RN1/swisstony target-position pXX policy
- [docs/research/poly/layering-policy-spike-2026-05-02.md](../../../docs/research/poly/layering-policy-spike-2026-05-02.md) — historical layering research; do not treat its order-flow pXX as the active position-pXX policy
- [nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts](../../../nodes/poly/app/src/bootstrap/jobs/copy-trade-mirror.job.ts) — current hardcoded v0 sizing snapshots and position-follow-up defaults
- [nodes/poly/app/src/features/copy-trade/plan-mirror.ts](../../../nodes/poly/app/src/features/copy-trade/plan-mirror.ts) — pure planner for pXX, layer, hedge, and SELL-close branch decisions
- [nodes/poly/app/src/features/copy-trade/mirror-pipeline.ts](../../../nodes/poly/app/src/features/copy-trade/mirror-pipeline.ts) — sequencing, target-position hydration, ledger decision recording, Loki fields

**Guides:**

- [docs/guides/poly-wallet-provisioning.md](../../../docs/guides/poly-wallet-provisioning.md) — per-tenant flow + honest architecture accounting
- [docs/guides/polymarket-account-setup.md](../../../docs/guides/polymarket-account-setup.md) — shared-operator onboarding (legacy)

**Operational data tables (where research / data-science work lands):**

| Table                                                   | Owner / writer                                                   | Coverage caveats                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `poly_trader_fills`                                     | `wallet-watch` + spike.5024 historical walker                    | Full Polymarket history for tracked wallets after spike.5024 (RN1, swisstony walked from Apr) |
| `poly_trader_position_snapshots`                        | `wallet-analysis-service` snapshot writer                        | **Started writing 2026-05-03**; pre-May-3 must be derived from fills (cumsum) for backfill    |
| `poly_trader_current_positions`                         | dashboard refresh path                                           | Live, refreshed on read; not a historical record                                              |
| `poly_trader_user_pnl_points`                           | db-backed user-pnl read model (#1242)                            | Walked back via spike.5024 corpus                                                             |
| `poly_market_metadata`                                  | canonical Gamma persistence (#1265, #1270)                       | **Started writing 2026-05-05**; backfill via Gamma `/markets/{conditionId}` per condition     |
| `poly_market_outcomes`                                  | `runMarketOutcomeTick` — condition-iterating writer (cp3, #1247) | **Started writing 2026-05-05**; reuse forward-fill loop with one-shot driver over conditions  |
| `poly_market_price_history`                             | cp7 db mirror (#1251)                                            | **Started writing 2026-05-05**; backfill via CLOB `/price-history?market={tokenId}`           |
| `poly_copy_trade_{targets,fills,decisions,attribution}` | mirror coordinator                                               | See [`poly-copy-trading`](../poly-copy-trading/SKILL.md) for invariants + RLS                 |
| `poly_redeem_jobs`                                      | redeem worker (Capability B, #1242)                              | event-driven; cleared by completion                                                           |
| `poly_wallet_{connections,grants}`                      | per-tenant onboarding                                            | See [`poly-auth-wallets`](../poly-auth-wallets/SKILL.md)                                      |

**Project charter + work items:**

The markdown work-item corpus was retired on 2026-04-25 (PR #1241). Items now live in Doltgres and are read via the operator API:

- [proj.poly-copy-trading](../../../work/projects/proj.poly-copy-trading.md) — full roadmap, open bugs, constraints (still markdown)
- Active poly items: `GET https://poly.cognidao.org/api/v1/work/items?statuses=needs_implement,needs_design,needs_merge`
- Specific item: `GET https://poly.cognidao.org/api/v1/work/items/{id}` (e.g. `task.5012`, `task.0322`, `bug.5012`, `spike.5024`)

Charter still references `../items/*.md` paths — those links are stale; use the API or follow links from the operator dashboard.

## Anti-patterns that bite everywhere (regardless of specialty)

- **Placing a test trade from a wallet you control and calling it "mirror validation."** The mirror copies the TARGET. If the target didn't trade, the mirror has nothing to copy. True of shared operator, true of your own per-tenant wallet, true of raw-PK test wallets.
- **Smuggling P4 (streaming / ranking) work into a v0 or v1 task.** P4 is tracked in task.0322. Scope discipline matters here because the fill_id shape is frozen (`data-api:…`) and mixing schemes corrupts the idempotency layer.
- **`kubectl set env` for long-lived config.** Argo reverts on next sync. Secrets go through `scripts/setup/setup-secrets.ts` → `candidate-flight-infra`; config goes into the kustomize overlay.
- **Re-setting GH env secrets without checking `gh secret list --env candidate-a` first.** Rotates tokens out from under live flights.
- **Trusting the Polymarket UI profile for EOA-direct wallets.** The `/profile/<addr>` page redirects to an empty Safe-proxy. Use Data-API `/positions` / `/trades` or Polygonscan. See [`poly-market-data`](../poly-market-data/SKILL.md) for the full ground-truth order.

## Observability backstop (MCP-down fallback)

`grafana` MCP is flaky. When it's down, use [`scripts/loki-query.sh`](../../../scripts/loki-query.sh) — accepts raw LogQL, hits Grafana Cloud via service-account token, auto-sources `.env.canary` / `.env.local`. Same LogQL syntax as the MCP. Used to flip `deploy_verified` on task.0318 on 2026-04-22.

## Cross-cutting enforcement

Rules that apply regardless of which specialty you're in:

- **Never use raw PKs in production code paths.** `scripts/experiments/` only. Production signs via Privy HSM (shared or per-user).
- **Never skip `INSERT_BEFORE_PLACE`** in the coordinator — at-most-once correctness gate.
- **`fill_id` shape is frozen** at `data-api:<tx>:<asset>:<side>:<ts>`. P4 will add `clob-ws:…`. Never mix schemes within one fill.
- **Idempotency is always `keccak256(target_id + ':' + fill_id)` → `client_order_id`.** No alternatives.
- **`deploy_verified: true` requires the full validation recipe**, not just `pnpm check`. See [`poly-auth-wallets`](../poly-auth-wallets/SKILL.md) for the per-tenant provisioning recipe.
