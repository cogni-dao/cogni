---
id: databases-spec
type: spec
title: Database & Migration Architecture
status: active
trust: draft
summary: Database organization, migration strategies, and URL construction patterns
read_when: Working with databases, migrations, or connection configuration
owner: derekg1729
created: 2026-02-05
verified: 2026-04-18
tags: [databases]
---

# Database & Migration Architecture

This document describes database organization, migration strategies, and database-specific configuration patterns.

**For stack deployment modes and environment details, see [Environments](environments.md).**

## Quick Start: Primary Development Workflow

**If you only need to know ONE thing:**

```bash
# Daily development (fake adapters, no external API calls)
pnpm dev:stack:test           # Start app + infrastructure in test mode
pnpm dev:stack:test:setup     # First time: create test DB + migrate
pnpm test:stack:dev           # Run stack tests
```

**For real AI calls (production adapters):**

```bash
pnpm dev:stack                # Same as above, but hits real LiteLLM/OpenRouter
```

**Docker stacks:** Used primarily in CI, not required for daily development. See sections 2.3-2.5 for details.

---

## Database Separation

**Database Security Model**: Two-user PostgreSQL architecture separating administrative and application access.

**Per-Node Databases (DB_PER_NODE):** Each node gets its own database on a shared Postgres server. The database IS the node boundary — no tenancy columns. See [Multi-Node Tenancy](multi-node-tenancy.md).

**Postgres vs Doltgres:** This spec covers the Postgres (awareness plane) side. The knowledge plane runs on a separate Doltgres server with per-node `knowledge_<node>` databases and git-like versioning — see [Knowledge Data Plane](knowledge-data-plane.md).

| Environment | Databases                                                         | Configured via                   |
| ----------- | ----------------------------------------------------------------- | -------------------------------- |
| Development | `cogni_operator`, `cogni_poly`, `cogni_resy`                      | `COGNI_NODE_DBS` in `.env.local` |
| Test        | `cogni_template_stack_test`, `cogni_poly_test`, `cogni_resy_test` | `COGNI_NODE_DBS` in `.env.test`  |
| CI          | `cogni_template_test`                                             | `COGNI_NODE_DBS` in `ci.yaml`    |
| Production  | `cogni_operator` (single-node for now)                            | `COGNI_NODE_DBS` in deploy env   |

`COGNI_NODE_DBS` is required — `provision.sh` fails fast if not set. No defaults, no fallback chain.

All stack deployment modes use the same migration tooling but connect to appropriate database instances. Test environments always use the test database and reset it between test runs.

## Database Provisioning (Infrastructure-as-Code)

To ensure a repeatable and consistent database state across environments (especially for `docker compose` setups), we use a dedicated provisioning service.

### The `db-provision` Service

In `docker-compose.dev.yml`, the `db-provision` service handles:

1. **Per-node database creation**: Iterates over `COGNI_NODE_DBS` (comma-separated), creates each database with `app_user` ownership and RLS role hardening.
2. **LiteLLM database creation**: Creates `LITELLM_DB_NAME` (root-owned, shared across nodes).
3. **Role provisioning**: Creates `app_user` (RLS enforced), `app_service` (BYPASSRLS), and `app_readonly` (SELECT-only, BYPASSRLS for Grafana/agent debugging) roles, shared across all node databases.

Both `COGNI_NODE_DBS` and `LITELLM_DB_NAME` are required — `provision.sh` fails immediately if either is missing.

This service is gated behind the `bootstrap` profile and runs only when explicitly requested.

### Development vs. Production Roles

- **Development:** Local dev connects via `app_user` (RLS enforced), `app_service` (BYPASSRLS), and local Grafana can read through `app_readonly`. `provision.sh` applies RLS role hardening to all node databases.
- **Production:** Same role model. The application user should NOT have `DROP` or `TRUNCATE` permissions on the schema in production. Grafana/agent DB access must use the read-only role, not `app_service`.

## Current Schema Baseline (Phase 0)

- **billing_accounts** — `id` (text PK), `owner_user_id` (unique), `balance_credits BIGINT DEFAULT 0`, timestamps.
- **virtual_keys** — `id` (uuid PK), `billing_account_id` (FK → billing_accounts, cascade), `litellm_virtual_key`, labels/flags, timestamps.
- **credit_ledger** — `id` (uuid PK), `billing_account_id` (FK → billing_accounts, cascade), `virtual_key_id` (FK → virtual_keys, cascade, NOT NULL), `amount BIGINT`, `balance_after BIGINT DEFAULT 0`, `reason`, optional reference/metadata, timestamps.
- Credits are stored as whole units (Stage 6.5 invariant: 1 credit = $0.001 USD, 1 USDC = 1,000 credits). Keep all arithmetic integer-only; no fractional credits.
- Optional: make `credit_ledger.virtual_key_id` nullable if you need ledger rows that are not tied to a specific virtual key (e.g., admin adjustments). Not required for the MVP if every entry is keyed.

