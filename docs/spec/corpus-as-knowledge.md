---
id: corpus-as-knowledge
type: spec
title: "Corpus as Knowledge — Migrating Specs, Projects, and Work Items into Doltgres"
status: draft
spec_state: draft
trust: draft
summary: "Specs, projects, initiatives, charters, research, and design/review artifacts are first-class knowledge entries (entry_type discriminated) in `knowledge_operator` Doltgres. Work items remain lifecycle records but get linked to their produced artifacts via a single new join table (`work_item_artifacts`). Two relation tables with disjoint jobs: `citations` for knowledge↔knowledge syntropy, `work_item_artifacts` for work_item→knowledge audit. Migration is 5 PRs ending in a single sweep that purges the markdown corpus."
read_when: Designing the work-item or knowledge schema; planning the markdown→Doltgres corpus migration; writing the /closeout PR-scorecard renderer; deciding where a new doc type belongs.
implements:
owner: derekg1729
created: 2026-05-01
verified:
tags: [knowledge, doltgres, work-items, migration, syntropy, lifecycle]
---

# Corpus as Knowledge — Migrating Specs, Projects, and Work Items into Doltgres

> Work items are lifecycle. Specs are knowledge. Don't store them the same way, but commit them in the same Dolt history.

### Key References

|                       |                                                              |                                                  |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| **Knowledge plane**   | [knowledge-data-plane](./knowledge-data-plane.md)            | Doltgres infra, per-node DBs, port shape         |
| **Knowledge syntropy**| [knowledge-syntropy](./knowledge-syntropy.md)                | Storage expert / librarian, citation DAG         |
| **Dev lifecycle**     | [development-lifecycle](./development-lifecycle.md)          | Status enum, `/command` dispatch, validation     |
| **Validate candidate**| `.claude/skills/validate-candidate/SKILL.md`                 | The 3-axis scorecard this spec aligns work-item validation to |
| **Precedent**         | [task.0423 doltgres-work-items-source-of-truth](../../work/items/task.0423.doltgres-work-items-source-of-truth.md) | Shipped the `work_items` table; this spec finishes the migration |
| **Database arch**     | [databases.md](./databases.md)                               | Postgres-vs-Doltgres taxonomy, per-node schema independence |

## Goal

Make every durable artifact in this repo a row in `knowledge_operator` Doltgres so that:

1. The corpus is **versioned, branchable, and forkable** alongside the rest of node knowledge (one Dolt history covers code, knowledge, and work).
2. Agents can **search, cite, and compound** on specs/projects/research the same way they do on findings (syntropy applies uniformly).
3. Work items stay **brief lifecycle records** — intent + validation contract + status — with all sausage (designs, research output, review notes, as-built specs) hung off as linked knowledge artifacts.
4. The PR review scorecard at `/closeout` time is **a single SQL JOIN**, not a hand-curated list.

## Non-Goals

- Defining the Doltgres infrastructure (see `knowledge-data-plane`).
- Defining the storage-expert / librarian write+read protocols (see `knowledge-syntropy`).
- Replacing the Postgres awareness plane (orthogonal).
- Retroactively splitting legacy `.md` bodies into clean per-stage knowledge artifacts. Legacy items dump verbatim into `work_items.summary`; only new items use the clean split.

## Design

### Reconciling with the Postgres-vs-Doltgres taxonomy

The [databases.md](./databases.md) skill ground-truth lists work_items in the Doltgres column ("AI-written / AI-read knowledge — compounding expertise … work items, prompt versions, evidence"). The [knowledge-data-plane](./knowledge-data-plane.md) invariant `AWARENESS_HOT_KNOWLEDGE_COLD` reads "Live operational data stays in Postgres" — which would seem to push work_items the other way. This spec reconciles the two:

