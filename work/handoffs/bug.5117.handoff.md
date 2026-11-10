---
id: bug.5117
type: handoff
work_item_id: bug.5117
status: active
created: 2026-10-08
updated: 2026-10-08
branch: flock-leader/bug5293-pg-exporter-bounded
last_commit: f0188c1414
---

# Handoff: app_readonly 28P01 storm — a garbage-collection bug, not a credential storm

## Mission

**Pickup:** you own the operator's **shared-database substrate** — making every node's Postgres
reliable, bounded, observable and self-serviceable. The acute incident (bug.5293, prod Postgres
crash-looping 114×/24h) is **over**: 1 crash in the last 24h against a ≤9/24h target. What remains
is the structural work that was deferred during the firefight, and the first item is fully
root-caused and ready to build. Nothing here is blocked on a human.

## Goal

End state: **no derived observability resource outlives the thing it describes, and credential
drift can never again be silent.**

- `password authentication failed for user "app_readonly"` on `{env="production",service="postgres"}`
  falls from **~180/hr to 0/hr**, measured before→after on the live Loki series.
- Zero ghost Grafana Postgres datasources in any env (a datasource whose database does not exist).
- `scripts/grafana-postgres-query.sh` returns rows for `cogni_poly` and `cogni_operator` in
  production (today: SQLSTATE 28P01) — restoring the only box-free SQL instrument any node or agent
  has, without SSH.

**Deploy proof (this is the compose/infra lane, not an app digest):** `POST /api/v1/deploy/infra-reconcile`
returns `{"status":"dispatched"}`; the run's **`Provision Grafana Postgres datasources`** and
**`Verify Grafana Postgres datasources`** steps are `success`; then re-run the datasource health
census (see Pointers) and show ghosts gone + previously-failing real datasources passing.
`/version.buildSha` does **not** move — the production infra variant deliberately preserves the app pin.

## Start By Reading

- `work/README.md#Handoffs` and the work item **bug.5117** itself — its `summary` carries the full
  measured root cause and its `outcome` is the 9-step `done =` checklist. The work item is canonical;
  this handoff is derived.
- `scripts/ci/provision-grafana-postgres-datasources.sh` — lines ~108-135. `node_database_csv()`
  supplies the roster; the `for db_name in "${grafana_dbs[@]}"` loop creates/updates by
  `uid=cogni-${DEPLOY_ENVIRONMENT}-${node}-postgres`. **It never enumerates what already exists in
  Grafana, so it cannot delete.** That absence is the bug.
- `docs/spec/cicd-platform-boundary.md` — the freeze. This change qualifies in place as both
  _catalog-driven_ and _tightening a guard_; read the allowed-change gate before widening scope.
- `.claude/skills/database-expert/SKILL.md` — the north star: shared by default → **meter → bound →
  observe → graduate**. Also the "a declared migration is not an applied migration" rule, which the
  migration-verification item below turns into an enforced gate.
- `scripts/grafana-postgres-query.sh` — the instrument this bug keeps broken.
- `docs/spec/substrate-access-grant.md` + `story.5052` — where node-scoped DB access is headed;
  task.5162 (`metrics_reader`) is the least-privilege successor to `app_readonly`.

## Current State

