---
name: database-expert
description: Cogni-template DB architecture reference — Postgres-vs-Doltgres split (operational vs AI-written data), per-node schema independence, drizzle configs, RLS (`app_user`/`app_service`), migrator images, Doltgres syntropy rules, and the gotchas. Use when adding/modifying DB tables, deciding which DB a new table belongs in, writing migrations, running `pnpm db:*`, debugging drizzle-kit errors, touching `@cogni/db-schema` or any `@cogni/<node>-{db,doltgres}-schema`, or dealing with `DATABASE_URL` / `DOLTGRES_URL` / `__drizzle_migrations` / per-node migrator Dockerfiles.
---

# database-expert

Navigation aid for database schema, migrations, and DSN plumbing. Per-node schema independence (task.0324) is recent — most gotchas trace back to that layout not being internalized yet. **Always consult the specs first; this skill's job is to point, not to restate.**

## Ground truth — open these, don't restate them here

- [docs/spec/databases.md](../../../docs/spec/databases.md) — authoritative architecture, invariants (enumerated in §2), commands, migrator image shape. Treat this as canon.
- [docs/spec/database-rls.md](../../../docs/spec/database-rls.md) — two-user RLS (`app_user` + `app_service`), `SET LOCAL app.current_user_id`, dep-cruiser rule on `getServiceDb()` (only importable from `drizzle.service-client.ts`).
- [docs/spec/database-url-alignment.md](../../../docs/spec/database-url-alignment.md) — explicit-DSN invariant, no component-piece fallback at runtime.
- [docs/spec/multi-node-tenancy.md](../../../docs/spec/multi-node-tenancy.md) — DB-per-node boundary (the database IS the tenant, not a column).
- [docs/guides/multi-node-dev.md](../../../docs/guides/multi-node-dev.md) — per-node dev commands + local setup.
- `infra/compose/runtime/docker-compose.yml` + `infra/compose/runtime/db-backup/backup.sh` — runtime Postgres backup job for app Postgres + Temporal Postgres; candidate-flight-infra validates health, manifests, and Loki logs.
- [work/items/task.0324…md](../../../work/items/task.0324.per-node-db-schema-independence.md) — why the current shape exists; task body has design history.
- [work/items/task.0325…md](../../../work/items/task.0325.atlas-gitops-migrations.md) — Atlas spike intel, deferred.
- `nodes/poly/packages/db-schema/AGENTS.md` — reference example for the per-node db-schema package pattern (fork it for new nodes).
- READMEs under `nodes/<node>/app/src/adapters/server/db/migrations/` — tripwires explaining the shared-era `0027_silent_nextwave.sql` duplicate.
- [docs/spec/knowledge-data-plane.md](../../../docs/spec/knowledge-data-plane.md) — Doltgres knowledge plane architecture (separate from the awareness/Postgres side).
- [work/items/task.0311…md](../../../work/items/task.0311.poly-knowledge-syntropy-seed.md) — why the Doltgres migrator pattern (per-node migrator image + trailing `dolt_commit`) exists; body has the Doltgres 0.56.0 compatibility test results.
- `nodes/poly/packages/doltgres-schema/AGENTS.md` — reference example for the per-node doltgres-schema package pattern (fork it when a node adopts Doltgres).

## Layout at a glance

```
packages/db-schema/               @cogni/db-schema  (core, cross-node)
nodes/<node>/drizzle.config.ts    per-node config (CWD-relative globs, env-only DATABASE_URL)
nodes/<node>/app/.../migrations/  node-owned migration history
nodes/<node>/packages/db-schema/  @cogni/<node>-db-schema  (only created when node has local tables)
```

Only `@cogni/poly-db-schema` exists today. Resy/operator/node-template spin up a per-node package on their first node-local table — no empty scaffolds.

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

Ask: "why not `knowledge` rows with `domain: 'poly-strategies'`?" Usually there's no good answer. Reject and refactor into the base table unless there's a concrete entity (not a content category) that requires its own columns.

## Adding a table — decision flow