## Database URL Configuration

Per [Database RLS Spec](database-rls.md) design decision 7, the runtime app requires **explicit DSN environment variables** — no component-piece fallback.

**Required Environment Variables:**

- `DATABASE_URL` — app_user role (RLS enforced), used by Next.js request paths
- `DATABASE_SERVICE_URL` — app_service role (BYPASSRLS), used by auth, workers, bootstrap

**Startup Invariants (enforced by `assertEnvInvariants`):**

- Both DSNs must use distinct PostgreSQL users
- Neither DSN may use superuser names (`postgres`, `root`, `admin`)
- Both DSNs must be present

**Environment Examples:**

- **Local development:** `postgresql://app_user:password@localhost:55432/cogni_template_dev`
- **Local testing:** `postgresql://app_user:password@localhost:55432/cogni_template_stack_test`
- **Production:** `postgresql://app_user:<secret>@postgres:5432/cogni_template_production?sslmode=require`

**Tooling-Only:** The `buildDatabaseUrl()` helper in `nodes/<node>/app/src/shared/db/db-url.ts` is used only by CLI test tooling (`drop-test-db.ts`, `reset-db.ts`). It is **not** used by the runtime app and **not** used by drizzle configs — per-node drizzle configs (`nodes/<node>/drizzle.config.ts`) require `DATABASE_URL` from env explicitly (task.0324).

## Database Security Architecture

**Four-Role Model**: Production deployments use separate PostgreSQL roles:

- **Root User** (`POSTGRES_ROOT_USER`): Database server administration, user/database creation
- **Application User** (`app_user` via `APP_DB_USER`): Runtime web app connections, RLS enforced
- **Service User** (`app_service` via `APP_DB_SERVICE_PASSWORD`): Privileged system user. Scheduler workers and pre-auth lookups, BYPASSRLS. Connects via `DATABASE_SERVICE_URL`.
- **Read-Only User** (`app_readonly` via `APP_DB_READONLY_USER`): Grafana/agent support queries, BYPASSRLS for v0 cross-tenant reads, no write grants.

See [Database RLS Spec](database-rls.md) for the dual-client architecture and static import enforcement.

**Container Configuration**: The `db-provision` service runs `provision.sh`:

- Creates roles: `app_user` (RLS), `app_service` (BYPASSRLS), `app_readonly` (SELECT-only, BYPASSRLS)
- Iterates `COGNI_NODE_DBS`: creates each database with ownership + RLS hardening
- Creates `LITELLM_DB_NAME`: root-owned, shared LiteLLM database

**Provisioning Variables** (used by `provision.sh`, not by runtime app):

| Variable                   | Purpose                             | Required            |
| -------------------------- | ----------------------------------- | ------------------- |
| `POSTGRES_ROOT_USER`       | Superuser for role/DB creation      | Yes                 |
| `POSTGRES_ROOT_PASSWORD`   | Superuser password                  | Yes                 |
| `COGNI_NODE_DBS`           | Comma-separated node database names | Yes (no default)    |
| `LITELLM_DB_NAME`          | LiteLLM database name               | Yes (no default)    |
| `APP_DB_USER`              | Application role name               | Yes                 |
| `APP_DB_PASSWORD`          | Application role password           | Yes                 |
| `APP_DB_SERVICE_USER`      | Service role name                   | Yes                 |
| `APP_DB_SERVICE_PASSWORD`  | Service role password               | Yes                 |
| `APP_DB_READONLY_USER`     | Read-only Grafana role name         | No (`app_readonly`) |
| `APP_DB_READONLY_PASSWORD` | Read-only Grafana role password     | No (derived)        |

**Runtime Variables** (used by app, never by provisioning):

| Variable               | Purpose                      |
| ---------------------- | ---------------------------- |
| `DATABASE_URL`         | app_user role (RLS enforced) |
| `DATABASE_SERVICE_URL` | app_service role (BYPASSRLS) |

> **Note:** The runtime app never receives `POSTGRES_ROOT_*`, `APP_DB_*`, or `COGNI_NODE_DBS`. These are provisioning-only.

## 2. Migration Strategy

