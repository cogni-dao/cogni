# operator-doltgres-schema · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable
- **Package:** `@cogni/operator-doltgres-schema`

## Purpose

Drizzle ORM **re-exports** for operator's Doltgres knowledge plane (`knowledge_operator` database). As of spike.5004 (2026-05-30), the 7 base tables — `knowledge`, `domains`, `sources`, `citations`, `knowledgeContributions`, `knowledgeContributionCommits`, `workItems` — all live in `@cogni/knowledge-base` and are surfaced through this package's subpath exports. Drizzle-kit walks these re-exports to generate operator-local migrations against `knowledge_operator`.

This package owns **operator-specific** table definitions only. None exist today; all 7 baseline tables are shared. New operator-only tables (e.g., agent-knowledge claims, work_relations / work_external_refs in v1) would be defined here, alongside the re-exports.

## Pointers

- [Work Items Port Spec](../../../../docs/spec/work-items-port.md) — port + adapter contract
- [Knowledge Data Plane Spec](../../../../docs/spec/knowledge-data-plane.md) — Doltgres-side architecture
- [Packages Architecture](../../../../docs/spec/packages-architecture.md) — workspace package shape
- [@cogni/poly-doltgres-schema](../../../poly/packages/doltgres-schema/AGENTS.md) — sibling package; reference structure
- [task.0423](../../../../work/items/task.0423.doltgres-work-items-source-of-truth.md) — design + invariants

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

**External deps:** `drizzle-orm` only.

## Public Surface

- **Subpath exports** (all re-exports from `@cogni/knowledge-base` post-spike.5004):
  - `@cogni/operator-doltgres-schema` — root barrel re-exports every slice
  - `@cogni/operator-doltgres-schema/knowledge` — `knowledge`, `domains`, `sources`, `citations`, `knowledgeContributions`, `knowledgeContributionCommits`
  - `@cogni/operator-doltgres-schema/work-items` — `workItems` + `WorkItemRow` / `NewWorkItemRow` inferred types

## Responsibilities

- **Does:** define Drizzle table schemas for operator-local Doltgres tables.
- **Does not:** contain queries, adapters, business logic, RLS policies, or any I/O.

## Dialect separation (non-negotiable)

This package is globbed ONLY by `nodes/operator/drizzle.doltgres.config.ts` (Doltgres target). `nodes/operator/drizzle.config.ts` (Postgres target) MUST NOT include this path — if it did, the Postgres migrator would try creating the `work_items` table in operator's Postgres DB.

## Migrator behavior (runs in operator migrator initContainer)

```bash
# Container entrypoint for the Doltgres migration:
pnpm db:migrate:operator:doltgres:container
```

That script runs `drizzle-kit migrate` natively against `DATABASE_URL` pointing at `knowledge_operator`. After drizzle-kit completes, `stamp-commit.mjs` runs `SELECT dolt_commit('-Am', '...')` to land DDL in `dolt_log` (DDL doesn't auto-commit per [dolt#4843](https://github.com/dolthub/dolt/issues/4843)).

## Notes

- Mirrors poly's pattern (`@cogni/poly-doltgres-schema`) verbatim. Poly should adopt the shared base re-export pattern when next touched — out of scope for spike.5004.
- Sibling: `@cogni/db-schema` (Postgres tables, shared core).
- v0 holds work items as a single shared-base table with jsonb arrays for assignees/external_refs/labels/spec_refs. v1 will break out `work_relations` + `work_external_refs` into separate tables (those will also land in `@cogni/knowledge-base` per the shared-base pattern).