- **Awareness** (Postgres): high-frequency append-only telemetry — observation events, analysis runs, billing receipts, auth events. Rows are not revisited.
- **Knowledge** (Doltgres): AI-curated, mutable, version-worthy content — including specs, projects, research, **and work items**, because work items are AI-edited (status churn, revision count, validation refinement) and benefit from `dolt_log` audit.
- **Coordination** is not a third plane. It is a property of certain knowledge rows (work items in particular) that pulls them into the audit-heavy edit pattern Doltgres exists for.

This spec does not amend `AWARENESS_HOT_KNOWLEDGE_COLD`. It clarifies that "operational" in that invariant means **telemetry append**, not **lifecycle status mutation**. Work items live in Doltgres because they are AI-edited content with audit value, not because they are "operational."

### Two DAGs, one Dolt history

```
LIFECYCLE                          KNOWLEDGE
─────────                          ─────────
work_items (Doltgres)              knowledge (Doltgres)
- numeric id (bug.0002)            - "{entry_type}:{slug}" id
- + slug (human handle)              (e.g. spec:knowledge-data-plane)
- intent, validation                - entry_type ∈ {spec, charter, initiative,
- status, branch, pr, project        project, design, research, review,
                                     observation, finding, conclusion,
                                     rule, scorecard}
         │                                  │
         │                                  │
         ▼                                  ▼
  work_item_artifacts (NEW)          citations (per knowledge-syntropy)
  work_item → knowledge edges        knowledge ↔ knowledge edges
  + stage, round                     + supports/contradicts/extends/supersedes
  THE PR SCORECARD SOURCE             THE SYNTROPY DAG
```

Two relation tables, **disjoint domains, disjoint jobs.** No polymorphic FK. No build-anything graph. A single `dolt_commit` covers any combination of the four tables.

### Why a single join table beats embedding artifacts in work_items

A bug fix produces design notes, optional research, N rounds of review feedback, and an as-built spec amendment. Embedding any of that in `work_items` columns mixes lifecycle metadata with frozen-in-time content. The join table lets the work item stay ~12 frontmatter lines while the audit trail grows to dozens of rows — each row is a row, not a JSON blob.

### Two scorecards, complementary

This spec mentions two scorecards — they do not displace each other:

| Scorecard            | When            | Source                             | Question it answers                                  |
| -------------------- | --------------- | ---------------------------------- | ---------------------------------------------------- |
| **Artifact-trail**   | `/closeout`     | `work_item_artifacts JOIN knowledge` | "Did this PR follow the workflow?" (research → design → reviews → as-built spec) |
| **Validate-candidate** | post-flight   | qa-agent: HUMAN · AI · LOKI · OVERALL per surface | "Does the deployed thing work?" (per `validate-candidate` SKILL.md) |

The artifact-trail scorecard is rendered in the PR body by `/closeout`. The validate-candidate scorecard is posted as a PR comment after candidate-flight succeeds. Both must be present on a fully-validated PR.

### Validation contract — 3 axes, mirrors `validate-candidate` scorecard

The validate-candidate skill renders a per-row scorecard with columns **HUMAN · AI · LOKI · OVERALL.** Work-item validation must produce exactly that shape. Three fields, 1:1 with axes:

```yaml
validation:
  ai_exercise:    "POST /api/v1/poly/wallet/connect → 200, body.connectionId set"
  human_exercise: "open /poly/settings → click 'Connect Wallet' → status pill turns green"
  observability:  '{namespace="cogni-candidate-a"} | json | msg="poly.wallet.connect_success"'
```

- `ai_exercise` (required) — what the qa-agent runs; populates the AI cell.
- `human_exercise` (nullable) — what a human drives in Playwright; populates the HUMAN cell. Null → cell is `—`.
- `observability` (required) — Loki **tier-1 feature-specific marker** query (per validate-candidate §6); populates the LOKI cell. Generic `request received` lines do not qualify.

`deploy_verified = true` requires every non-null axis to land 🟢 against the deployed PR head SHA. The qa-agent reads these three fields directly — no separate test file, no separate config.

## Schema Delta

