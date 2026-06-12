---
name: schema-update
description: Use any time you are about to add, change, or migrate a Postgres or Doltgres table — editing schema TS, running `pnpm db:generate:*`, writing a migration `.sql`, touching `meta/_journal.json` / `*_snapshot.json`, or debugging a migration that didn't apply on candidate-a. Mandatory before any schema edit.
---

# schema-update

The minimal procedure for changing a table. Follow it; don't improvise.

**Canon:** [`docs/spec/databases.md` §2.6](../../../docs/spec/databases.md). This skill is the operational checklist.

## Postgres — the only path

1. **Edit the schema TS.** Core table → `packages/db-schema/src/`. Node-local → `nodes/<node>/packages/db-schema/src/` (poly is the only one with this package today; create one for a new node by forking poly's). Never reach into `nodes/<node>/app/src/...` for schema.
2. **`pnpm db:generate:<node>`.** Auto-gen emits `NNNN_<tag>.sql`, the `_journal.json` entry, and `NNNN_snapshot.json` together. Inspect the `.sql` — drop unintended `DROP TABLE "poly_copy_trade_*"` from operator/resy gens (orphan tables, intentional).
3. **`pnpm db:check`.** Validates: snapshot/`prevId` chain (drizzle-kit), strict-monotonic journal `when` (`scripts/db/check-journal-when.mjs`), applied-migration immutability (`check-migrations-immutable.mjs`), **and generate-cleanliness** (`check-generate-clean.mjs` — fails if `db:generate:operator` would emit any drift, i.e. you edited schema TS without committing the migration). A clean tree ⇒ `db:generate` says "No schema changes". If it red-flags non-monotonic `when`, your auto-gen `Date.now()` landed before a prior entry — bump the new entry's `when` past the violation it reports. Pre-existing future-dated entries on a node (poly idx 33 today, normalizes ~May 5 2026) emit a warning so you know your auto-gen will need a manual bump until the wall clock catches up; not fatal.
4. **Core table only:** copy the new `NNNN_*.sql` + journal entry into every other node's `migrations/` dir (each deployed DB has its own `__drizzle_migrations` table; they need their own copy with matching journal idx + `when`).
5. Commit `.sql` + `_journal.json` + `NNNN_snapshot.json` together. Never `--no-verify` a schema PR.
6. **Post-flight:** `kubectl logs <pod> -c migrate` must list your tag with `✅ migrations applied`. If it didn't run, `db:check` was bypassed.

## RLS coverage — mandatory for any table with a FK to `users`

Drizzle does not generate RLS. If your new table has a foreign key to `users`, you MUST add RLS in the same migration (hand-authored fallback below) or the coverage gate fails CI. Two correct shapes:

- **User-facing reads** → an owner-scoped policy (`USING (... = current_setting('app.current_user_id', true))`). See `docs/spec/database-rls.md`.
- **Service-role-only** (worker reads/writes via the BYPASSRLS role, no app-role path) → `ENABLE + FORCE` with **no policy** = deny-all (fail-closed). No fake policy needed.

The gate (`tests/component/setup/testcontainers-postgres.global.ts`) fails if any `public` table with a FK to `users` has `relrowsecurity = false` — invariant `RLS_COVERAGE` in `database-rls.md`. It exists because user-FK tables historically shipped with no RLS (the `0010`→`0032` epoch-ledger leak); the gate makes that class of drift impossible to merge.

## Hand-authored fallback — only if drizzle-kit literally can't emit it

Valid triggers: RLS policies, `ALTER POLICY`, triggers, custom Postgres functions, ARRAY DEFAULTs the TS schema can't express. **Plain `ADD COLUMN`, CHECK, partial index, FK — auto-gen handles all of this.** When in doubt, try `db:generate` first.

Recipe (steps 1–4 atomic in one commit):

1. Write `NNNN_<tag>.sql`.
2. Append journal entry; **`when > max(prior when)`**.
3. `cp meta/(N-1)_snapshot.json meta/NNNN_snapshot.json`; regenerate `id`, set `prevId` to prior snapshot's `id`, edit `tables` to reflect your deltas.
4. `pnpm db:check` green.

Never edit a previously committed snapshot's `prevId` to silence `db:check`. If the chain is broken, fix it forward.

## Doltgres — same shape, parallel pipeline

Doltgres is for AI-written knowledge (`knowledge` table + companions); Postgres is for operational data. **Default for any AI-edited content: a new row in `knowledge` with a different `domain` + `tags`, NOT a new table.** See `database-expert` for the syntropy rule.

When you do need a new Doltgres table:

1. Edit `nodes/<node>/packages/doltgres-schema/src/` (only `@cogni/poly-doltgres-schema` exists today; fork the pattern).
2. `pnpm db:generate:<node>:doltgres`.
3. Same `when` monotonicity check on the Doltgres journal.
4. `pnpm db:check` (covers Doltgres configs too).
5. Adapter writes use `sql.unsafe()` + try-INSERT/catch-duplicate (extended-protocol params + `ON CONFLICT EXCLUDED` are broken on Doltgres 0.56). Don't "modernize" them.
6. Migrator chains a trailing `SELECT dolt_commit('-Am', '...')` to capture DDL into `dolt_log`. If you wire a new node's Doltgres pipeline, replicate this.

## Common failure modes (rank-ordered by recent incidents)

1. **Future-dated `when`** silently no-ops your migration on candidate-a. App pod has the schema code; DB doesn't have the column. Symptom: `PostgresError: column "X" does not exist` 60s into deploy.
2. **Hand-authored when auto-gen would have worked** — broke snapshot chain, missed journal entry, or both.
3. **Schema edited under `nodes/<node>/app/src/...`** — drizzle config doesn't see it; `db:generate` produces no diff.
4. **Auto-gen on operator/resy proposed `DROP TABLE poly_copy_trade_*`** — committed unread; tables vanish on next migrate.
5. **Pushed with `--no-verify`** — skipped `db:check`, shipped a broken chain.

## Quick reference

```bash
pnpm db:generate:<node>              # generate from schema diff
pnpm db:generate:<node>:doltgres     # generate Doltgres
pnpm db:check                        # validate all node chains (snapshot + prevId)
pnpm db:migrate:<node>                # apply locally
```

Schema package locations:

```
packages/db-schema/                                       core Postgres (cross-node)
nodes/<node>/packages/db-schema/        @cogni/<node>-db-schema           (only poly today)
nodes/<node>/packages/doltgres-schema/  @cogni/<node>-doltgres-schema     (only poly today)
nodes/<node>/drizzle.config.ts          schema array unions whatever applies
nodes/<node>/app/src/adapters/server/db/migrations/         Postgres history
nodes/<node>/app/src/adapters/server/db/doltgres-migrations/ Doltgres history
```

## When to escalate

- Need to choose Postgres vs Doltgres for a new table → `database-expert` (split rule + syntropy).
- Migrator pod crash-looping or initContainer not firing → `deploy-operator` / `devops-expert` (image build wiring, Argo).
- Normalizing the poly `when` poisoning across deployed DBs → coordinate; touches `__drizzle_migrations` rows on candidate-a + preview + prod.
