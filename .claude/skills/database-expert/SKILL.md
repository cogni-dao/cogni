---
name: database-expert
description: Cogni database architecture and operations router — Postgres-vs-Doltgres placement, DB-per-node boundaries, shared-Postgres capacity/noisy-neighbor controls, metering and graduation, node-scoped access, schema ownership, migrations, backups, and runtime health. Use for schema changes, `DATABASE_URL`/`DOLTGRES_URL`, Drizzle, migration delivery, Postgres/Doltgres/Redis health, query pressure, connection limits, tenant isolation, database observability, or deciding when a node must leave shared Postgres.
---

# database-expert

Navigation aid for database design, runtime health, access, and migration delivery. **Always consult the canonical specs and live control-plane state first; this skill points to truth and records durable decision rules, not incident status, fleet counts, thresholds, or deployment rosters.**

## Ground truth — open these, don't restate them here

- [docs/spec/databases.md](../../../docs/spec/databases.md) — authoritative schema, role, migration, backup, and runtime contracts. Treat this as canon.
- [docs/spec/database-rls.md](../../../docs/spec/database-rls.md) — two-user RLS (`app_user` + `app_service`), `SET LOCAL app.current_user_id`, dep-cruiser rule on `getServiceDb()` (only importable from `drizzle.service-client.ts`).
- [docs/spec/database-url-alignment.md](../../../docs/spec/database-url-alignment.md) — explicit-DSN invariant, no component-piece fallback at runtime.
- [docs/spec/multi-node-tenancy.md](../../../docs/spec/multi-node-tenancy.md) — DB-per-node boundary (the database IS the tenant, not a column).
- [docs/spec/node-baas-architecture.md](../../../docs/spec/node-baas-architecture.md) — BaaS north star: nodes declare their substrate shape; the operator provisions, wires, observes, and evolves it.
- [docs/spec/substrate-access-grant.md](../../../docs/spec/substrate-access-grant.md) — operator-mediated, node-scoped database/observability access; developers and agents receive no environment-wide credential.
- [docs/design/substrate-grafana-observability.md](../../../docs/design/substrate-grafana-observability.md) — proxy-not-issuer observability plane and node-scoping model.
- [docs/spec/cicd-platform-boundary.md](../../../docs/spec/cicd-platform-boundary.md) — new substrate behavior belongs in the typed operator control plane, not growing shell/YAML deploy brains or routine SSH.
- [docs/guides/multi-node-dev.md](../../../docs/guides/multi-node-dev.md) — per-node dev commands + local setup.
- `infra/compose/runtime/docker-compose.yml` + `infra/compose/runtime/db-backup/backup.sh` — runtime Postgres backup job for app Postgres + Temporal Postgres; candidate-flight-infra validates health, manifests, and Loki logs.
- The per-node db-schema package pattern lives in `node-template` and in each node's own repo — **not in this monorepo**. This repo contains `nodes/operator` and `nodes/scheduler-worker` only.
- READMEs under `nodes/<node>/app/src/adapters/server/db/migrations/` — tripwires explaining the shared-era `0027_silent_nextwave.sql` duplicate.
- [docs/spec/knowledge-data-plane.md](../../../docs/spec/knowledge-data-plane.md) — Doltgres knowledge plane architecture (separate from the awareness/Postgres side).
- The per-node doltgres-schema package pattern likewise lives in `node-template` / the node's own repo.
- Migration delivery implementation: `packages/repo-spec/src/node-app-deployment.ts`, `nodes/operator/app/src/features/compute/akash-tx/akash-tx-migration-step.ts`, and `infra/crossplane/xcomputeworkload/composition.yaml`.
- For current incidents and evolving policy, RECALL the operator knowledge entries `node-lane-substrate-ready`, `lane-db-two-derivations`, `control-plane-self-starvation`, and `prod-oom-misdiagnosis-taxonomy`; then inspect live work items and telemetry. Do not copy their current measurements into this skill.

## Database hosting north star

The Pareto default is **shared Postgres capacity with one logical database per node**. The database is the schema/security/migration boundary; a `node_id` column is not. But a database on a shared server is **not** a CPU, memory, I/O, connection, or failure-domain boundary.

The target model is **shared by default, metered, bounded, observable, then graduated**:

