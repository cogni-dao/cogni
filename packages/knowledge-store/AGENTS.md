# knowledge-store · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Shared port + adapter for versioned domain knowledge backed by Doltgres. Generic across all nodes — each node provides its own schema and seeds via `nodes/{node}/packages/knowledge/`.

## Pointers

- [Spec](../../docs/spec/knowledge-data-plane.md) — authoritative design
- [task.0231](../../work/items/task.0231.knowledge-data-plane.md) — port + adapter
- [task.0311](../../work/items/task.0311.poly-knowledge-syntropy-seed.md) — candidate-a wiring, clean-slate seeds, Doltgres 0.56 RBAC workaround
- [Design doc](../../docs/design/knowledge-data-plane-prototype.md) — spike results + agent tooling roadmap
- [proj.poly-prediction-bot](../../work/projects/proj.poly-prediction-bot.md) — parent project

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

**External deps:** `zod` (schema validation), `postgres` (Doltgres wire protocol — adapter subpath only).

## Public Surface

**Root barrel** (`@cogni/knowledge-store`):

- Types: `KnowledgeStorePort`, `Knowledge`, `NewKnowledge`, `DoltCommit`, `DoltDiffEntry`, `SourceType`
- Schemas: `KnowledgeSchema`, `NewKnowledgeSchema`, `DoltCommitSchema`, `DoltDiffEntrySchema`, `SourceTypeSchema`

**Subpath** (`@cogni/knowledge-store/adapters/doltgres`):

- `DoltgresKnowledgeStoreAdapter`, `DoltgresAdapterConfig`, `buildDoltgresClient`, `DoltgresClientConfig`
- `DoltgresKnowledgeContributionAdapter`, `DoltgresKnowledgeContributionAdapterConfig` (contribution-branch lifecycle)
- `createDoltgresPusher`, `DoltgresPusher`, `DoltgresPushConfig` (post-merge mirror to a Dolt remote; lazy `dolt_remote add` + `dolt_push`)
- `wrapPushSafe`, `PushOutcomeListener` (fire-and-forget wrapper with injectable success/failure callbacks — keeps logging out of the adapter)

**Service** (`@cogni/knowledge-store/service/contribution-service`):

- `createContributionService`, `ContributionService`, `ContributionServiceDeps`
- `ContributionServiceDeps.pushMainOnMerge?: () => Promise<void>` — optional post-merge mirror hook; caller owns error handling (service does not await + does not catch)

## Ports

- **Implements:** `KnowledgeStorePort`
- **Uses:** none

## Responsibilities

- This directory **does**: define port interface, Zod domain schemas, Doltgres adapter (CRUD + commit/log/diff), connection factory with Doltgres-compatible settings.
- This directory **does not**: define schema (node packages own that), load env vars, own database provisioning, handle branching/remotes.

## Notes

- **postgres.js parameterized queries don't work on Doltgres** — adapter uses `sql.unsafe()` + `escapeValue()` for all queries.
- **`ON CONFLICT ... EXCLUDED` unsupported** — `upsertKnowledge` uses try-INSERT / catch-duplicate / fallback-UPDATE.
- **JSONB `@>` and ILIKE not supported** — fallbacks: `CAST(tags AS TEXT) LIKE` and `LOWER(col) LIKE`.
- **Doltgres 0.56 RBAC is non-functional** — GRANT reports success but roles can't even `SELECT current_user`. Runtime `DOLTGRES_URL_*` must connect as `postgres` superuser until upstream lands working role access.
- **`fetch_types: false` required** on all postgres.js connections (pg_type grants missing).
- Schema lives in node packages (`nodes/{node}/packages/doltgres-schema/`) because nodes may add companion tables and fork takes schema with it.
- `core__knowledge_search` / `core__knowledge_read` / `core__knowledge_write` BoundTools shipped in `@cogni/ai-tools`; brain graph uses them via tool runtime.