Exhaustive diff vs current Doltgres state. See `corpus-as-knowledge` migration PRs for the actual DDL.

### `work_items` (existing) — add 4 columns

| Column           | Add/Keep | Type       | Notes                                              |
| ---------------- | -------- | ---------- | -------------------------------------------------- |
| `slug`           | ADD      | text UNIQUE| Human handle (`gh-deploy-secret-exposure`)         |
| `ai_exercise`    | ADD      | text       | AI-axis validation                                 |
| `human_exercise` | ADD      | text NULL  | HUMAN-axis validation; null when fully automatable |
| `observability`  | ADD      | text       | LOKI tier-1 query                                  |

All other existing columns kept. `id` keeps its current PK shape. **Contract change:** `WorkItemsCreateInput` gains optional `id` (validated against `^(bug|task|spike|story)\.\d{4,}$`); supplying it requires the migrator role. Default behavior (no `id` supplied) is unchanged — server allocates 5000+.

### `knowledge` (designed in `knowledge-syntropy`, not yet implemented) — extend

| Field          | Change   | Notes                                                                                |
| -------------- | -------- | ------------------------------------------------------------------------------------ |
| `entry_type`   | EXTEND   | Add `spec`, `charter`, `initiative`, `project`, `design`, `research`, `review` to enum |
| `slug`         | ADD      | Bare slug. PK `id` is `{entry_type}:{slug}`. Slug is the human-grep handle.          |
| Other fields   | KEEP     | Per `knowledge-syntropy` spec; this spec does not redesign them.                     |

### `citations` (designed) — extend `citation_type` enum

| Type        | Existing/New | Use                                                                       |
| ----------- | ------------ | ------------------------------------------------------------------------- |
| `supports`  | existing     | "Entry A corroborates entry B"                                            |
| `contradicts` | existing   | "Entry A asserts the opposite of entry B"                                 |
| `extends`   | existing     | "Entry A builds on top of B"                                              |
| `supersedes`| existing     | "Entry A replaces B; B should be deprecated"                              |
| `implements`| **NEW**      | Project/initiative → spec ("this work realizes that spec")                |
| `references`| **NEW**      | Generic content link (markdown body link); weaker than `supports`         |

### `domains` (designed) — seed rows added

Seed: `engineering`, `infrastructure`, `product`, `governance`, `security`, `ai`, `operations`. Per-node domains (`prediction-market`, `reservations`, …) are added by node nodes.

### `work_item_artifacts` — NEW TABLE

```sql
CREATE TABLE work_item_artifacts (
  id           text PRIMARY KEY,
  work_item_id text NOT NULL REFERENCES work_items(id),
  knowledge_id text NOT NULL REFERENCES knowledge(id),
  stage        text NOT NULL,  -- research | design | implementation_note | review | as_built_spec
  round        integer,        -- nullable; review-round counter
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id, knowledge_id, stage, round)
);
```

One row per (work_item, artifact, stage, round). The PR scorecard query is:

```sql
SELECT a.stage, a.round, k.type, k.slug, k.title, k.status, k.confidence_pct
FROM work_item_artifacts a
JOIN knowledge k ON k.id = a.knowledge_id
WHERE a.work_item_id = $1
ORDER BY a.created_at;
```

`/closeout` renders this as a markdown table in the PR body.

## Slug Generation Protocol

Each `/command` produces a knowledge artifact whose slug is derived deterministically from its parent work item:

| Stage                | Knowledge id pattern                              | Example                                       |
| -------------------- | ------------------------------------------------- | --------------------------------------------- |
| research             | `research:{work_item.slug}`                       | `research:wallet-screening-targets`           |
| design               | `design:{work_item.slug}`                         | `design:tracked-wallet-port`                  |
| implementation_note  | `implementation_note:{work_item.slug}-r{N}`       | `implementation_note:tracked-wallet-port-r1`  |
| review (per round)   | `review:{work_item.slug}-r{N}`                    | `review:tracked-wallet-port-r1`               |
| as_built_spec        | `spec:{slug}` (slug independent of work_item)     | `spec:knowledge-data-plane`                   |

