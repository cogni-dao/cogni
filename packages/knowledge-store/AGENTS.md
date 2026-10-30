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

- Domain registry: `getDomain`, `updateDomain`, `deleteDomain`; shared `DomainPatch` and `DomainNotEmptyError`. Private admitted mutations forward a per-call scope-checked SQL function to the published domain operations. Only shared missing-domain errors convert to the existing private constructor.

- Types: `KnowledgeWriteSession`, `KnowledgeStorePort`, `Knowledge`, `NewKnowledge`, `DoltCommit`, `DoltDiffEntry`, `SourceType`
- Governing index: `GOVERNING_ENTRY_TYPES`, `isGoverningEntryType`, `selectGoverningIndex`, `GoverningIndexRow` — the one definition of governing guidance, read through `KnowledgeStorePort.listGoverningIndex` (guidance-routing-design)
- Schemas: `KnowledgeSchema`, `NewKnowledgeSchema`, `DoltCommitSchema`, `DoltDiffEntrySchema`, `SourceTypeSchema`

**Contribution schemas** (`@cogni/knowledge-store/contribution-schemas`):

- Six edit ops: `insert`, full `update`, strict `patch`, `delete`, `cite`, `uncite`
- `patch` may set only `useWhen` and `entryType`; it cannot carry the body or gate-governed fields
- `ContributionMergePreviewSchema` describes a native check of immutable committed roots; `clean` never promises a future merge

**Subpath** (`@cogni/knowledge-store/adapters/doltgres`):

- `DoltgresKnowledgeStoreAdapter`, `DoltgresAdapterConfig`, `buildDoltgresClient`, `DoltgresClientConfig`
- `DoltgresKnowledgeContributionAdapter`, `DoltgresKnowledgeContributionAdapterConfig` (contribution-branch lifecycle)
- `DoltBranchSessionRunner` (`run` accepts `awaitSettlement` for CLI pool shutdown; thin operator error/telemetry/budget wrapper over the shared native executor; branch client is separate from reads)
- `createDoltgresPusher`, `DoltgresPusher`, `DoltgresPushConfig` (post-merge mirror to a Dolt remote; lazy `dolt_remote add` + `dolt_push`)
- `wrapPushSafe`, `PushOutcomeListener` (fire-and-forget wrapper with injectable success/failure callbacks — keeps logging out of the adapter)

**Service** (`@cogni/knowledge-store/service/contribution-service`):

- `createContributionService`, `ContributionService`, `ContributionServiceDeps`
- `ContributionServiceDeps.pushMainOnMerge?: () => Promise<void>` — optional post-merge mirror hook; caller owns error handling (service does not await + does not catch)
- `previewMerge(id)` uses the optional native port capability; unavailable capability fails closed. It shares admitted native session capacity, while ordinary reads keep their independent pool.

## Ports

- **Implements:** `KnowledgeStorePort`
- **Uses:** none

## Responsibilities

- This directory **does**: define port interfaces, Zod domain/contribution schemas, Doltgres row and contribution-branch adapters, branch-session admission, service policy, and Dolt remote push primitives.
- This directory **does not**: own Drizzle schema, load env vars, provision databases, bind HTTP routes, or decide node-specific domains/content.

## Notes

- The shared `@cogni-dao/doltgres-admission` engine owns native session capacity, settlement, guards and branch receipts. All executor and mutation imports use the same helper module instance. The private package retains confidence policy, sanitization, outgoing citations and goal-loop exports.

- **postgres.js parameterized queries don't work on Doltgres** — adapter uses `sql.unsafe()` + `escapeValue()` for all queries.
- **Required logical scope:** raw mutations and `commit` fail closed; use `withWrite({operationId,message}, write => ...)`. Root reads remain ordinary pooled reads.
- **Shared mechanism:** the published Dolt admission engine owns common native-database locks and isolated branch recovery; this private package preserves operator confidence, sanitizer, outgoing citations and goal-loop policy.
- **Successful retry identity:** lookup before INSERT under the guard; same payload returns canonical, changed payload conflicts. Unknown mutation acknowledgment returns nonretryable lookup evidence.
- **JSONB `@>` and ILIKE not supported** — fallbacks: `CAST(tags AS TEXT) LIKE` and `LOWER(col) LIKE`.
- **Doltgres 0.56 RBAC is non-functional** — GRANT reports success but roles can't even `SELECT current_user`. Runtime `DOLTGRES_URL_*` must connect as `postgres` superuser until upstream lands working role access.
- **`fetch_types: false` required** on all postgres.js connections (pg_type grants missing).
- Generic schema lives in `packages/knowledge-base`; node schema packages re-export it and may add companion tables.
- `listKnowledge(domain, { q })` matches `useWhen` only. Full-text claim search remains `searchKnowledge`; the HTTP routing projection is `/api/v1/knowledge/index`.
- `core__knowledge_index` / `core__knowledge_search` / `core__knowledge_read` / `core__knowledge_write` BoundTools ship in `@cogni/ai-tools`; the brain and autoresearch graphs use them via the tool runtime.
- `listGoverningIndex()` reads every governing row across domains in two unpaged queries (governing-type rows, `supersedes` edges); the cognition bundle and `core__knowledge_index` both render it.
- `evals/guidance-routing/` is the external-lane routing eval (`pnpm eval:guidance-routing`); it is outside the build, typecheck and PR CI. Its scorer is unit-tested in `tests/evals/`.