**Core Principle:** Each node owns its migrations and runs them as a Deployment **initContainer** off the runtime image. task.0324 split the previously-shared drizzle config into per-node configs (`nodes/<node>/drizzle.config.ts`). task.0370 rebased the migrator stage on `runner` and swapped drizzle-kit for `drizzle-orm/postgres-js/migrator`. task.0371 retired the separate `cogni-template-migrate` image and the Argo PreSync hook Jobs entirely — migrations now run inline on pod start, gated by `kubectl rollout status`.

**Architecture:**

- **One image per node:** `ghcr.io/cogni-dao/cogni-template:{tag}-{operator,poly,resy}` — single runtime image. Built from `nodes/<node>/app/Dockerfile` `runner` stage. The runner ships migration SQL + per-node `migrate.mjs` alongside the standalone Next.js bundle (which already carries `drizzle-orm` + `postgres` as production deps via `serverExternalPackages`). `next.config.ts` forces `outputFileTracingIncludes` of the full `drizzle-orm/**/*` + `postgres/**/*` packages so the standalone bundle has their `package.json` + `exports` map.
- **Deployment initContainer:** `infra/k8s/base/node-app/deployment.yaml` declares `initContainers: [migrate]` using the same image as the main container. CMD: `["/bin/sh", "-c", "exec node /app/nodes/$(NODE_NAME)/app/migrate.mjs /app/nodes/$(NODE_NAME)/app/migrations"]`. `NODE_NAME` comes from `node-app-config` (per-overlay configmap patch).
- **Migration runner script:** `nodes/<node>/app/src/adapters/server/db/migrate.mjs` invokes `drizzle-orm/postgres-js/migrator` programmatically — the same function drizzle-kit calls internally. Wraps `migrate()` in a blocking `pg_advisory_lock(0x436f676e6901)`: concurrent initContainers (replicas > 1, HPA scale-out, rolling-update overlap) acquire serially, and drizzle's journal makes post-acquire migrations a no-op when schema is current. Lock auto-releases on session end + explicit `pg_advisory_unlock` in finally.
- **Per-node drizzle-kit configs (dev only):** `nodes/<node>/drizzle.config.ts` — used by `pnpm db:migrate:*` for local dev + testcontainers. Not invoked at production runtime.
- **Core schema package:** `packages/db-schema` (`@cogni/db-schema`) — cross-node platform tables.
- **Per-node schema packages:** `nodes/<node>/packages/db-schema` (`@cogni/<node>-db-schema`) — node-local tables. Today only `@cogni/poly-db-schema` exists.
- **Per-node Doltgres migration:** any node with `@cogni/<node>-doltgres-schema` also carries `migrate-doltgres.mjs` + a separate `doltgres-migrations/` dir (today: operator; poly's package exists but its migrator runs through a separate path). The overlay appends a second initContainer `migrate-doltgres` to the Deployment via JSON patch (`op: add path: /spec/template/spec/initContainers/-`). The Doltgres script calls the same programmatic migrator as Postgres, plus three Doltgres-only steps: (a) a recovery shim for the parameterized-INSERT gap on `drizzle.__drizzle_migrations`, (b) `verifyDoltgresSchema()` against the latest snapshot before any tracking-row stamping (closes drizzle-orm's silent-skip gap), and (c) a trailing `SELECT dolt_commit('-Am', 'migration: drizzle-orm batch')` to land DDL in `dolt_log`. It does **not** wrap in advisory lock — Doltgres advisory-lock semantics on the pg wire are unverified; `replicas: 1` keeps the migrator single-writer regardless. Full parity matrix in §5.2.
- **Migration history per DB:** one `drizzle.__drizzle_migrations` table per database (standard drizzle default). Idempotent — script no-ops in <100 ms when journal is caught up. `0027_silent_nextwave.sql` is byte-duplicated across `nodes/{operator,poly,resy}/app/src/adapters/server/db/migrations/` (pre-task.0324 legacy) — READMEs warn against deletion.
- **Runner image:** Production image (~920 MB; ~285 MB is `@openai/codex` SDK weight tracked separately as bug.0369). Carries the standalone Next.js bundle + production deps including `drizzle-orm` + `postgres`.

**Invariants:**

- **NO_CROSS_NODE_TABLE_LEAK** — node-local tables are defined in that node's own workspace package (e.g. poly's tables live in `@cogni/poly-db-schema` at `nodes/poly/packages/db-schema/`). Adding a node-local table to `@cogni/db-schema` is a review-blocking error.
- **CORE_TABLES_IN_SHARED_PACKAGE** — `@cogni/db-schema` contains only tables every node needs (intersection, not union).
- **EACH_NODE_OWNS_ITS_MIGRATIONS** — `nodes/<node>/app/src/adapters/server/db/migrations/` is that node's authoritative history. Core-table changes are copied to each node's dir manually.
- **EXPLICIT_DATABASE_URL_NO_FALLBACK** — drizzle configs read `DATABASE_URL` from env and throw if unset. No component-piece fallback (matches runtime app invariant from §Database URL Configuration).