1. **Provision automatically.** The node declares its needs; the operator creates its DB, roles, DSNs/secrets, migrations, egress, dashboards, and policy. No per-node hand wiring.
2. **Meter by database and role.** At minimum expose connections, transactions/rollbacks, block reads/cache hits, temp spill, deadlocks, database size, and query pressure. Prefer cluster-wide collection keyed by `datname`/`dbid`; do not add one exporter or dashboard configuration per node.
3. **Bound every shared tenant.** Provision role/pool limits such as `CONNECTION LIMIT`, `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout`, bounded `work_mem`, and pooler caps. Heavy but degradable reads should use request-local limits (`SET LOCAL`), not cluster-wide hand tuning.
4. **Protect environment failure domains.** Candidate/preview load must not impair production. Co-location is only acceptable while quotas and observed failure-domain behavior prove that separation.
5. **Graduate measured outliers.** Move a sustained noisy node/lane to a dedicated Postgres cell when it dominates a constrained resource or harms neighbor SLOs. The policy/scorecard owns thresholds; this skill must not freeze a number. Row count and number of databases alone are not graduation signals.

A larger shared VM is capacity, not tenant isolation: instance cgroups bound the whole server, not one database. Dedicated Postgres is the graduation path for demanding nodes, not the starting cost for every small node. This is the same broad product shape as managed Postgres platforms: pooled/shared tiers with metering and limits, isolated compute when the workload earns it.

Database access follows the same boundary. Developers and agents use operator-mediated, audited, node-scoped read/query or privileged-action surfaces. The shared `app_readonly` role is a v0 cross-node leak, not the destination; never substitute an environment-wide DSN or routine production SSH for the scoped access plane.

### Runtime health: prove the failure class before fixing it

Treat Postgres, Doltgres, Redis, and Temporal's persistence as critical substrate even when their containers report healthy. A healthy postmaster can still be killing individual backends; silence can mean missing telemetry rather than health.

1. Separate host/container OOM or restart, Postgres postmaster recovery, individual backend termination, statement timeout/cancellation, auth failure, lock pressure, and disk/I/O starvation by their actual signatures. Start with `prod-oom-misdiagnosis-taxonomy`.
2. Attribute shared-Postgres pressure by `datname`/role and query shape: connections, reads, cache misses, spill, locks/deadlocks, transaction rate, size, and `pg_stat_statements` where available.
3. Correlation is not causation. An expensive query is a proven query bug when its plan/shape is bad; it is only the crash cause after resource/exit evidence closes that link.
4. Fix in order: pathological query/write shape and missing index → per-tenant role/pool bounds → workload isolation/graduation. Do not reach first for global engine tuning or a larger VM.
5. Validate the user-visible/control-plane SLO after deployment. A green migration or workflow is not database health.

#### Container shared memory is its own failure class

On Linux, PostgreSQL normally backs parallel-query and parallel-maintenance dynamic shared memory with the container's `/dev/shm`. That capacity is independent of free host RAM, disk, and container health:

- Prove the chain: correlate `could not resize shared memory segment ... No space left on device`, runtime `shm_size`, process exit, and recovery timestamps. The allocation error alone does not prove a crash.
- Inspect the actual plan, memory settings, concurrent operations, and both query and maintenance parallelism. `max_parallel_workers_per_gather=0` does not disable parallel `VACUUM`/`CREATE INDEX`; do not size a fixed segment per worker.
- Set `shm_size` declaratively only after a concurrent-workload test; assert it at runtime and monitor RAM. Raising the ceiling is not a memory or tenant bound.
- Wire compatibility is not engine equivalence. Doltgres is not PostgreSQL; copy no PostgreSQL resource setting without Doltgres-specific evidence.

#### Detect it before a crash does — two predicates and one instrument

The failure classes above were all found _after_ an outage. Each has a cheap leading indicator that nothing currently watches.

**`last_autovacuum IS NULL` is the highest-value predicate we are missing.** Autovacuum that cannot run is silent: no error surfaces, the table simply grows. On cogni production every large table in one node's DB read `last_autovacuum`/`last_autoanalyze` NULL _and_ `n_live_tup: 0` while actually holding 16.8M rows — so the planner costed a multi-GB table as empty, and 88% of another table was dead tuples. Alert on NULL (or stale beyond a day) for any table over ~100 MB. One predicate would have caught that months earlier than the crash did.

