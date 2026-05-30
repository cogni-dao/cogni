# node-template-doltgres-schema · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable
- **Package:** `@cogni/node-template-doltgres-schema`

## Purpose

Pure re-exports of the Drizzle table definitions from `@cogni/knowledge-base`, scoped to the node-template `knowledge_node_template` database. Owned by and namespaced to the node-template node. Mirrors `@cogni/operator-doltgres-schema` shape verbatim so every fork starts with the same versioned knowledge plane + work-items source-of-truth.

Contents: re-exports from `@cogni/knowledge-base` of the 6 syntropy-seed tables (citations, domains, knowledge, sources, knowledge_contributions, knowledge_contribution_commits — task.0425 contribution flow promoted to base in spike.5004) + the `work_items` table (task.0423-shape parity, also promoted to base in spike.5004). No local table definitions — `SCHEMA_GENERIC_CONTENT_SPECIFIC` makes column-shape divergence between nodes an anti-pattern.

## Pointers

- [Work Items Port Spec](../../../../docs/spec/work-items-port.md) — port + adapter contract
- [Knowledge Data Plane Spec](../../../../docs/spec/knowledge-data-plane.md) — Doltgres-side architecture
- [Packages Architecture](../../../../docs/spec/packages-architecture.md) — workspace package shape
- [@cogni/operator-doltgres-schema](../../../operator/packages/doltgres-schema/AGENTS.md) — sibling package; reference structure
- task.5077 — substrate + contributions API port that created this package

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

**External deps:** `drizzle-orm` and `@cogni/knowledge-base` only.

## Public Surface

- **Subpath exports:**
  - `@cogni/node-template-doltgres-schema` — root barrel re-exports every slice
  - `@cogni/node-template-doltgres-schema/work-items` — `work_items` table + `WorkItemRow` / `NewWorkItemRow` inferred types
  - `@cogni/node-template-doltgres-schema/knowledge` — `knowledge_contributions` + `knowledge_contribution_commits` tables + syntropy seed re-exports from `@cogni/knowledge-base`

## Responsibilities

- **Does:** define Drizzle table schemas for node-template-local Doltgres tables.
- **Does not:** contain queries, adapters, business logic, RLS policies, or any I/O.

## Dialect separation (non-negotiable)

This package is globbed ONLY by `nodes/node-template/drizzle.doltgres.config.ts` (Doltgres target). `nodes/node-template/drizzle.config.ts` (Postgres target) MUST NOT include this path — if it did, the Postgres migrator would try creating Doltgres-only tables in node-template's Postgres DB.

## Migrator behavior (runs in node-template migrator initContainer)

```bash
# Container entrypoint for the Doltgres migration:
pnpm db:migrate:node-template:doltgres:container
```

That script runs `drizzle-kit migrate` natively against `DATABASE_URL` pointing at `knowledge_node_template`. After drizzle-kit completes, `stamp-commit.mjs` runs `SELECT dolt_commit('-Am', '...')` to land DDL in `dolt_log` (DDL doesn't auto-commit per [dolt#4843](https://github.com/dolthub/dolt/issues/4843)).

On candidate-a, k8s runs `migrate-doltgres.mjs` directly (not the `:container` script) — it re-implements the journal walk to dodge the Doltgres 0.56 extended-protocol gap on `__drizzle_migrations` INSERTs and stamps its own dolt_commit. `stamp-commit.mjs` here is only used by local `pnpm db:migrate:node-template:doltgres:container`.

## Notes

- Keep structurally identical to `@cogni/operator-doltgres-schema`. Drift between these two packages is the failure mode that breaks the fork-from-template promise.
- Sibling: `@cogni/db-schema` (Postgres tables, shared core).