**Migration Commands:**

- `pnpm db:migrate` — alias for `db:migrate:dev` (operator dev database via `nodes/operator/drizzle.config.ts`)
- `pnpm db:migrate:dev` — drizzle-kit with `.env.local` (operator dev database)
- `pnpm db:migrate:poly` / `:resy` — drizzle-kit with `DATABASE_URL_POLY` / `DATABASE_URL_RESY` from `.env.local` + that node's config
- `pnpm db:migrate:nodes` — runs all three in sequence
- `pnpm db:migrate:test` — drizzle-kit with `.env.test` (operator test database)
- `pnpm db:migrate:test:poly` / `:resy` — same pattern with `.env.test`
- `pnpm db:migrate:test:nodes` — runs all 3 test DB migrations
- `pnpm db:migrate:direct` — drizzle-kit using operator config + `DATABASE_URL` from current environment (used by testcontainers)
- `pnpm db:migrate:{operator,poly,resy}:container` — container-only: invoked by each node's Dockerfile default CMD
- `pnpm db:generate:{operator,poly,resy}` — generate new migrations for a node's schema (runs drizzle-kit diff)
- `pnpm db:check:{operator,poly,resy,poly:doltgres}` — validate a node's snapshot chain via `drizzle-kit check` (no DB connection; static)
- `pnpm db:check` — umbrella: runs `db:check` against every node config. Invoked by `pnpm check` (pre-commit) and `pnpm check:fast` (pre-push).

**Execution Contexts:**

- **Local Dev** (`db:migrate:dev` / `:poly` / `:resy`): runs `drizzle-kit migrate` with `.env.local` + per-node config. For daily development.
- **Local Test** (`db:migrate:test*`): runs with `.env.test`. For test database setup.
- **Direct** (`db:migrate:direct`): runs with operator config using `DATABASE_URL` from environment. For testcontainers (`testcontainers-postgres.global.ts` sets `process.env.DATABASE_URL` before `execSync`).
- **Production runtime** (Deployment initContainer): bundles the per-node `migrate.mjs` script + migration SQL into the runtime image. Pod start blocks on the initContainer until migrations apply (or no-op via journal). No separate Job, no PreSync hook.

**Future: Atlas + GitOps migrations** — declarative schema, CRD-based Argo integration, destructive-change linting. Deferred to task.0325 with full spike intel preserved.

### 2.6 Generating Migrations

**Default: `pnpm db:generate:<node>`.** Edit the schema TS, then auto-gen. Hand-authoring is for things drizzle-kit can't model (RLS policies, triggers, custom functions) — not for plain column adds, CHECKs, or partial indexes. Two devs in a row (April 2026) hand-authored column adds, broke the chain, shipped silent no-ops to candidate-a.

**Post-generate checklist (always):**

1. **Verify monotonic `when`.** Open `meta/_journal.json`; confirm your new entry's `when > max(prior when)`. If not, bump to `prior_max + 1`. The runtime migrator skips entries whose `when <=` the `created_at` of the last applied row, and `created_at` is the journal's `when`. **Future-dating any entry poisons every later migration on that node.** Poly's idx 30–33 are poisoned with 2026-05-04 timestamps today — every poly migration needs a manual `when` bump until that's normalized.
2. **Inspect the SQL.** If you actually need RLS / triggers / custom functions, fall through to the hand-authored recipe below.
3. `pnpm db:check` must be green before commit.
4. Commit `.sql` + `_journal.json` + `NNNN_snapshot.json` together.

**Hand-authored recipe (only when drizzle-kit literally cannot emit it):**

1. Write `NNNN_<tag>.sql`.
2. Append journal entry with `when > max(prior when)`.
3. `cp meta/(N-1)_snapshot.json meta/NNNN_snapshot.json`; regenerate `id`, set `prevId` to prior snapshot's `id`, edit `tables` to reflect your deltas.
4. `pnpm db:check` green; commit all three files together.

**Hard rules:**

