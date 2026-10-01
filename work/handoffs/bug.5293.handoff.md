---
id: bug.5293
type: handoff
work_item_id: bug.5293
status: active
created: 2026-10-01
updated: 2026-10-01
branch: flock-leader/bug5293-alloy-parse-gate
last_commit: 489d51d624
---

# Handoff: prod Postgres crash-loop — instrumentation shipped, the crash is NOT fixed

## Mission

**Pickup:** production Postgres crash-recovers **~82 times per 24h** and has done so since ~2026-09-27. Each event takes every operator route to 502 for 30–60s. You own getting that number to the pre-9-27 baseline (≤9/24h) and then to zero. The previous session built the observability that was missing — per-database Postgres metrics now exist for the first time — but **did not move the crash number at all**. Treat "instrumentation proven" as the starting line, not progress. The CEO's framing is the operative one: _instrumentation proven ≠ poly healed_.

## Goal

- `sum(count_over_time({env="production",service="postgres"} |= "exited with exit code 2" [24h]))` falls from **82** to **≤9**, then 0, on the live Loki series (datasource uid `grafanacloud-logs`).
- Operator routes stop 502-ing during those windows; `production/preview/candidate-a` no longer share a database failure domain.
- **Poly is protected, not throttled** — its mission must not be degraded (see boundaries).
- E2E validation signal, in order: (1) `pg_up{env="production"} == 1` and `pg_stat_database_numbackends{env="production"}` present **per `datname`** in Grafana (uid `grafanacloud-prom`); (2) the prod shares visible continuously rather than by hand-run SQL; (3) the 24h `exit code 2` series bends down after each remediation, measured before→after.
- Deploy proof shape for this work: it is the **compose/infra lane**, not an app digest. Proof = `POST /api/v1/deploy/infra-reconcile` returns `{"status":"dispatched"}`, the run's **`Deploy Compose infra`** step is `success`, the log shows `Alloy config changed (hash: …) … restarted`, and the metric appears in Prometheus. `/version.buildSha` does **not** move — the production variant deliberately preserves the app pin.

## Start By Reading

- `work/handoffs/bug.5293.handoff.md` (this file), then bug.5293 / bug.5299 / bug.5117 in the work API.
- Hub (mandatory recall, both planes — `/knowledge?domain=operator` returns merged-main only): `control-plane-self-starvation` ("DB-per-node is identity isolation, not resource isolation"; measured poly at 96.2% of all PG bytes) and `prod-oom-misdiagnosis-taxonomy` ("classify by signature, never a memory guess"). **Also read open contributions** — `GET /knowledge/contributions?state=open` then `/diff`; `contrib-flock-leader-ea25f5e7` carries most of this diagnosis and is **not merged** (human-only merge).
- `docs/spec/multi-node-tenancy.md` — the four new invariants: `ENV_IS_A_FAILURE_DOMAIN`, `MUTUAL_NONINTERFERENCE`, `NODE_GRADUATION_ON_THRESHOLD`, `SUBSTRATE_COST_DECLARED_AT_BIRTH`.
- `docs/spec/cicd-platform-boundary.md` — the freeze. Line ~125 is the test you will be held to: _"if the request needs a new `if`, a new env var threaded through SSH … it is platform work, not script work."_
- `nodes/operator/app/src/shared/node-registry/placement.ts` — `controlEnvFor` and `substrateHostEnvFor` (the typed resolver; **no production caller yet**).
- `nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts` — `candidateInfraPathLane` + `inspectCandidateInfraReview`. Read this **before** opening a compose-lane PR; any non-lane path makes it undispatchable (`422 candidate_infra_path_rejected`).
- `infra/compose/runtime/configs/alloy-config.metrics.alloy` (`prometheus.exporter.postgres` + the `infra_metrics` allowlist) and `infra/compose/runtime/postgres-init/provision.sh`.
- `docs/runbooks/grafana-postgres-readonly.md` — how to query prod Postgres without SSH.

## Current State

