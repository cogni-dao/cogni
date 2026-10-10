# knowledge-store · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Shared ports, contribution workflow, and adapters for versioned domain knowledge backed by Doltgres. Generic schema lives in `@cogni/knowledge-base`; each node may add companion tables and niche seeds.

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

**Contribution schemas** (`@cogni/knowledge-store/contribution-schemas`):

- Five edit ops: `insert`, full `update`, strict `patch`, `delete`, `cite`
- `patch` may set only `useWhen` and `entryType`; it cannot carry the body or gate-governed fields

**Subpath** (`@cogni/knowledge-store/adapters/doltgres`):

- `DoltgresKnowledgeStoreAdapter`, `DoltgresAdapterConfig`, `buildDoltgresClient`, `DoltgresClientConfig`
- `DoltgresKnowledgeContributionAdapter`, `DoltgresKnowledgeContributionAdapterConfig` (contribution-branch lifecycle)
- `DoltBranchSessionRunner` (FIFO admission + pinned branch session + cross-replica advisory lock; branch client is separate from reads)
- `createDoltgresPusher`, `DoltgresPusher`, `DoltgresPushConfig` (post-merge mirror to a Dolt remote; lazy `dolt_remote add` + `dolt_push`)
- `wrapPushSafe`, `PushOutcomeListener` (fire-and-forget wrapper with injectable success/failure callbacks — keeps logging out of the adapter)

**Service** (`@cogni/knowledge-store/service/contribution-service`):

- `createContributionService`, `ContributionService`, `ContributionServiceDeps`
- `ContributionServiceDeps.pushMainOnMerge?: () => Promise<void>` — optional post-merge mirror hook; caller owns error handling (service does not await + does not catch)

## Ports

- **Implements:** `KnowledgeStorePort`
- **Uses:** none

## Responsibilities

- This directory **does**: define port interfaces, Zod domain/contribution schemas, Doltgres row and contribution-branch adapters, branch-session admission, service policy, and Dolt remote push primitives.
- This directory **does not**: own Drizzle schema, load env vars, provision databases, bind HTTP routes, or decide node-specific domains/content.

## Notes

- **postgres.js parameterized queries don't work on Doltgres** — adapter uses `sql.unsafe()` + `escapeValue()` for all queries.
- **`ON CONFLICT ... EXCLUDED` unsupported** — `upsertKnowledge` uses try-INSERT / catch-duplicate / fallback-UPDATE.
- **JSONB `@>` and ILIKE not supported** — fallbacks: `CAST(tags AS TEXT) LIKE` and `LOWER(col) LIKE`.
- **Doltgres 0.56 RBAC is non-functional** — GRANT reports success but roles can't even `SELECT current_user`. Runtime `DOLTGRES_URL_*` must connect as `postgres` superuser until upstream lands working role access.
- **`fetch_types: false` required** on all postgres.js connections (pg_type grants missing).
- Generic schema lives in `packages/knowledge-base`; node schema packages re-export it and may add companion tables.
- `listKnowledge(domain, { q })` matches `useWhen` only. Full-text claim search remains `searchKnowledge`; the HTTP routing projection is `/api/v1/knowledge/index`.
- `core__knowledge_search` / `core__knowledge_read` / `core__knowledge_write` BoundTools shipped in `@cogni/ai-tools`; brain graph uses them via tool runtime.