- **Branch is clean at `origin/main` (`f0188c1414`); there is no uncommitted or unpushed work.**
  The one PR from this lane, [#2555](https://github.com/cogni-dao/cogni/pull/2555), is **merged**
  (squashed as `91209fc7f7`) and live in production.
- **#2555 delivered per-database Postgres metrics** — `pg_up{env="production"}=1`, 19 `datname`
  series, 43 roles. Every number in this handoff is readable only because of it. It replaced the
  exporter #2536 had reverted, and added an explicit bounded `enabled_collectors` list validated
  against the deployed `grafana/alloy:v1.9.2` binary.
- **bug.5117 root cause (measured 2026-10-08):** all 55 Postgres datasources health-checked with up
  to 3 attempts → 16 OK on attempt 1, 1 on attempt 2, **38 still failing**. Of the 14 failing in
  production, **12 are ghosts whose database does not exist** (`ayo blue canary coulditbe creative
games habitat oss pandora please resy trash`); only **`red` and `toks4`** are genuine credential
  drift on a real database. Fleet-wide: 13 failing candidate-a, 12 preview, 14 production.
- **The crash hypothesis in the prior bug.5117 summary is REFUTED** and the item now records both
  disproofs: a null model (crashes within ±2s of an auth failure = 1/32, where random timestamps
  score 5.1/32 — no signal at any window), and the decisive one — the crash class resolved to
  1/24h while this credential remained completely unfixed at 180 FATALs/hr.
- **Not shipped, and all mine:** per-role bounds (**46 of 47 roles are `CONNECTION LIMIT -1`**; only
  `service_poly=20`, a surviving hand-write), bug.5299 env isolation (**7 non-prod databases still
  on the production host**; `cogni_poly_candidate_a` holds ~11 connections there), a Postgres restore
  drill (no `pg_restore`, no drill, no verification anywhere in the repo), and migration verification.
- Production connection budget: peak **58 of `max_connections=100`**, up from 40 a week ago.
- Duplicates still open: **bug.5229** and **bug.5308** describe this same signature.

## Design / Implementation Target

1. **Converge, don't accumulate.** After the create/update loop, enumerate Grafana's existing
   datasources and **delete** every one matching `uid = cogni-${DEPLOY_ENVIRONMENT}-*-postgres`
   that is not in the catalog-derived set. This is the single durable fix.
2. **Scope the delete tightly.** Only `cogni-<env>-*-postgres` uids, only for the env being
   provisioned. Never touch Loki/Prometheus datasources, never another environment. A too-broad
   delete here is far worse than the bug.
3. **Re-assert the credential every run** for every derived datasource, using the existing
   `derive_secret postgres-readonly` derivation. This closes `red`/`toks4`.
4. **Make drift loud.** The step must FAIL if a _derived_ datasource still returns 28P01 after
   provisioning. Account for bug.5335 (first-attempt credential-cache miss is real but accounted for
   exactly 1 of 55) — retry, then fail.
5. **Never `ALTER ROLE` the password.** bug.5002 role-drift class; `provision.sh` already owns the
   single derivation and re-asserts it. Do not add a second source of truth.
6. **Boundaries that must hold:** no SSH to production as a fix path; operator API only, never a
   personal `gh workflow run`; the PR must stay **single-lane** — both
   `scripts/ci/provision-grafana-postgres-datasources.sh` and `infra/compose/runtime/**` classify as
   `compose` in `candidateInfraPathLane` (`nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts`),
   and a mixed-lane PR is undispatchable with `422 candidate_infra_path_rejected`.
7. **Must not regress:** the per-database exporter from #2555. After any infra reconcile, confirm
   `pg_up`, `pg_stat_database_*`, cadvisor, node, app and worker series are all still **advancing**
   past the alloy restart — freshness, not value.

## Next Actions / Risks

- [ ] Ship the converge+prune+guard PR against `provision-grafana-postgres-datasources.sh`; prove on
      candidate-a, then production; then re-measure the Loki 28P01 rate before→after.
- [ ] Close bug.5229 and bug.5308 into bug.5117.
- [ ] Contribute the durable rule to the hub (`use-operate` domain): _a derived observability
      resource must converge, not accumulate_ — the generalisable lesson behind this bug.
- [ ] Then per-role bounds: `CONNECTION LIMIT` + `idle_in_transaction_session_timeout` +
      `lock_timeout` in `infra/compose/runtime/postgres-init/provision.sh`'s `provision_app_role`
      path, applied to EXISTING roles too. Verify with `pg_roles_connection_limit`.
- [ ] Then bug.5299 (7 non-prod DBs off the production host), then the restore drill, then
      migration verification + a per-node schema-version readout.
- **`app_<node>` is the MIGRATOR role, not `service_<node>`.** `scripts/db/migrate.mjs:24` reads
  `DATABASE_URL`, which `reconcile-secrets.sh:238` composes as `app_<node>`. A tight role-level
  `statement_timeout` on `app_<node>` will cancel migrations mid-deploy. The comment at
  `postgres-init/provision.sh:295` implies the opposite and is how this error propagates — fix it.
- **A tight role-level `statement_timeout` is structurally wrong**, not just mis-tuned: one role
  serves both the request path and migrations. Role defaults are generous backstops; the tight bound
  belongs in the caller's session (`SET LOCAL`). Measured evidence: poly's prune `DELETE` is already
  fully index-driven and still takes 29–73s, so an 8s role bound means retention can never complete.
- **"poly has no DB migration path" is FALSE.** 90× `akash_tx_migration_succeeded` for poly in 7
  days across prod/preview/candidate-a, and `DOLTGRES_URL` is in
  `COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS`, which flips the `migrate-doltgres` gate ON fleet-wide
  (the bug.5265 fix). The real gaps are that the gate proves the job _ran_, not that the schema
  _arrived_, and that a node dev cannot see their own schema state — both downstream of this bug.
- **Two measurement traps that produced false readings in this lane.** `curl` inside a
  `while read` loop consumes stdin and silently corrupts the loop (the same trap documented in
  `run-node-substrate.sh`); and `cmd | head && echo OK` masks a non-zero exit, which produced a
  false-green `docker compose config`. Verify with a parallel `xargs` census, not a read-loop.
- **`DRY_RUN=1` is ignored on the already-closed path** of `scripts/ops/recover-orphaned-akash-lease.sh`
  (the guard is an `elif` on `verify_closed`, so `close_lease` runs unguarded). Filed as bug.5347.

## Pointers

| File / Resource                                                   | Why it matters                                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/ci/provision-grafana-postgres-datasources.sh`            | The bug. Create/update loop with no prune; `uid=cogni-<env>-<node>-postgres`                                                                        |
| `scripts/ci/lib/image-tags.sh` → `node_database_csv()`            | The catalog-derived roster that defines the intended set                                                                                            |
| `infra/compose/runtime/postgres-init/provision.sh`                | `provision_app_role` (bounds go here); `derive_secret postgres-readonly`; the wrong migrator comment at ~:295                                       |
| `infra/compose/runtime/configs/alloy-config.metrics.alloy`        | The #2555 exporter + `infra_metrics` allowlist — must not regress                                                                                   |
| `scripts/grafana-postgres-query.sh`                               | Box-free SQL instrument; currently 28P01 for most DBs                                                                                               |
| `scripts/loki-query.sh`                                           | Loki reads (uid `grafanacloud-logs`); Prometheus = same proxy, uid `grafanacloud-prom`                                                              |
| `nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts` | `candidateInfraPathLane` — check before composing the PR                                                                                            |
| Datasource census                                                 | `GET $GRAFANA_URL/api/datasources` → filter `grafana-postgresql-datasource` → `GET .../uid/<uid>/health`, 3 attempts, in parallel via `xargs -P 10` |
| Crash series                                                      | `sum(count_over_time({env="production",service="postgres"} \|= "exited with exit code 2" [24h]))`                                                   |
| 28P01 series                                                      | `{env="production",service="postgres"} \|= "password authentication failed for user \"app_readonly\""`                                              |