`as_built_spec` slugs are independent because specs survive long after the originating work item closes; they are the only stage whose slug must be chosen by the author at /design time and locked in `## File Pointers` of the spec doc.

## ID Conventions

| Surface     | ID shape                          | Example                                 | Rationale                                                      |
| ----------- | --------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| work_items  | `{type}.{4-digit-int}`            | `bug.0002`, `task.0425`                 | Branches, PR titles, memory all reference numeric IDs          |
| knowledge   | `{entry_type}:{slug}`             | `spec:knowledge-data-plane`             | Human-grep, durable, embeds in citation tokens                 |
| citation token | `knowledge:{node}:{id}#conf=&v=` | `knowledge:operator:spec:foo#conf=85&v=abc1234` | Per `knowledge-syntropy` — unchanged                |

work_items get an additional `slug` column (human handle, e.g. `gh-deploy-secret-exposure`) but the PK stays numeric. Two ID systems are justified by two distinct lifetimes — numeric for ephemeral lifecycle churn, slug for durable knowledge.

## Lifecycle Updates

Each `/command` produces a typed knowledge artifact and links it via `work_item_artifacts`. Status enum is unchanged.

| Command                  | work_items mutation               | knowledge produced (linked via work_item_artifacts) |
| ------------------------ | --------------------------------- | --------------------------------------------------- |
| `/idea`, `/bug`          | row created with intent+validation| —                                                   |
| `/triage`                | route + project link              | optional `triage_note`                              |
| `/research`              | status=done                       | `research:{slug}` at stage=research                 |
| `/design`                | status=needs_implement            | `design:{slug}` at stage=design                     |
| `/implement`             | status=needs_closeout, branch set | optional `implementation_note:{slug}-r{N}`          |
| `/review-implementation` | done OR revision++                | `review:{slug}-r{N}` per round                      |
| `/closeout`              | status=needs_merge, pr set        | PR body auto-rendered from work_item_artifacts; on merge of as-built spec edits, `design:{slug}` graduates to `spec:{slug}` (status: active) with a `supersedes` citation |

## Migration Phases

Five PRs, smallest first. Each merges and is flighted before the next is opened.