- **[#2523](https://github.com/cogni-dao/cogni/pull/2523) MERGED** (2026-10-01T00:27:52Z): per-database Postgres metrics via Alloy. Proven live on candidate-a — `pg_up=1`, `pg_stat_database_*` labelled by `datname`/`datid` across 16 DBs, ~400 series, zero per-relation series.
- **Production reconcile dispatched** — [run 36796466058](https://github.com/cogni-dao/cogni/actions/runs/36796466058), `in_progress` at handoff. App pin preserved at `8cece2fb6bbc`. **Verify it completed and that `pg_up{env="production"}` exists.**
- **[#2522](https://github.com/cogni-dao/cogni/pull/2522) OPEN** — `substrate_host_env` catalog cell + typed `substrateHostEnvFor` + the spec invariants. **Explicitly incomplete:** the helper has **no production caller and moves zero databases**. It is the input to the work below, not a deliverable.
- **[#2530](https://github.com/cogni-dao/cogni/pull/2530) OPEN** — `tests/ci-invariants/alloy-config-parses.spec.ts`, 6 tests incl. a negative control. Land this next; it is small and prevents a recurrence that cost ~20 min of candidate-a observability downtime.
- **Measured prod shares** (`pg_stat_database`, one stats window): `cogni_poly` = **95.9% of blks_read, 88.5% of temp_bytes**; `cogni_poly_candidate_a` = 3.9% / 11.5% **but holds 11 connections, equal to prod poly's**; all 10 other databases combined ≈ **0.1%**. `cogni_poly` is ~15 GB; 17 databases on the box.
- **Crash signature, with hypotheses killed by data:** `exit code 2` → `terminating any other active server processes` → crash recovery. **Ruled out:** OOM/signal-9/exit-137, `too many clients`, PANIC, shared-memory, container recreate, kine bloat (alert inactive), missing stats, missing index, table bloat (`n_dead_tup=0`). The exact exit-2 trigger is **still unattributed**.
- Filed this session: `bug.5333` (infra-reconcile error mapping: nonexistent SHA → 502, slug → 500), `bug.5335` (**every** Grafana PG datasource 400s on verify attempt 1; retries hide it and cost ~16 min per infra flight), `task.5162` (`app_readonly` is **BYPASSRLS + SELECT on all tables of every node DB** — not least-privilege; needs a dedicated `metrics_reader`).
- Pre-existing, unowned, blocks every contributor's pre-push: `db:check:generate-clean` fails on **pristine `origin/main`** (verified in a clean worktree).

## Design / Implementation Target

1. **Confirm prod instrumentation first.** `pg_up{env="production"}==1` + `pg_stat_database_numbackends{env="production"}` per `datname`. Rollback trigger if the 24h `exit code 2` series rises above **82**: revert the exporter block and re-reconcile (one-file compose change; exercised twice on candidate-a).
2. **Then stop adding observability.** The shares are measured; the remaining work is load reduction and isolation.
3. **Bounded poly write/query fixes (highest leverage — ~96% of read load).** Poly code lives in the **external** repo `cogni-dao/poly`; this is a cross-repo PR, not editable here. Reduce scan/spill amplification at the query/rollup layer (`poly_trader_fills` is ~2.06M rows / 4.3 GB with the ideal `(trader_wallet_id, created_at, id)` index already present and column stats present — so it is **not** a missing-index or bloat problem). See the `data-research` skill; bug.5012 is the precedent.
4. **Item (2): remove ALL candidate-a + preview databases, jobs and workloads from the production host** — every node, not just poly. CEO-approved shape is **option (a)**: a narrow, catalog-driven, **plumbing-only** compatibility seam through the existing substrate reconciler. It must move **provision target + DSN/secrets + egress together**, and explicitly handle data migration/reset and rollback. Policy stays in `placement.ts` — **no** new env policy, workflow, or duplicated branching in bash. Removal set: `poly_candidate_a`, `poly_preview`, `toks4_candidate_a`, `toks4_preview`, `toks5_candidate_a`, `toks5_preview`, plus the orphan `cogni_poly_empty_20260812`.
5. **Graduate poly production to dedicated Postgres** (`NODE_GRADUATION_ON_THRESHOLD`). **Gated on a proven restore** — `infra/compose/runtime/db-backup/backup.sh` writes `pg_dump -Fc` dumps but there is **no restore script, no drill, no verification anywhere in the repo**. An unexercised restore is an assumption.
6. **Per-role governance with separate budgets** for web / worker / **migrator** / **backup** / emergency-admin. Never put an aggressive `statement_timeout` on migrator or backup roles. Per-node role connection limits are currently `-1` (unlimited).
7. **Boundaries that must hold:** VM upsize is **off the table** (the hub says a bigger VM is not isolation). Never delete fills, never disable poly production trading, never hand-tune engine settings to throttle poly. Never SSH production. CI/CD freeze: no new bash/YAML platform logic. Do **not** ship the four old relief PRs — #2389 and #2253 touch the **identical file** (duplicates) and #2388/#2389 are `manifest=FAILURE`; only #2431 is green.

## Next Actions / Risks

- [ ] Verify run 36796466058 completed and `pg_up{env="production"}==1`; capture the prod `datname` shares as the new baseline.
- [ ] Land #2530 (parse gate), then #2522 — and state plainly that #2522 alone moves no databases.
- [ ] Open the cross-repo `cogni-dao/poly` PR for the bounded write/query fix.
- [ ] Implement item (2) as the option-(a) seam; prove one `(node, lane)` end-to-end before fan-out.
- [ ] Build and **exercise** a restore drill before any graduation cutover.
- [ ] Re-measure the 24h series before→after each change and report the delta, not the intent.
- **Freshness, not value, is the honest health check.** A metrics pipeline cannot report its own death: `up == 1` read "healthy" for three deploys while alloy was crash-looping. Always ask whether the series is still _advancing_ past the clock.
- **`gh run watch` / `gh pr checks --watch --fail-fast` exit 0 even when a check FAILED.** Always re-read state afterwards. This caught two red-looking-green runs.
- **River comments are `//`, never `#`.** One `#` makes the whole Alloy config unparseable, alloy exits 1 and crash-loops, taking the _entire_ metrics pipeline down — not just the edited block. #2530 is the gate.
- **The compose-lane dispatch refuses any non-lane path.** Check `candidateInfraPathLane` before composing a PR; mixing lanes or adding a test file makes it undispatchable.
- Infra flights serialize on a concurrency group and currently take 15–20 min, mostly in the bug.5335 retry-thrash. Cancelling is safe **only** once the `Deploy Compose infra` step reports `success`.

## Pointers

- Work items: bug.5293 (this), bug.5299 (env isolation), bug.5117 (app_readonly storm), bug.5188 (control-VM starvation), bug.5333, bug.5335, task.5162.
- Dolt: `contrib-flock-leader-ea25f5e7` (open, seq 10) — entry `pg-crash-domain-uninstrumented` + the refined `control-plane-self-starvation`.
- Prior plan (laptop-local, not canonical): `~/.claude/plans/putting-you-in-plan-zippy-axolotl.md`.