```sql
-- leading indicators, cheap enough to scrape per database
select relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze,
       pg_total_relation_size(relid) bytes
from pg_stat_user_tables
where pg_total_relation_size(relid) > 100*1024*1024
  and (last_autovacuum is null or last_autoanalyze is null);
```

Corollary worth internalising: **statistics absence and vacuum absence are the same incident.** Autovacuum thresholds are computed _from_ the counters it maintains, so once they read zero nothing triggers, and a manual per-table `ANALYZE` may be the only way back in. Expect a full-database `ANALYZE` to be interrupted on a crashing instance — go table by table.

**Aggregate counters cannot see a hot retry loop; a sampler can.** Loki, dashboards and `pg_stat_*` totals all showed "slow queries" while the real shape was one node re-issuing a prune `DELETE` every ~2 seconds, each cancelled by `statement_timeout` then retried with **no backoff**, stacking until maintenance could never complete. Sample non-idle backends when attributing pressure:

```bash
while true; do
  docker exec <pg-container> psql -U postgres -At -F'|' -c \
    "select to_char(now(),'HH24:MI:SS'), pid, usename, datname, state,
            extract(epoch from now()-query_start)::int,
            left(regexp_replace(query,'[\n\t ]+',' ','g'),90)
     from pg_stat_activity where state <> 'idle' and pid <> pg_backend_pid()"
  sleep 2
done
```

Read it for _cadence and stacking_, not just duration. A query that is slow once is a query bug; the same query starting every 2s is a client-side retry bug, and the fix belongs in the caller — not in engine tuning.

**Client retry shape is a database reliability property.** A degradable read whose caller retries without backoff converts one slow query into sustained load that blocks vacuum, inflates bloat, and amplifies I/O. Require bounded attempts plus backoff on anything calling a shared tenant, and treat an unbounded retry as a DB-impacting defect even though the code lives in the node.

#### Signatures that are routinely misread

- **`server process (PID n) exited with exit code 2`** is PostgreSQL's `quickdie()`/SIGQUIT path, not an OOM. On a real incident every memory check returned negative — cgroup `memory.events` `oom_kill 0`, `OOMKilled=false`, `RestartCount=0`, clean `dmesg`/`journalctl`, disk 73% with 27 GB free — and the _first_ dying backend logged nothing at all. The cascade that follows (`terminating any other active server processes`, then `57P02` / "terminating connection because of crash of another server process" in every client) is the consequence, so never diagnose from the client's view. Confirm with `prod-oom-misdiagnosis-taxonomy` before proposing memory or VM changes.
- **A healthy container proves nothing.** `Up 8 days (healthy)` with `RestartCount=0` coexisted with ~110 backend deaths per day; the healthcheck (`pg_isready`) only proves the postmaster answers.
- **Zero log lines means unobserved, not healthy.** A substrate absent from the host log-shipper allowlist returns empty for every query; check the allowlist before concluding a service is quiet or undeployed.
- **Statistics reset on container restart.** `n_live_tup`/`n_dead_tup` return to zero, so a bloat measurement taken after a restart is not comparable to one taken before. Use on-disk size for continuity.

## Layout at a glance

```
packages/db-schema/               @cogni/db-schema  (core, cross-node)
nodes/<node>/drizzle.config.ts    per-node config (CWD-relative globs, env-only DATABASE_URL)
nodes/<node>/app/.../migrations/  node-owned migration history
nodes/<node>/packages/db-schema/  @cogni/<node>-db-schema  (only created when node has local tables)
```

**No per-node schema package exists in this repo.** Nodes are their own repos; a node spins up `@cogni/<node>-db-schema` inside its own repo on its first node-local table — no empty scaffolds. The shared `packages/db-schema` is the operator/fleet schema.

## Postgres vs Doltgres — the first question for any new table

**Both DBs exist and serve different purposes. Choosing wrong is the hardest class of error to undo.**