1. **Postgres or Doltgres?** See the split above. This is the first question — every later decision depends on it.
2. **Will anything outside the owning node import this?** (scheduler-worker, Temporal worker, graphs, another node's app)
   - Yes → core package (`packages/db-schema/src/<slice>.ts` for Postgres; core Doltgres packages don't exist yet — cross-node Doltgres would need a new shared package, file as a design task). See [packages/db-schema/AGENTS.md](../../../packages/db-schema/AGENTS.md) Change Protocol for the 4 coordinated edits (source file, index barrel, tsup entry, package.json exports).
   - No → node-local. Continue.
3. **Does the node already have the right per-node package?**
   - Postgres: `nodes/<node>/packages/db-schema/` (only poly does today).
   - Doltgres: `nodes/<node>/packages/doltgres-schema/` (only poly does today).
   - Yes → add a slice + update its 4 coordination points (package.json exports, tsup entry, barrel re-export, drizzle config glob — though the glob is `**/*.ts` so usually nothing to edit there).
   - No → create the package by copying the poly version; add `"@cogni/<node>-{db,doltgres}-schema": "workspace:*"` to the node app's dependencies (if needed at runtime); update the appropriate `nodes/<node>/drizzle.{config,doltgres.config}.ts` schema array.
4. **Generate + apply:** `pnpm db:generate:<node>[:doltgres]` → inspect the SQL → `pnpm db:migrate:<node>[:doltgres]`.
5. **If CORE Postgres table:** copy the migration file + its `_journal.json` entry into every OTHER node's migrations dir. Drizzle-kit does not auto-propagate across nodes; each deployed DB needs its own applied copy so `__drizzle_migrations` hash lookups line up. (Doltgres is per-node today — no cross-node propagation needed yet.)

## Commands — see spec for the full list

Full command reference in [databases.md §2](../../../docs/spec/databases.md). Daily usage:

```bash
pnpm db:migrate:{dev,poly,resy}      # migrate one node's DB from .env.local
pnpm db:migrate:nodes                # all three
pnpm db:generate:{operator,poly,resy} # generate a migration from a schema diff
pnpm db:setup:nodes                  # first-time: provision + migrate + seed
```

## Gotchas — practical discovery, not in specs

### Drizzle configs cannot use relative TS imports

drizzle-kit compiles the config to a temp directory before running. `import { X } from "./app/src/.../db-url"` fails with `Cannot find module './nodes/<node>/app/...'`. Fix: **no relative imports**, all paths in `schema:` / `out:` are repo-root-relative (`CWD=repo root`), and `DATABASE_URL` comes from `process.env` with a throw-if-missing guard. Look at any `nodes/<node>/drizzle.config.ts` for the canonical pattern.

### `0027_silent_nextwave.sql` is intentionally byte-duplicated

Shared-era migration applied to every deployed DB before the schema split. Each node's `migrations/` has the same SQL file + matching `meta/_journal.json` entry so hashes match the pre-existing `__drizzle_migrations` rows. Tripwire READMEs in those dirs explain; **do not "clean up" the duplicate** without coordinating across every deployed DB.

### `drizzle-kit generate` on operator/resy will emit DROP migrations for orphan poly tables

`poly_copy_trade_*` exists in operator/resy DBs as harmless orphans from the shared-era apply. Their configs no longer include those tables, so generate sees them as drift and wants to `DROP TABLE`. **Inspect any auto-generated migration; discard DROP statements for `poly_copy_trade_*`.** Orphans stay until an explicit future cleanup.

### `DATABASE_URL` must be set per-invocation — and only by the caller

No fallback. If you see `DATABASE_URL is required` thrown, check:

- pnpm scripts: `dotenv -e .env.local` / `-e .env.test` prefix (see `package.json` `db:migrate:*`)
- Component tests: `nodes/<node>/app/tests/component/setup/testcontainers-postgres.global.ts` assigns `process.env.DATABASE_URL` before `execSync('pnpm db:migrate:direct')`
- k8s: the `migrate-node-app` Job's env block has `DATABASE_URL` via `secretKeyRef`

### Cross-process imports go through the per-node package, not the app

scheduler-worker, Temporal worker, or any other service that needs poly tables:

```ts
import { polyCopyTradeFills } from "@cogni/poly-db-schema/copy-trade";
```

**Do not** reach into `nodes/poly/app/src/shared/db/` — that's the app's hex boundary. `@cogni/poly-db-schema` exists as a workspace package precisely so cross-process consumers can import without that violation.

### Prod poly/resy migration Jobs are currently `exit 0` no-ops

`infra/k8s/overlays/production/{poly,resy}/kustomization.yaml:95` deliberately short-circuits. Un-no-opping is task.0324 Phase 3 — gated on `pg_dump` inspection of each prod DB first (current state unverified). **Do not flip these flags** without the snapshot-restore rehearsal.

## Runtime backups — candidate-a/preview/prod Compose infra

App Postgres and Temporal Postgres are backed up by the Compose `db-backup` profile service in `infra/compose/runtime/docker-compose.yml` (dev parity in `docker-compose.dev.yml`). It uses the official `postgres:15` image and the script at `infra/compose/runtime/db-backup/backup.sh`. On deployed VMs, `scripts/ci/deploy-infra.sh` installs `cogni-db-backup.timer`, which runs the service as a one-shot container instead of keeping a privileged DB client idle on the network.

What it does:

- Backs up app Postgres (`postgres:5432`) and Temporal Postgres (`temporal-postgres:5432`).
- Runs only when invoked: candidate-flight-infra forces one validation run, and the host systemd timer runs it every `DB_BACKUP_INTERVAL_SECONDS` (default 86400 = 24h).
- Waits `DB_BACKUP_OBSERVABILITY_GRACE_SECONDS` (default 90) before exit so Alloy can scrape one-shot container logs.
- Retains backups for `DB_BACKUP_RETENTION_DAYS` (default 14).
- Writes timestamped directories under the persistent Docker volume `db_backups`.
- Each backup dir contains `globals.sql`, one custom-format `pg_dump` file per database, and `MANIFEST.sha256`.
- Emits JSON logs with `event="db_backup.completed"` and `cluster="app"` / `cluster="temporal"`.

The candidate-a infra lever proves this path. `scripts/ci/deploy-infra.sh` installs/enables the timer, restarts Alloy when the log allowlist changes, forces a validation backup, verifies both latest manifests, and prints `db_backup.completed` logs. `.github/workflows/candidate-flight-infra.yml` then queries Loki for `{env="candidate-a",service="db-backup"} | json | event="db_backup.completed"` and requires hits for both clusters.

Known scope: this is same-VM persistent-volume backup. It protects against logical DB damage and operator mistakes, not full VM loss. Do not claim disaster recovery until an off-host object store sink and restore drill exist. The next hardening step is S3-compatible storage (or equivalent OSS object store) plus a scheduled restore rehearsal.

### Migrations run inline as an initContainer (no separate migrator image)

`task.0371` retired the separate `-migrate` image + Argo PreSync Job. Postgres + Doltgres migrations now run as the Deployment's `migrate` / `migrate-doltgres` **initContainers off the same runtime image** as the app, gated by rollout. The migrate runner path follows the node's image layout — `/app/nodes/<node>/app/migrate.mjs` (in-tree monorepo) vs `/app/app/migrate.mjs` (wizard-born node-at-root); the node's overlay declares it, and a layout mismatch is a `MODULE_NOT_FOUND` crash-loop before any DB connect. Canon + the layout contract: [databases.md §2](../../../docs/spec/databases.md). (The compose/`deploy-infra` Doltgres migrator on the VM is a separate path — see `POLY_MIGRATOR_IMAGE` below.)

## Doltgres knowledge plane (per-node, parallel to the Postgres side)

Each node that adopts Doltgres follows the exact pattern above, but against a **separate** workspace package + drizzle config + migrations dir. Dialects do not mix in one package.

### Layout

```
nodes/<node>/packages/doltgres-schema/         @cogni/<node>-doltgres-schema (NEW per-node package; only poly today)
nodes/<node>/drizzle.doltgres.config.ts        dialect: postgresql, schema glob targets ONLY the doltgres-schema package
nodes/<node>/app/src/adapters/server/db/doltgres-migrations/   generated SQL, checked in
```

Only `@cogni/poly-doltgres-schema` exists today (task.0311). Operator/resy spin up their own packages when they adopt Doltgres — don't pre-scaffold.

### Adding a Doltgres table

Identical to the Postgres flow — with one caveat:

1. Define the table in the node's doltgres-schema package.
2. `pnpm db:generate:poly:doltgres` — generates SQL.
3. `pnpm db:migrate:poly:doltgres` (local dev) or deploy pipeline (candidate-a+) applies via drizzle-kit migrate.
4. **One Dolt-specific step**: the migrator compose service chains a trailing `doltgres-commit-poly` (postgres:15 + psql one-shot) that runs `SELECT dolt_commit('-Am', 'migration: drizzle-kit batch')`. This captures DDL into `dolt_log`; without it, drizzle-kit's changes exist in the working set but aren't committed to the Dolt history ([dolt#4843](https://github.com/dolthub/dolt/issues/4843)).

### Migrator image reuse

The poly migrator image (`nodes/poly/app/Dockerfile AS migrator`) carries BOTH Postgres AND Doltgres migration inputs — same image, different entry command:

- `pnpm db:migrate:poly:container` — Postgres (default CMD)
- `pnpm db:migrate:poly:doltgres:container` — Doltgres (compose overrides command)

When operator/resy adopt Doltgres, their `Dockerfile AS migrator` extends similarly.

### Doltgres is NOT a drop-in in every way — two caveats verified against 0.56.0

1. **Runtime tagged-template parameterized queries fail** with `unhandled message "&{}"` (extended query protocol). The `DoltgresKnowledgeStoreAdapter` uses `sql.unsafe()` for all runtime reads/writes because of this. Don't try to "upgrade" the adapter to tagged-templates.
2. **`ON CONFLICT ... EXCLUDED` is unreliable.** The adapter uses a try-INSERT / catch-duplicate / fallback-UPDATE pattern instead. Don't fold it back to the simpler ON CONFLICT form.

Everything schema-time (drizzle-kit migrate, `CREATE SCHEMA`, `__drizzle_migrations__` tracking table, idempotent re-runs) works natively as of Doltgres 0.56.0 — validated end-to-end.

### POLY_MIGRATOR_IMAGE env var (current gap)

`docker-compose.yml`'s `doltgres-migrate-poly` service reads `${POLY_MIGRATOR_IMAGE:-unused-by-infra-deploy}`. `deploy-infra.sh` gates the `run --rm` invocation on `-n "$POLY_MIGRATOR_IMAGE"`. Today neither `candidate-flight-infra.yml` nor `promote-and-deploy.yml` sets this env var, so Doltgres comes up + provisions but the schema isn't applied (warn-and-continue). Remediation: either self-resolve the image in deploy-infra.sh (mirror the `LITELLM_IMAGE` pattern at line ~547) or add as a workflow input. Tracked as task.0311 follow-up #1.

### Doltgres-specific gotchas

- **`SET @@dolt_transaction_commit = 1` is MySQL-dialect syntax** — not verified on Doltgres's pg wire protocol. Don't add it to compose/scripts. The explicit trailing `SELECT dolt_commit('-Am', ...)` pattern is the repo's verified approach.
- **DROP SCHEMA … CASCADE is not supported** (per the 0.56.0 error message). Drop tables individually, then DROP SCHEMA.
- **Per-node DB name convention**: `cogni_<node>` (Postgres) → `knowledge_<node>` (Doltgres). `provision.sh` derives one from the other.
- **Port 5435** on the host (not 5432 — Postgres owns that). k8s pods reach via `{node}-doltgres-external` EndpointSlice → node InternalIP:5435.

### DoltHub repo formation gotchas (verified in PR #1527)

- **Repeated same-owner forks from one template do not work.** Live test:
  `cogni-dao/knowledge-node-template` → `cogni-dao/knowledge-<node>` failed
  once the owner already had a fork in that network with `owner already owns a
repository in the same network`. For v0 node birth, create a fresh DoltHub
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

- Node-specific table added to `@cogni/db-schema`
- `@cogni/poly-db-schema` imported from a non-poly node
- Relative TS import or hard-coded DSN inside a drizzle config
- `buildDatabaseUrl` inside a drizzle config (tooling-only; also breaks inside drizzle-kit's temp compile)
- `drizzle-kit migrate` run directly against prod poly/resy (go through the candidate-a → preview → promote chain)
- Deleting `0027_silent_nextwave.sql` from any node without coordinating across all deployed DBs' `__drizzle_migrations`
- Auto-generated `DROP TABLE "poly_copy_trade_*"` committed on operator/resy (orphans are intentional)
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