| #   | PR                                                                                              | Touches                                         | Unblocks                       |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| 1   | Extend `WorkItemsCreateInput` contract: optional `id`, `slug`, `ai_exercise`, `human_exercise`, `observability`. Bootstrap-token gate for client-supplied `id` (env var `WORK_ITEMS_MIGRATION_TOKEN`, rotated post-migration). Drizzle migration adds 4 columns to `@cogni/operator-doltgres-schema/work-items`. **Note:** existing work_items table comment already declares `ID_RANGE_RESERVED` for "future markdown imports" (task.0423) — schema scaffolding anticipates this PR. | `packages/node-contracts/`, `nodes/operator/packages/doltgres-schema/src/work-items.ts`, `nodes/operator/app/src/adapters/server/db/doltgres/work-items-adapter.ts` | Bulk work-item upload preserving legacy IDs |
| 2   | Bulk migration script `scripts/migrate/items-to-doltgres.mjs` with dry-run manifest. Reads `work/items/*.md`, parses frontmatter, POSTs to `/api/v1/work/items` with `id` supplied. Idempotent (skips on conflict; `--repair` to update). | `scripts/`, runtime data only | 469 items in DB; .md still source of truth |
| 3   | Add `knowledge` + `citations` + `domains` + `sources` tables to `@cogni/operator-doltgres-schema` (the operator currently has only `work_items`; poly has knowledge but operator does not). Add `POST/GET /api/v1/knowledge`, `POST /api/v1/knowledge/:id/cite`. Adapter must use `sql.unsafe()` (no tagged-template parameterization) and try-INSERT/catch-duplicate (no `ON CONFLICT EXCLUDED`) per Doltgres 0.56 caveats. Migrator must chain a trailing `SELECT dolt_commit('-Am', ...)` (per dolt#4843). Seed `domains`. May ride on or replace #1133. | `packages/node-contracts/`, `nodes/operator/packages/doltgres-schema/`, operator routes, drizzle | Knowledge plane live on operator |
| 4   | Bulk migration script `scripts/migrate/corpus-to-knowledge.mjs`. Walks `docs/spec/`, `work/{projects,initiatives,charters}/`, `docs/research/`. For each file: parse frontmatter, choose `entry_type`, set `id={type}:{slug}`, `content=raw markdown body`, `confidence_pct` from `trust:` field. Parses inline `[..](../spec/foo.md)` links → citation edges. | `scripts/` | Corpus in DB |
| 5   | Add `work_item_artifacts` table. Wire markdown readers in `packages/work-items/` to read from Doltgres. Backfill historical `work_item_artifacts` rows from `implements:`, `spec_refs:`, `## Related` sections. **Single sweeping commit deletes** `work/items/*.md`, `docs/spec/*.md`, `work/projects/*.md`, `work/initiatives/*.md`, `work/charters/*.md`, `docs/research/*.md`. AGENTS.md / CLAUDE.md updated to point to the API. Migration manifest committed at `work/migration-manifest.json`. | repo-wide | .md corpus purged |

PR #5 is the only destructive step. PRs 1–4 are additive — failure of #4 does not require rolling back #1–3.

## Invariants

| Rule                              | Constraint                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ONE_DOLT_HISTORY                  | work_items, knowledge, citations, work_item_artifacts all live in `knowledge_operator`. One `dolt_commit` covers any cross-table change.                                                            |
| WORK_ITEMS_ARE_LIFECYCLE          | work_items contains intent + validation + status + pointers. Body content (designs, reviews, as-built specs) lives in `knowledge`, never in work_items columns.                                     |
| KNOWLEDGE_IS_CONTENT              | Specs, projects, initiatives, charters, research, designs, reviews are rows in `knowledge`. Discriminated by `entry_type`. No separate per-type tables.                                             |
| ONE_TABLE_PER_RELATION            | `citations` carries knowledge↔knowledge edges. `work_item_artifacts` carries work_item→knowledge edges. No third relation table. No polymorphic edges.                                              |
| VALIDATION_THREE_AXES             | Every task/bug has `ai_exercise`, `observability`, and optionally `human_exercise`. Names mirror the validate-candidate scorecard columns 1:1.                                                      |
| DEPLOY_VERIFIED_EXERCISES_ALL_AXES | `deploy_verified=true` requires every non-null axis to be exercised 🟢 at the deployed PR head SHA. Skipping a populated axis is a 🟡 at best — never 🟢.                                            |
| ID_DISCIPLINE                     | work_items keep numeric IDs (`bug.0002`). Knowledge keeps slug IDs (`spec:knowledge-data-plane`). Cross-references between the two go through `work_item_artifacts`, never by string-pattern parsing. |
| MIGRATOR_ROLE_GUARDS_LEGACY_IDS   | Client-supplied work_item `id` is rejected unless the request bears the migrator role. External agents always get server-allocated IDs (5000+).                                                     |
| LEGACY_BODIES_ARE_OPAQUE          | Migration #2 dumps each .md body verbatim into `work_items.summary`. No retroactive split into per-stage knowledge artifacts. Only new items use the clean split.                                   |
| SCORECARD_IS_A_QUERY              | The PR review scorecard at `/closeout` is rendered from `SELECT FROM work_item_artifacts JOIN knowledge`. No hand-curated artifact list in PR bodies.                                               |
| PURGE_IS_ATOMIC                   | The .md corpus is deleted in exactly one PR (#5), after the API has been read-shadowed for ≥1 week and `work_item_artifacts` is backfilled. No incremental purges.                                  |
| STATUS_BY_TABLE                   | `work_items.status` values are lifecycle states (`needs_triage`, `needs_implement`, `done`, …). `knowledge.status` values are syntropy promotion states (`draft`, `candidate`, `established`, `canonical`, `deprecated`). Same column name, disjoint enums; never conflate.                              |
| DOLTGRES_ADAPTER_DISCIPLINE       | Per [databases.md](./databases.md) Doltgres caveats: no tagged-template parameterized queries (use `sql.unsafe()`), no `ON CONFLICT ... EXCLUDED` (use try-INSERT/catch-duplicate), trailing `SELECT dolt_commit('-Am', ...)` after every schema-change migration (per dolt#4843).                       |
| MIGRATION_TOKEN_IS_ONESHOT        | Client-supplied work_item `id` is gated on env-var `WORK_ITEMS_MIGRATION_TOKEN` checked at the API handler. Token is set during the bulk migration window and **must be unset** in operator env after PR #2 verifies. No persistent migrator role; this is a one-time-use bootstrap.                    |

## Open Questions

- [ ] Citation backfill granularity: parse all markdown links in spec bodies as `references` edges, or only the explicit `## Related` / `implements:` frontmatter? Body links are noisier but more complete. Likely: explicit-only at PR #4, body-link sweep as a follow-up.
- [ ] `domains` seed list — final set proposed: `engineering`, `infrastructure`, `product`, `governance`, `security`, `ai`, `operations`. Confirm or amend before PR #3.
- [ ] `work_item_artifacts.stage` — enum (DB-enforced) or free text with explicit `other`? Leaning enum.
- [ ] When a design spec graduates to as-built, do we keep both rows in `knowledge` (design + spec, linked by `supersedes`) or update the design row's entry_type in place? Keeping both preserves history; updating in place is simpler. Leaning keep both — costs one row, gains full audit.
- [ ] Does PR #5 also rewrite the legacy `[../../work/items/foo.md](...)` markdown links inside surviving docs (e.g. AGENTS.md, CLAUDE.md, command files), or do those become dead links until a follow-up sweep? Leaning rewrite-in-PR-5 — single atomic purge.

### File Pointers

| File                                                                  | Purpose                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/node-contracts/src/work.items.create.v1.contract.ts`        | `WorkItemsCreateInput` (gains optional `id`, `slug`, validation triple) |
| `nodes/operator/app/src/adapters/server/db/doltgres/work-items-adapter.ts` | Allocator + new client-id branch (migrator role guard)           |
| `nodes/operator/app/src/app/api/v1/work/items/route.ts`               | POST/GET handlers (existing)                                         |
| `nodes/operator/app/src/app/api/v1/knowledge/route.ts`                | NEW — knowledge CRUD                                                 |
| `nodes/operator/app/src/app/api/v1/work/items/[id]/artifacts/route.ts`| NEW — work_item_artifacts CRUD                                       |
| `scripts/migrate/items-to-doltgres.mjs`                               | NEW — bulk work-item upload                                          |
| `scripts/migrate/corpus-to-knowledge.mjs`                             | NEW — bulk corpus upload                                             |
| `packages/work-items/src/adapters/doltgres/`                          | Doltgres-backed reader (replaces markdown adapter at PR #5)          |
| `.claude/skills/validate-candidate/SKILL.md`                          | Scorecard format — work-item validation field names mirror this      |
| `.claude/commands/closeout.md`                                        | Renders PR scorecard from `work_item_artifacts` JOIN                 |

## Related

- [knowledge-data-plane](./knowledge-data-plane.md) — the Doltgres infra this rides on
- [knowledge-syntropy](./knowledge-syntropy.md) — write/read protocols, citation DAG, librarian
- [development-lifecycle](./development-lifecycle.md) — the lifecycle this corpus migration formalizes
- [docs-work-system](./docs-work-system.md) — type taxonomy that becomes `entry_type` enum values