|                | **Postgres**                                                                                                      | **Doltgres**                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it holds  | **Operational data** — auth, user activity, billing, scheduling, ingestion receipts, awareness-plane observations | **AI-written / AI-read knowledge** — compounding expertise, strategies, research notes, niche-domain facts, work items, prompt versions, evidence |
| Edit pattern   | Append-mostly. Rows written by humans or system flows; rarely revised after write. Historical integrity matters.  | Edit-and-refine. Rows are **expected to be churned** by agents over time as understanding deepens. Version history comes free via Dolt commits.   |
| Invariant test | "Does a human or system-of-record action generate this row?"                                                      | "Does an AI agent produce, refine, or cite this row as part of its reasoning loop?"                                                               |
| Examples today | `users`, `billing_accounts`, `credit_ledger`, `graph_runs`, `observations`, `poly_copy_trade_fills`               | `knowledge` (today's only table) — and every future row is an AI-editable fact with provenance                                                    |

If the new table is borderline, the tiebreaker is **"would versioned history be valuable on this?"** Yes → Doltgres. No → Postgres. An append-only Postgres table with a `created_at` column and no updates is a strong signal it belongs in Postgres; a table where rows get rewritten as confidence scores change or new evidence lands is a strong signal it belongs in Doltgres.

### Doltgres syntropy — prevent the exponential-entropy failure mode

Doltgres is easy to abuse: "I have a new domain, let me add `poly_strategies`, `poly_signals`, `poly_targets`, `poly_evaluations`, `poly_backtests`, …" — and now the AI has 20 tables to search across, each with a handful of rows, each with subtly different columns, and retrieval is fragmented.

**The syntropy rule for Doltgres: few tables, generic columns, domain specificity in rows (via `domain` + `tags`), schema refined over time.** Mirrors [knowledge-data-plane spec](../../../docs/spec/knowledge-data-plane.md) § "Generic schema, domain-specific content".

Before adding a Doltgres table, ask:

1. **Can this live as rows in `knowledge` with a different `domain` + `tags` set?** Almost always yes for v0/v1. Default: yes.
2. **Does it need genuinely different columns, or just a different shape of content?** Different content → rows. Different columns (FK references, typed enums, compound constraints) → maybe a new table.
3. **Will AI agents need to search it independently?** If the AI's natural query is "give me everything about prediction markets," a second table creates a join the AI has to remember. Stay in one table unless the domain boundary is sharp enough that cross-table queries are NEVER needed.

Companion tables (e.g., `poly_market_categories`) are allowed **when a genuinely new entity exists and is referenced from the base `knowledge` table**. They're not a license to shard `knowledge` by topic. See the knowledge-data-plane spec "If a domain truly needs domain-specific columns, it adds a companion table" for the sanctioned pattern.

### The anti-pattern to flag in review

> New Doltgres table per domain/feature. e.g., `poly_strategies`, `poly_signals`, `poly_targets` each with 5–15 rows.

Ask: "why not `knowledge` rows with `domain: '<node>-<topic>'`?" Usually there's no good answer. Reject and refactor into the base table unless there's a concrete entity (not a content category) that requires its own columns.

## Adding a table — decision flow

1. **Postgres or Doltgres?** See the split above. This is the first question — every later decision depends on it.
2. **Will anything outside the owning node import this?** (scheduler-worker, Temporal worker, graphs, another node's app)
   - Yes → core package (`packages/db-schema/src/<slice>.ts` for Postgres; core Doltgres packages don't exist yet — cross-node Doltgres would need a new shared package, file as a design task). See [packages/db-schema/AGENTS.md](../../../packages/db-schema/AGENTS.md) Change Protocol for the 4 coordinated edits (source file, index barrel, tsup entry, package.json exports).
   - No → node-local. Continue.
3. **Does the node already have the right per-node package?**
   - Postgres: `<node-repo>/packages/db-schema/` — in the NODE'S repo, not here.
   - Doltgres: `<node-repo>/packages/doltgres-schema/` — in the NODE'S repo, not here.
   - Yes → add a slice + update its 4 coordination points (package.json exports, tsup entry, barrel re-export, drizzle config glob — though the glob is `**/*.ts` so usually nothing to edit there).
   - No → create the package from the `node-template` pattern; add `"@cogni/<node>-{db,doltgres}-schema": "workspace:*"` to the node app's dependencies (if needed at runtime); update the appropriate `nodes/<node>/drizzle.{config,doltgres.config}.ts` schema array.
4. **Generate + apply:** `pnpm db:generate:<node>[:doltgres]` → inspect the SQL → `pnpm db:migrate:<node>[:doltgres]`.
5. **If CORE Postgres table:** copy the migration file + its `_journal.json` entry into every OTHER node's migrations dir. Drizzle-kit does not auto-propagate across nodes; each deployed DB needs its own applied copy so `__drizzle_migrations` hash lookups line up. (Doltgres is per-node today — no cross-node propagation needed yet.)

## Commands — see spec for the full list

Full command reference in [databases.md §2](../../../docs/spec/databases.md). Daily usage:

```bash
pnpm db:migrate:dev                  # migrate from .env.local (VERIFIED: the only :dev variant)
pnpm db:migrate:nodes                # all three
pnpm db:generate:operator            # generate a migration from a schema diff
pnpm db:setup:nodes                  # first-time: provision + migrate + seed
```

## Gotchas — practical discovery, not in specs

### Drizzle configs cannot use relative TS imports

drizzle-kit compiles the config to a temp directory before running. `import { X } from "./app/src/.../db-url"` fails with `Cannot find module './nodes/<node>/app/...'`. Fix: **no relative imports**, all paths in `schema:` / `out:` are repo-root-relative (`CWD=repo root`), and `DATABASE_URL` comes from `process.env` with a throw-if-missing guard. Look at any `nodes/<node>/drizzle.config.ts` for the canonical pattern.

### `0027_silent_nextwave.sql` is intentionally byte-duplicated

Shared-era migration applied to every deployed DB before the schema split. Each node's `migrations/` has the same SQL file + matching `meta/_journal.json` entry so hashes match the pre-existing `__drizzle_migrations` rows. Tripwire READMEs in those dirs explain; **do not "clean up" the duplicate** without coordinating across every deployed DB.

### node-template TODO: baseline-squash the migration history

New nodes replay operator's full `0000→0032` history (incl. the `0010`→`0032` epoch-RLS create-then-fix). Not a security risk — fresh DBs apply all migrations atomically before serving — but it's legacy baggage every fork inherits. Standard fix (Rails/Django/Atlas-style) is to collapse to a single `0000_init` baseline with RLS correct from the start. Deferred: it's a breaking op for deployed DBs (`__drizzle_migrations` reconciliation) and fights the immutability gate, so do it on the fresh `node-app` lineage, not operator. Tracked as `task.5018`.

### HISTORICAL (pre node-repo split): `drizzle-kit generate` emitted DROP migrations for orphan tables

Node-local tables can linger in the operator DB as harmless orphans from the shared-era apply, before nodes owned their own repos and DBs. Their configs no longer include those tables, so generate sees them as drift and wants to `DROP TABLE`. **Inspect any auto-generated migration; discard DROP statements for `poly_copy_trade_*`.** Orphans stay until an explicit future cleanup.

### `DATABASE_URL` must be set per-invocation — and only by the caller

No fallback. If you see `DATABASE_URL is required` thrown, check:

- pnpm scripts: `dotenv -e .env.local` / `-e .env.test` prefix (see `package.json` `db:migrate:*`)
- Component tests: `nodes/<node>/app/tests/component/setup/testcontainers-postgres.global.ts` assigns `process.env.DATABASE_URL` before `execSync('pnpm db:migrate:direct')`
- k8s: the `migrate-node-app` Job's env block has `DATABASE_URL` via `secretKeyRef`

### Cross-process imports go through the per-node package, not the app

scheduler-worker, Temporal worker, or any other service that needs a node's tables:

```ts
import { someTable } from "@cogni/<node>-db-schema/<module>";
```

**Do not** reach into a node app's `src/shared/db/` — that's the app's hex boundary. `@cogni/<node>-db-schema` exists as a workspace package precisely so cross-process consumers can import without that violation.

### A declared migration is not an applied migration

Do not infer live schema from an overlay, workflow, or green application rollout. Determine the node's current substrate from the catalog/repo-spec and rendered workload, then verify the migration step/receipt, tracking table, and expected live objects. Never hardcode a node roster or revive a vestigial Kubernetes path for an Akash-hosted node.

## Runtime backups and recovery

The contract lives in [databases.md](../../../docs/spec/databases.md) and the executable sources `infra/compose/runtime/db-backup/backup.sh`, `infra/compose/runtime/docker-compose.yml`, and the relevant flight workflow. Inspect those sources and live evidence; do not trust a copied cadence, retention value, or roster in this skill.

Durable rules:

- A same-host volume protects against logical mistakes, not loss of the host. Disaster recovery requires a verified off-host copy.
- A “completed” log line is not restore proof. Validate non-empty dumps, checksums/manifests, database coverage, and an actual restore drill.
- Exercise the real network/auth path; localhost or socket trust can hide credential drift.
- Production recovery and privileged SQL use the governed operator/runbook path. Routine SSH and ad-hoc direct writes are not the operating model.
- Registry or seed recovery must derive canonical identities from repo-spec/catalog and stable natural identifiers; never freeze environment-specific UUIDs or a node roster in this skill.

### Migration delivery uses the node runtime artifact

Postgres and Doltgres migration inputs ship in the **same immutable runtime image** as the app. Kubernetes expresses them as rollout-gating `migrate` / `migrate-doltgres` init containers. The Akash path derives explicit migration steps from the declared runtime profile and secrets, then materializes them through Crossplane. The command path follows the image layout (`/app/nodes/<node>/app/...` versus `/app/app/...`); a mismatch must fail before the app serves.

Canon: [databases.md §2](../../../docs/spec/databases.md). Current Akash implementation: `packages/repo-spec/src/node-app-deployment.ts` → `nodes/operator/app/src/features/compute/akash-tx/akash-tx-migration-step.ts` → `infra/crossplane/xcomputeworkload/composition.yaml`.

## Doltgres knowledge plane (per-node, parallel to the Postgres side)

Each node that adopts Doltgres follows the exact pattern above, but against a **separate** workspace package + drizzle config + migrations dir. Dialects do not mix in one package.

### Layout

```
nodes/<node>/packages/doltgres-schema/         @cogni/<node>-doltgres-schema (NEW per-node package, in the NODE'S repo)
nodes/<node>/drizzle.doltgres.config.ts        dialect: postgresql, schema glob targets ONLY the doltgres-schema package
nodes/<node>/app/src/adapters/server/db/doltgres-migrations/   generated SQL, checked in
```

No per-node Doltgres package lives in this repo. A node creates one in its own repository when it adopts Doltgres — don't pre-scaffold.

### Adding a Doltgres table

Identical to the Postgres flow — with one caveat:

1. Define the table in the node's doltgres-schema package.
2. `pnpm db:generate:operator:doltgres` — generates SQL. (Per-node variants live in the node's own repo.)
3. `pnpm db:migrate:operator:doltgres` (local dev) or deploy pipeline (candidate-a+) applies via drizzle-kit migrate.
4. **One Dolt-specific step**: the Doltgres migration runner performs a trailing `SELECT dolt_commit('-Am', ...)`. This captures DDL in `dolt_log`; without it, changes may remain only in the working set ([dolt#4843](https://github.com/dolthub/dolt/issues/4843)). Verify the current implementation in the node's `migrate-doltgres.mjs` and shared migration helpers rather than assuming a Compose sidecar exists.

### Migration artifact and runtime wiring

A node's runtime image carries both Postgres and, when adopted, Doltgres migration inputs. The substrate runs the same digest with different commands:

- `migrate.mjs <postgres-migrations-dir>` — operational Postgres
- `migrate-doltgres.mjs <doltgres-migrations-dir>` — knowledge Doltgres

For Akash nodes, the `cogni-node-app-v1` runtime profile declares `DOLTGRES_URL`; that declaration enables the typed `migrate-doltgres` step. For Kubernetes, the overlay adds the corresponding init container. Do not reintroduce a separately tagged migrator image or workflow-only image variable.

### Doltgres is NOT a drop-in in every way — two caveats verified against 0.56.0

1. **Runtime tagged-template parameterized queries fail** with `unhandled message "&{}"` (extended query protocol). The `DoltgresKnowledgeStoreAdapter` uses `sql.unsafe()` for all runtime reads/writes because of this. Don't try to "upgrade" the adapter to tagged-templates.
2. **`ON CONFLICT ... EXCLUDED` is unreliable.** The adapter uses a try-INSERT / catch-duplicate / fallback-UPDATE pattern instead. Don't fold it back to the simpler ON CONFLICT form.

Everything schema-time (drizzle-kit migrate, `CREATE SCHEMA`, `__drizzle_migrations__` tracking table, idempotent re-runs) works natively as of Doltgres 0.56.0 — validated end-to-end.

### Proving Doltgres migrations actually ran

The old claim that Poly required a workflow-provided `POLY_MIGRATOR_IMAGE` is obsolete. Absence of that variable does **not** prove missing schema wiring. Diagnose the current path end to end:

1. Confirm the node declares the Doltgres secret/DSN in its runtime profile (`DOLTGRES_URL`).
2. Confirm the built runtime digest contains `migrate-doltgres.mjs`, the migration directory, and the schema verifier it imports.
3. Confirm the rendered workload contains a rollout-gating `migrate-doltgres` step using that same digest.
4. Inspect the migration step status/logs and tracking table.
5. Prove the expected live schema and a committed migration entry in `dolt_log`.

Wiring present is not schema present; schema present is not a committed Dolt history. Require all relevant proofs before declaring the knowledge plane healthy.

### Doltgres-specific gotchas

- **Connects as the `postgres` superuser — RBAC is table-DML-only.** Doltgres `0.56.3` implements only table-level `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` grants (no function/schema/role privileges, no `ALTER DEFAULT PRIVILEGES`), so per-node `knowledge_<node>` roles can't run the migrator or app — every node's `DOLTGRES_URL` uses the env superuser. As-built rationale + the upstream trigger to swap to per-node roles: [databases.md §5.2](../../../docs/spec/databases.md).
- **`SET @@dolt_transaction_commit = 1` is MySQL-dialect syntax** — not verified on Doltgres's pg wire protocol. Don't add it to compose/scripts. The explicit trailing `SELECT dolt_commit('-Am', ...)` pattern is the repo's verified approach.
- **DROP SCHEMA … CASCADE is not supported** (per the 0.56.0 error message). Drop tables individually, then DROP SCHEMA.
- **Per-node DB name convention**: `cogni_<node>` (Postgres) → `knowledge_<node>` (Doltgres). `provision.sh` derives one from the other.
- **Port 5435** on the host (not 5432 — Postgres owns that). k8s pods reach via `{node}-doltgres-external` EndpointSlice → node InternalIP:5435.

### DoltHub repo formation gotchas (verified in PR #1527)

- **Repeated same-owner forks from one template do not work.** Live test:
  `cogni-dao/knowledge-node-template` → `cogni-dao/knowledge-<node>` failed
  once the owner already had a fork in that network with `owner already owns a
repository in the same network`. For v0 node formation, create a fresh DoltHub
  database with `POST /api/v1alpha1/database` instead of forking a template.
- **Empty DoltHub repos cannot be useful fork templates.** The initial
  `knowledge-node-template` had no contents; initializing it with a SQL write
  fixed the empty-template problem but not the same-owner fork-network limit.
  vNext fork alignment needs a one-fork-per-owner topology or a non-fork clone
  path, not repeated forks under one owner.
- **PAT creates REST/SQL databases; Dolt push uses Dolt creds.**
  `DOLTHUB_API_TOKEN` with API read/write rights successfully created
  `cogni-test-nodes/knowledge-e2e-*`, wrote
  `cogni_external_probe`, polled the write op to `Success`, and read back
  `[{ label: "ok" }]`. That PAT does not authenticate `dolt push`; push still
  requires `DOLT_CREDS_JWK` + `DOLT_CREDS_KEYID` with the pubkey registered in
  DoltHub settings.
- **Environment owner must be explicit.** Do not default test/preview/candidate
  to `cogni-dao`. `DOLTHUB_OWNER` is the boundary: production uses `cogni-dao`,
  non-prod uses a Dolt test org such as `cogni-test-nodes`, and publish should
  fail closed when `DOLTHUB_API_TOKEN` is present without `DOLTHUB_OWNER`.

## When to promote a node-local slice to core

Trigger: a second node genuinely needs the same table (import would cross node boundaries). **One-way move** — flipping back and forth causes migration file churn. Rule of thumb: core = strict intersection. When in doubt, keep node-local.

## Future: Atlas (task.0325, deferred)

Atlas + Drizzle official integration; `atlas migrate diff`, destructive-change linting, `AtlasMigration` CRD replacing PreSync Jobs. Triggers to revisit: ~3+ contributors regularly touching schema, weekly core changes, destructive-change prevention becomes a priority. Full spike intel in the task body — don't re-spike.

## Related skills

- **devops-expert** — CI/CD pipeline, migrator image build wiring, promote-and-deploy flow
- **test-expert** — testcontainers DB setup, `.env.test` flow
- **deploy-node / deploy-operator** — per-env provisioning, prod cutover procedure

## Anti-patterns to flag in review

- Treating DB-per-node as compute/resource isolation; it is a logical schema/security/migration boundary on shared compute
- Adding more nodes to shared Postgres without automatic per-database metering and per-role/pool bounds
- Upsizing the shared VM or globally tuning Postgres before bounding and attributing the noisy tenant
- Hardcoding a fleet-wide graduation threshold here instead of keeping policy with the live scorecard/SLO
- Hand-configuring an exporter/dashboard for each node instead of collecting bounded cluster-wide metrics keyed by database
- Letting candidate/preview load share an unbounded production failure domain
- Giving a developer/agent an environment-wide DB credential, or using routine SSH/ad-hoc production SQL instead of the node-scoped governed access plane
- Misclassifying PostgreSQL `/dev/shm` exhaustion as OOM, treating query parallelism as all parallelism, or copying PostgreSQL tuning to a wire-compatible non-PostgreSQL engine
- Inferring a missing Doltgres migration from absent `POLY_MIGRATOR_IMAGE`; prove the runtime migration step, live schema, tracking row, and `dolt_log`
- Node-specific table added to `@cogni/db-schema`
- `@cogni/<node>-db-schema` imported from a different node
- Relative TS import or hard-coded DSN inside a drizzle config
- `buildDatabaseUrl` inside a drizzle config (tooling-only; also breaks inside drizzle-kit's temp compile)
- `drizzle-kit migrate` run directly against any prod node DB (go through the candidate-a → preview → promote chain)
- Deleting `0027_silent_nextwave.sql` from any node without coordinating across all deployed DBs' `__drizzle_migrations`
- Auto-generated `DROP TABLE` for another node's orphan tables (orphans are intentional)
- Component-piece fallback (`POSTGRES_HOST`, etc.) added to any new script — explicit DSN or fail fast
- Doltgres table added to a Postgres-targeted package (`@cogni/db-schema` or `@cogni/<node>-db-schema`) — dialects must stay separated via per-package path
- `@cogni/<node>-doltgres-schema` path included in `nodes/<node>/drizzle.config.ts` (Postgres) — would cause Postgres to try creating knowledge tables
- `sql\`... WHERE id = ${x}\``tagged-template parameterized queries added to the Doltgres adapter — extended protocol unsupported; use`sql.unsafe()`
- `ON CONFLICT ... EXCLUDED` added to any Doltgres write path — use try-INSERT / catch-duplicate / fallback-UPDATE instead
- `SET @@dolt_transaction_commit = 1` added to a script targeting Doltgres — MySQL-dialect syntax, unverified on pg wire
- Missing trailing `SELECT dolt_commit('-Am', ...)` after a Doltgres schema change — working-set changes exist but not captured in `dolt_log` (per dolt#4843)
- New Doltgres table per domain or feature when it could be rows in the existing `knowledge` table with a different `domain` + `tags` — violates syntropy, fragments AI retrieval across tables
- Operational/human-sourced data added to Doltgres — auth events, billing, user activity, ingestion receipts belong in Postgres; Doltgres is for AI-written compounding knowledge
- AI-written/refined knowledge added to Postgres — strategy notes, research, confidence-scored observations belong in Doltgres; Postgres lacks the version history those edits deserve
- Database or Temporal Postgres changes that are not considered against the `db-backup` contract — new runtime DB services need either inclusion in `backup.sh` or an explicit documented reason they are ephemeral/reconstructable
- Calling same-VM `db_backups` disaster recovery — it is a local backup tier only until off-host storage and restore drills are wired and flight-validated