- **Migration files on `origin/main` are immutable.** Every `.sql` and `meta/<idx>_snapshot.json` already merged is frozen; `meta/_journal.json` is append-only. Schema changes always land as a NEW numbered forward migration. drizzle-orm's runtime migrator decides "applied?" by `lastDbMigration.created_at < migration.folderMillis` — **it never compares the file's hash to the tracking-row hash** (see `node_modules/drizzle-orm/pg-core/dialect.js`'s `async migrate(...)`). So editing an applied migration's SQL silently no-ops on every deployed DB while passing CI on a fresh test DB. Enforced by `scripts/db/check-migrations-immutable.mjs` (run via `pnpm db:check:immutable` and CI's `static` job).
- Never future-date `when`. Never edit a committed snapshot's `prevId` to silence `db:check`.
- `db:check` catches snapshot/`prevId` breakage **and** non-monotonic `when` (via `scripts/db/check-journal-when.mjs`) **and** post-merge mutation of frozen files (via `scripts/db/check-migrations-immutable.mjs`). Pre-existing future-dated entries that already shipped are warning-only — the load-bearing guards are strict-monotonic ordering + file immutability, which is what every silent-skip incident has tripped on.
- Pushing schema with `--no-verify` skips `db:check`. Don't.
- After flight, confirm `kubectl logs <pod> -c migrate` lists your new tag. Silent skip is exactly the failure mode this section prevents.

**For Doltgres there's a second runtime safety net:** `migrate-doltgres.mjs` invokes `verifyDoltgresSchema()` against the latest snapshot before stamping any tracking rows. If the live shape doesn't match — because a migration was silently skipped, or the recovery shim was about to mark an unapplied migration as applied — the migrator throws `SCHEMA_DRIFT` and the initContainer fails the pod start. Postgres has no equivalent runtime check yet; the static guards above are its only line of defence. Adding `verifyPostgresSchema()` to `migrate.mjs` is a near-trivial follow-up (same snapshot format, same `information_schema` queries) and is recommended the next time a similar drift incident bites.

### 2.1 Local Development

**Databases:** `cogni_operator`, `cogni_poly`, `cogni_resy` (per `COGNI_NODE_DBS`)

**Environment:** `.env.local`

**Commands:**

```bash
pnpm db:setup:nodes          # Provision + migrate + seed all 3 node DBs
pnpm db:migrate:nodes        # Migrate all 3 node DBs
pnpm dev:stack               # Start operator using cogni_operator
pnpm dev:stack:full           # Start operator + poly + resy (each on its own DB)
```

### 2.2 Host Stack Tests

**Databases:** `cogni_template_stack_test` (single-node), + `cogni_poly_test`, `cogni_resy_test` (multi-node)

**Environment:** `.env.test`

**Commands:**

```bash
# Single-node
pnpm dev:stack:test:setup     # Provision + migrate operator test DB
pnpm dev:stack:test           # Start operator in test mode
pnpm test:stack:dev           # Run single-node stack tests

# Multi-node
pnpm dev:stack:test:full:setup  # Provision + migrate all 3 test DBs
pnpm dev:stack:test:full        # Start operator + poly + resy in test mode
pnpm test:stack:multi           # Run multi-node isolation tests
```

**Details:**

- `test:stack:dev` uses `vitest.stack.config.mts` with `.env.test`
- `test:stack:multi` uses `vitest.stack-multi.config.mts` with `.env.test`
- `reset-db.ts` truncates tables in the operator test DB between test suites
- Multi-node tests seed and clean their own data per-test (no global reset)
- See [Full-Stack Testing Guide](../guides/full-stack-testing.md) for details

### 2.3 Docker Dev Stack

**Database:** `cogni_template_dev` (container Postgres)

**Environment:** `.env.local` passed to Docker Compose

**Commands:**

```bash
# First time setup (creates DB + runs migrations)
pnpm docker:dev:stack:setup     # Complete: build stack, create DB, migrate

# Manual steps (if needed)
pnpm docker:dev:stack           # Start containers
pnpm db:provision               # Create database
pnpm db:migrate                 # Run migrations with drizzle-kit
```

**Key Properties:**

- Dev stack owns schema and migrations in shared `postgres_data` volume
- Uses `docker-compose.dev.yml` with db-migrate service for migrations
- Postgres exposed on `localhost:55432` for debugging
- Migrations run via dedicated migrator image (not inside app container)

### 2.4 Docker Stack (Production Simulation)

**Database:** `cogni_template_dev` (reuses dev stack's database)

**Environment:** `.env.local` passed to Docker Compose

**Commands:**

```bash
pnpm docker:stack:setup         # Start production compose (assumes DB exists)
```

**Key Properties:**

- Uses hardened `docker-compose.yml` production configuration
- Shares same `postgres_data` volume as dev stack
- **Assumes database already created and migrated** via `docker:dev:stack:setup`
- `docker:stack:migrate` available but not used in local workflow

**Local Workflow:**

1. **After nuking volumes:** Run `pnpm docker:dev:stack:setup` once to create schema
2. **To simulate prod:** Run `pnpm docker:stack:setup` (reuses existing DB/schema from shared volume)

### 2.5 Docker Stack Testing

**Database:** `cogni_template_stack_test` (container Postgres)

**Environment:** `dotenv -e .env.test -e .env.local` (test overrides base)

**Commands:**

```bash
# 1. Start Docker stack in test mode
pnpm docker:test:stack          # Build and start containers with test env

# 2. Run migrations via db-migrate service
pnpm db:migrate:test

# 3. Run host tests against containerized app
pnpm test:stack:docker
```

**Key Properties:**

- Uses dedicated migrator image for migrations (not app container)
- Environment variables passed via dotenv to Docker Compose
- Migrations run via db-migrate service with `--profile bootstrap`
- Tests run from host, connect to exposed postgres port (55432) and app via HTTPS

## 3. Production Deployments

### 3.1 CI/CD Pattern

In staging and production, environment variables come from GitHub Environments/secrets, not `.env` files.

**GitHub Actions Environment:**

```yaml
env:
  APP_ENV: production
  NODE_ENV: production
  # Database configuration (two-user security model)
  POSTGRES_ROOT_USER: ${{ secrets.POSTGRES_ROOT_USER }}
  POSTGRES_ROOT_PASSWORD: ${{ secrets.POSTGRES_ROOT_PASSWORD }}
  APP_DB_USER: ${{ secrets.APP_DB_USER }}
  APP_DB_PASSWORD: ${{ secrets.APP_DB_PASSWORD }}
  COGNI_NODE_DBS: ${{ secrets.COGNI_NODE_DBS }} # Required, comma-separated
  DATABASE_URL: ${{ secrets.DATABASE_URL }}
  DATABASE_SERVICE_URL: ${{ secrets.DATABASE_SERVICE_URL }}
  COGNI_NODE_ENDPOINTS: ${{ secrets.COGNI_NODE_ENDPOINTS }} # Per-node billing routing
  LITELLM_MASTER_KEY: ${{ secrets.LITELLM_MASTER_KEY }}
  OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
  AUTH_SECRET: ${{ secrets.AUTH_SECRET }}
```

**Deployment Steps:**

```yaml
- name: Run migrations
  run: |
    docker compose -f infra/compose/runtime/docker-compose.yml \
      --profile bootstrap run --rm db-migrate

- name: Start application
  run: |
    docker compose -f infra/compose/runtime/docker-compose.yml \
      up -d app
```

**Benefits:**

- Same `DATABASE_URL` for migrations and app
- Dedicated migrator image with pinned drizzle-kit version
- Migrations as repeatable deployment step (idempotent)
- Lean runner image (~80MB) without migration tooling
- db-migrate service receives only DB env vars (least-secret exposure)

## 4. Technical Implementation

### 4.1 Docker Image Architecture

**One image per node (task.0324 + task.0370 + task.0371):** each deployed node ships exactly one runtime image from its own `nodes/<node>/app/Dockerfile`. After task.0371 the migration scripts + SQL bundle into the runner stage; there is no separate `cogni-template-migrate` package.

- **Runner image** (`IMAGE_NAME:IMAGE_TAG` for operator; `IMAGE_NAME:IMAGE_TAG-{poly,resy}` for node variants): production image carrying the standalone Next.js bundle + production deps (`drizzle-orm`, `postgres`, etc.) + per-node `migrate.mjs` + migration SQL (and for poly, also `migrate-doltgres.mjs` + Doltgres migration SQL).

**Runner stage (post-task.0371):** each node's Dockerfile bundles migration runners alongside the standalone bundle:

```dockerfile
# Runner – production image
FROM node:22-alpine AS runner
... (standalone bundle, codex SDK, etc.)
COPY --from=builder --chown=nextjs:nodejs /app/nodes/<node>/app/src/adapters/server/db/migrations  /app/nodes/<node>/app/migrations
COPY --from=builder --chown=nextjs:nodejs /app/nodes/<node>/app/src/adapters/server/db/migrate.mjs /app/nodes/<node>/app/migrate.mjs
CMD ["node", "nodes/<node>/app/server.js"]
```

Poly additionally COPYs `migrate-doltgres.mjs` + `doltgres-migrations/`. No second image; both initContainers (Postgres + Doltgres) run off the same runtime digest with `command:` overrides set in the Deployment spec / poly overlay.

**`next.config.ts` requirement:** the app itself imports `drizzle-orm/postgres-js` (the driver) but never the `migrator` subpath, so nft would prune it from standalone tracing. Each node's `next.config.ts` must include:

```ts
outputFileTracingIncludes: {
  "/**": ["**/node_modules/drizzle-orm/**/*", "**/node_modules/postgres/**/*"],
},
```

This forces the full `drizzle-orm` + `postgres` packages (with their `package.json` exports map) into the standalone bundle so `migrate.mjs` can resolve `drizzle-orm/postgres-js/migrator` at runtime.

**CI wiring (see `scripts/ci/`):** simpler post-task.0371 — one target per node, no migrator companion.

- `detect-affected.sh` — emits the per-node target when its paths change.
- `build-and-push-images.sh` — one build per target.
- `merge-build-fragments.sh` — `canonical_order` is `["operator", "poly", "resy", "scheduler-worker"]`.
- `resolve-pr-build-images.sh` — `ALL_TARGETS` + `resolve_tag()`. No `*-migrator` companions.
- `promote-build-payload.sh` — one digest per app, no migrator pairing.
- `wait-for-argocd.sh` — polls `sync.revision == EXPECTED_SHA && Healthy` then `kubectl rollout status`. Hook-Job babysitting (`delete_stale_hook_jobs`, `clear_stale_missing_hook_operation`, `patch_sync_operation`) is gone.

### 4.2 Drizzle Configuration

Each node has its own `nodes/<node>/drizzle.config.ts`. Example (operator):

```typescript
import { defineConfig } from "drizzle-kit";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for drizzle-kit (nodes/operator/drizzle.config.ts)."
    );
  }
  return url;
}

export default defineConfig({
  schema: "./packages/db-schema/src/**/*.ts",
  out: "./nodes/operator/app/src/adapters/server/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: requireDatabaseUrl() },
  verbose: true,
  strict: true,
});
```

Poly's config uses an array schema that unions core + poly's per-node package source: `["./packages/db-schema/src/**/*.ts", "./nodes/poly/packages/db-schema/src/**/*.ts"]`. drizzle-kit reads raw TS via these globs — no pre-built `dist/` required for migration generation. Resy and node-template are core-only until they ship their first node-local table, at which point they gain a `nodes/<node>/packages/db-schema/` package.

**Why this shape:**

- **No relative imports in the config.** drizzle-kit compiles configs to a temp directory before executing; relative TypeScript imports break from there. All paths are repo-root-relative (drizzle-kit runs with `CWD=repo root`).
- **Explicit `DATABASE_URL`, no fallback.** Caller (pnpm script, testcontainer, k8s Job) must set it. Matches the runtime app invariant in §Database URL Configuration.
- **Per-node `out` dir.** Each node writes migrations to its own `nodes/<node>/app/src/adapters/server/db/migrations/`. Cross-node collisions impossible — nothing shared.

## 5. Trade-offs of Current Approach

### 5.1 Benefits

**Single image per node (task.0371):**

- One build per node — no `cogni-template-migrate` companion package
- Runtime image bundles migration SQL + `migrate.mjs` + (for poly) `migrate-doltgres.mjs`
- Removes `wait-for-argocd.sh`'s ~80 lines of hook-Job babysitting (the resy-stuck-hook failure class is gone)

**Multi-replica safety:**

- Postgres migrators wrap `migrate()` in `pg_advisory_lock(0x436f676e6901)` — concurrent initContainers acquire serially; drizzle's journal makes peers' migrations no-ops
- Single-writer guarantee survives HPA scale-out and rolling-update overlap

**Consistent Migration Tooling:**

- `drizzle-orm/postgres-js/migrator` is the pinned migrator (resolved via the runner's standalone deps) — same library code drizzle-kit calls internally
- Idempotent migrations (safe on every pod start via journal table)
- Same script shape across all nodes; adding a new node is a one-line node-app overlay change + a `migrate.mjs` copy

### 5.2 Trade-offs

**Forward-compat migrations required:**

- Deployment initContainer runs before the new pod becomes Ready, but rolling-update overlap means the old pod still serves traffic against the newly-migrated schema briefly. `DROP COLUMN` / non-default `NOT NULL` without a two-deploy plan = partial outage. CI lint for destructive SQL is follow-up work.

**Doltgres parity gaps — why `migrate-doltgres.mjs` isn't 1:1 with `migrate.mjs`:**

Both migrators call the same `drizzle-orm/postgres-js/migrator` function against the same drizzle-kit-generated SQL files. The deltas are all forced by upstream Doltgres (verified against 0.56), not by us choosing to diverge:

| Behavior                           | Postgres (`migrate.mjs`)                                   | Doltgres (`migrate-doltgres.mjs`)                                                                                                                          | Why the delta                                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drizzle-orm/postgres-js/migrator` | Yes                                                        | Yes                                                                                                                                                        | Same lib both sides.                                                                                                                                                                                                               |
| Advisory lock around `migrate()`   | `pg_advisory_lock(0x...)` blocking acquire                 | Skipped                                                                                                                                                    | Doltgres advisory-lock semantics on the pg wire are unverified; `replicas: 1` keeps the migrator single-writer regardless.                                                                                                         |
| Tracking-row INSERT                | Parameterized (extended protocol) — works                  | Catches `XX000 / already exists`, reconciles `drizzle.__drizzle_migrations` via `sql.unsafe` (simple protocol)                                             | Doltgres 0.56 rejects drizzle-kit's parameterized INSERT into `__drizzle_migrations` on the wire. Removable when Doltgres closes the gap.                                                                                          |
| DDL durability                     | DDL auto-commits (Postgres semantics)                      | Trailing `SELECT dolt_commit('-Am', 'migration: drizzle-orm batch')`                                                                                       | Dolt DDL stays in the working set until `dolt_commit` (dolt#4843). Without the trailing commit the change isn't in `dolt_log` / `dolt_diff`.                                                                                       |
| Post-migrate schema verification   | _Not implemented_                                          | `verifyDoltgresSchema()` introspects `information_schema` against the latest snapshot and throws `SCHEMA_DRIFT` if anything is missing or shape-mismatched | Closes drizzle-orm's silent-skip gap (the migrator skips by `folderMillis`, never by hash — so a modified applied migration is invisible). Land on Postgres next.                                                                  |
| Base reference-data seeds          | Each node's migrations include literal `INSERT` statements | `BASE_DOMAIN_SEEDS` written via idempotent `sql.unsafe` SELECT-then-INSERT                                                                                 | drizzle-orm wraps migrations in a transaction; the failing parameterized INSERT into `__drizzle_migrations` rolls back the whole tx on Doltgres, taking seed rows with it. `CREATE TABLE` survives (DDL auto-commit), DML doesn't. |

Everything else (snapshot chain, hand-authored recipe, journal-monotonicity rule, immutability rule, post-flight log check) is identical across both. The Doltgres delta is a ~70-line recovery shim + a ~120-line verifier — both removable as Doltgres' drizzle-kit compatibility improves.

**Runner image weight (~920 MB):**

- Pre-existing, ~285 MB is `@openai/codex` SDK weight (bug.0369). Initial flight pull cost is per-pod once; cached on k3s thereafter.

## 6. Future Improvements (If/When Needed)

### 6.1 Row-Level Security (RLS)

RLS is implemented on all user-scoped tables (P0 complete). Tenant isolation uses `SET LOCAL app.current_user_id` per transaction. The `app_user` role has RLS enforced; `app_service` has BYPASSRLS. The `@cogni/db-client` package exposes two sub-path exports (`@cogni/db-client` for app-role, `@cogni/db-client/service` for service-role), and the adapter layer isolates `getServiceDb()` in a depcruiser-gated file. See [Database RLS Spec](database-rls.md) for full design, adapter wiring tracker, and remaining P1 hardening items.

### 6.2 SSL Enforcement

Non-localhost `DATABASE_URL` values do not currently require `sslmode=require`. Covered in [Database RLS Spec](database-rls.md).

### 6.3 Least-Privilege App Role

`provision.sh` creates the `app_user` role but does not restrict it from DDL operations. Production deployments should revoke `CREATE`, `DROP`, `TRUNCATE`, `ALTER` from the app role. Covered in [Database RLS Spec](database-rls.md).

### 6.4 Runner Image Weight

After task.0371, runner is the only deploy-time image. Weight is ~920 MB, ~285 MB of which is the `@openai/codex` SDK (`bug.0369`). Reducing runner weight cuts both app and migration first-pull cost. Candidates: lazy-fetch codex on first AI call, smaller base image, or moving codex into the sandbox-openclaw container instead of runner.

### 6.2 Enhanced Environment Separation

**Stricter Test Isolation:**

- Container-specific DB reset routines
- Separate test databases for different environments
- Longer-running smoke test environments

**Production Pipeline:**

- Blue/green deployments with migration gating
- Automated migration rollback on failure

## 7. Summary

**Environment Separation:** Host dev DB, host stack test DB, container stack DB are cleanly separated

**Two-Image Architecture:** Lean runner image (~80MB) + dedicated migrator image (~480MB) with clear security boundaries

**Production-Ready Pattern:** Dedicated db-migrate service, same `DATABASE_URL`, migrations as first-class deployment step

**Least-Secret Exposure:** db-migrate service receives only DB env vars, not app secrets

**Tag Coupling:** `APP_IMAGE=IMAGE_NAME:IMAGE_TAG`, `MIGRATOR_IMAGE=IMAGE_NAME:IMAGE_TAG-migrate`
