---
id: chr.knowledge
type: charter
title: "KNOWLEDGE Charter"
state: Active
summary: Compounding, versioned domain knowledge that makes every node provably smarter over time.
created: 2026-04-02
updated: 2026-04-29
---

# KNOWLEDGE Charter

## Goal

Every Cogni node accumulates domain expertise in a versioned, queryable, exportable knowledge store. Knowledge compounds — agents get smarter with every interaction, research run, and outcome validation. Provable competence: you can diff what the node knew last week vs today and measure the delta.

## Data Segments at Cogni

Cogni nodes have four distinct data planes. Each serves a different purpose with different lifecycle and storage characteristics. A dedicated guide for this segmentation is needed (separate from this charter).

| Segment              | Storage  | Tempo         | What lives here                                                                                                                                            |
| -------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operational data** | Postgres | Real-time     | Users, billing, auth, scheduling, AI runs, observations, signals. All critical ops info captured automatically.                                            |
| **Stream data**      | Redis    | Ephemeral     | Live market feeds, SSE events, trigger evaluation. No persistence — replay from source.                                                                    |
| **Knowledge**        | Doltgres | Hours-to-days | Curated domain expertise — strategies, claims, research findings. The only way (besides git) to save + compound knowledge. Versioned with commit/log/diff. |
| **Code + ops**       | Git      | Commits       | Source code, specs, work items, AGENTS.md, repo-spec.yaml. The codebase itself.                                                                            |

Doltgres is not a replacement for Postgres. Postgres owns all hot operational data — it flows there automatically through existing pipelines. Doltgres is the deliberate, curated layer: what the AI has _learned_, not what it has _seen_.

## What Dolt Is

Dolt is git for data. Doltgres is the Postgres-compatible flavor. Same wire protocol, same SQL, same Drizzle ORM — but with native `commit`, `log`, `diff`, `branch`, `merge`. Every write creates a versioned snapshot. You can pin an analysis to a knowledge commit hash and reproduce it exactly.

Each node gets its own Doltgres database (`knowledge_operator`, `knowledge_poly`, etc.). Data sovereignty is structural — separate databases, not policy.

## Health Scorecard

> Living view of where the knowledge plane stands vs. the syntropy spec. Updated on every meaningful PR. 🟢 = shipped + exercised on candidate-a · 🟡 = shipped or in-flight, partial · 🔴 = not started or known-broken.

### Infrastructure

| Component                              | Status | Notes                                                                                                              |
| -------------------------------------- | :----: | ------------------------------------------------------------------------------------------------------------------ |
| Doltgres server on candidate-a         |   🟢   | Per-node DBs (`knowledge_poly`, `knowledge_operator`); EndpointSlice bridge from k8s → Compose (task.0311)         |
| Per-node provisioning (`provision.sh`) |   🟢   | Iterates `COGNI_NODE_DBS`; idempotent; reader/writer roles (vestigial until 0.56 RBAC works)                       |
| drizzle-kit migrator (k8s PreSync Job) |   🟢   | Poly + operator both wired (#894 / #1130). `stamp-commit.mjs` post-migrate captures DDL into `dolt_log`            |
| `KnowledgeStorePort` + adapter         |   🟡   | Works; `sql.unsafe + escapeValue` everywhere. Internal-agents-only safe. Hardening required before x402 / external |
| 3 AI tools (`search/read/write`)       |   🟢   | Wired into brain graph; recall-first protocol live in candidate-a                                                  |

### Schema (syntropy seed bundle)

| Table                     | Spec'd | Shipped on poly | Shipped on operator | Notes                                                              |
| ------------------------- | :----: | :-------------: | :-----------------: | ------------------------------------------------------------------ |
| `knowledge` (v0 — 10 col) |   ✓    |       🟢        |         🔴          | Operator never had it — gets full extended shape directly via PR-C |
| `knowledge` (extended)    |   ✓    | 🟡 (PR-B #1142) |   🟡 (PR-C #1143)   | +`entry_type`, `status`, `source_node`, `updated_at`               |
| `citations` (DAG)         |   ✓    | 🟡 (PR-B #1142) |   🟡 (PR-C #1143)   | Schema only — no app uses citation edges yet                       |
| `domains`                 |   ✓    | 🟡 (PR-B #1142) |   🟡 (PR-C #1143)   | FK constraint deferred (Doltgres FK unverified); app-layer enforce |
| `sources`                 |   ✓    | 🟡 (PR-B #1142) |   🟡 (PR-C #1143)   | Reliability scoring — schema only, no scorer yet                   |
| `knowledge_contributions` |   ✓    | 🟡 (PR-B #1142) |   🟡 (PR-C #1143)   | Metadata for branch-per-contribution flow (PR-D wires the API)     |
| `BASE_DOMAIN_SEEDS`       |   ✓    | 🟡 (PR-A #1141) |   🟡 (PR-A #1141)   | 5 base domains; not yet auto-applied post-migrate                  |

### Agent + governance flows

| Capability                                        | Status | Notes                                                                                             |
| ------------------------------------------------- | :----: | ------------------------------------------------------------------------------------------------- |
| Agent recall-first protocol                       |   🟢   | Brain prompt: `core__knowledge_search` before web search                                          |
| Internal `core__knowledge_write` → main           |   🟢   | Auto-commits via capability layer                                                                 |
| External-agent contribution (HTTP, branch-per-PR) |   🟡   | PR-D #1133 in design + package layer; needs PR-A/B/C to merge                                     |
| Storage-expert role (curator agent)               |   🔴   | Not started; agents currently write directly                                                      |
| Librarian role (retrieval agent w/ citations)     |   🔴   | Brain uses tools directly; no dedicated retrieval persona                                         |
| Citation token format in agent output             |   🔴   | `knowledge:{node}:{id}#conf=X&v=Y` spec'd, no citation guard yet                                  |
| Confidence recomputation (citation walk)          |   🔴   | Spec'd in syntropy; no implementation                                                             |
| Promotion lifecycle (status field driven)         |   🔴   | Schema has `status` column; no agent automation moves entries through draft→candidate→established |
| Awareness → knowledge promotion gate              |   🔴   | Spec'd; not built                                                                                 |

### Sharing + federation

| Capability                            | Status | Notes                                                                                                                                                                    |
| ------------------------------------- | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-node sovereign DBs                |   🟢   | `DATA_SOVEREIGNTY` structural; one DB per node                                                                                                                           |
| Fork-takes-knowledge                  |   🟢   | Standalone Dolt repo per DB with full commit history                                                                                                                     |
| **Dolt remotes** (cross-node sharing) |   🔴   | **Not configured.** `dolt_push`/`dolt_pull` infrastructure missing. No DoltHub or self-hosted remote — required for cross-node knowledge flow / operator pull-down model |
| External-contribution PR semantics    |   🟡   | Designed (PR-D) — Dolt branches mediate review; merges land via API                                                                                                      |
| Operator → node base seed pull        |   🔴   | Spec describes it; current invariant `NODES_BOOT_EMPTY` consciously punts                                                                                                |
| Postgres derived search index         |   🔴   | Per syntropy spec — `knowledge_search` table + embedding sync. Not built                                                                                                 |
| Vector embeddings (BGE-M3 / voyage)   |   🔴   | Open question in syntropy spec — model unselected                                                                                                                        |
| Hybrid FTS + vector retrieval (RRF)   |   🔴   | Defer until Postgres index exists                                                                                                                                        |
| x402 paid librarian access            |   🔴   | vFuture. Spec'd, no implementation                                                                                                                                       |
| Obsidian export                       |   🔴   | Charter goal; not started                                                                                                                                                |

### Hardening

| Concern                                        | Status | Notes                                                                                                       |
| ---------------------------------------------- | :----: | ----------------------------------------------------------------------------------------------------------- |
| `sql.unsafe` SQL-injection surface             |   🟡   | `escapeValue()` is hand-rolled; OK for internal agents. **Needs review before external-contribution lands** |
| Doltgres FK enforcement                        |   🔴   | Unverified in 0.56; FKs not declared. App-layer is the only enforcement                                     |
| Component tests against testcontainer Doltgres |   🟡   | Existing knowledge adapter has tests; new contribution adapter has zero (PR-D)                              |
| Doltgres advisory locks (multi-replica safety) |   🔴   | Untested. Single-replica today. Required if operator scales out                                             |
| Snapshot/journal hand-rolling (PR-C)           |   🟡   | drizzle-kit may regen on first run after merge — track follow-up                                            |
| RBAC                                           |   🔴   | Doltgres 0.56 GRANT non-functional; runtime is superuser per `RUNTIME_URL_IS_SUPERUSER`                     |

### Top three asks (where to push next)

1. **🟡 Knowledge Syntropy umbrella — drive W1 → W2 → R0.** The compile→Q&A→file-back→lint loop runs end-to-end on Doltgres. W0 gates shipped (PR #1356); W1 EDO Crawl in flight (PR #1327); W2 closes the bearer-EDO split-brain so editorial writes route through `contrib/*`; R0 surfaces chains on `/knowledge?mode=chains` so syntropy is visible. See [proj.knowledge-syntropy](../projects/proj.knowledge-syntropy.md) — the umbrella that subsumes the previously separate write-pipeline + edo-foundation projects.
2. **🔴 → 🟡 Dolt remotes.** Stand up a self-hosted Dolt remote (or DoltHub repo) so nodes can `dolt_pull` operator base + `dolt_push` validated knowledge. Unblocks operator-curated seed flow + cross-node federation.
3. **🔴 → 🟡 Postgres derived search index.** Even a manual one-off rebuild script + a `knowledge_search` table unlocks FTS / vector retrieval. Vector model selection is the gating decision.

## Active PR Stack — task.0425 (external knowledge contribution API)

| PR               | Branch / scope                                                |                                                           Status                                                            | Validation                                                                                                                    |
| ---------------- | ------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------- |
| **#1141 (PR-A)** | node-template — `feat/task-0425-pr-a-syntropy-seed-schema`    |                                               🟢 CI green; flight no-op pass                                                | TS only; no runtime to exercise. Validates via downstream PRs picking up the schema                                           |
| **#1142 (PR-B)** | poly — `feat/task-0425-pr-b-poly-syntropy-migration`          |                            🟡 CI fail on `static` (pre-existing main lint debt; unrelated to PR)                            | Pending main rebase post-#1140; then candidate-flight-infra → migrator runs against `knowledge_poly`                          |
| **#1143 (PR-C)** | operator — `feat/task-0425-pr-c-operator-knowledge-migration` | 🔴 CI fail on `static` + `build (operator)` (lockfile gap from new workspace dep + pre-existing market-provider rename ref) | Needs lockfile regen after rename ref fixed on main. Then candidate-flight-infra → migrator runs against `knowledge_operator` |
| **#1133 (PR-D)** | operator — `feat/task-0425-knowledge-contribution-api`        |                                 🟡 design + package layer landed; rebases when A/B/C merge                                  | E2E validation: register agent → POST contribution → diff → admin merge → search confirms entry on `main`                     |

**Sequence:** PR-A merges → PR-B + PR-C in parallel → PR-D rebases onto main, finishes routes/bootstrap, candidate-flights.

## Current State (v0)

### What's Built

| Component                         | What                                                                      | Where                                                              |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **KnowledgeStorePort**            | Typed CRUD + versioning interface                                         | `packages/knowledge-store/`                                        |
| **DoltgresKnowledgeStoreAdapter** | Doltgres-backed implementation (sql.unsafe + escapeValue)                 | `packages/knowledge-store/adapters/doltgres/`                      |
| **createKnowledgeCapability**     | Shared factory wrapping port → capability with auto-commit                | `packages/knowledge-store/src/capability.ts`                       |
| **3 AI Tools**                    | `core__knowledge_search`, `core__knowledge_read`, `core__knowledge_write` | `packages/ai-tools/src/tools/knowledge-*.ts`                       |
| **Brain graph wiring**            | Knowledge tools first in prompt, recall-first protocol                    | `packages/langgraph-graphs/src/graphs/brain/`                      |
| **Per-node schema**               | Base table (node-template) + domain seeds (poly)                          | `nodes/{node}/packages/knowledge/`                                 |
| **Infrastructure**                | Doltgres in docker-compose, provision + seed scripts                      | `infra/compose/runtime/doltgres-*`, `scripts/db/seed-doltgres.mts` |

### Knowledge Table Schema

```
knowledge (
  id            TEXT PRIMARY KEY      -- deterministic or human-readable
  domain        TEXT NOT NULL          -- namespace: strategy, implementation, meta, ...
  title         TEXT NOT NULL          -- human-readable summary
  content       TEXT NOT NULL          -- the claim or fact
  confidence_pct INTEGER              -- 0-100 (30=draft, 80=verified, 95=hardened)
  source_type   TEXT NOT NULL          -- human, analysis_signal, external, derived
  source_ref    TEXT                   -- URL, DOI, signal ID, analysis run ID
  tags          JSONB                  -- searchable categorization
  entity_id     TEXT                   -- optional stable subject key
  created_at    TIMESTAMPTZ           -- auto-set
)
```

### Agent Recall Protocol

1. **Search knowledge first** — before web search, before making claims
2. **High confidence (>70%)?** — use it, cite the entry ID
3. **Low confidence or stale?** — re-research, update via `knowledge_write`
4. **Not found?** — research externally, save findings at 30% confidence (draft)

### Confidence Lifecycle

```
30% (DRAFT)     → agent writes new finding, unverified
80% (VERIFIED)  → human-reviewed OR agent-confirmed with fresh sources
95% (HARDENED)  → outcome-validated, statistically significant, repeatedly confirmed
```

## Charter Work Requests

_Updated by governance skills_

| Charter | Priority | Severity | Work Item | Status | Notes               |
| ------- | -------- | -------- | --------- | ------ | ------------------- |
| —       | —        | —        | —         | —      | No pending requests |

## Principles

- **Knowledge compounds** — every interaction should leave the node smarter
- **Confidence over volume** — 10 verified claims beat 1000 drafts
- **Recall before research** — always search knowledge before web search
- **Version everything** — every write is a commit, every analysis pins a knowledge hash
- **Export-friendly** — knowledge should be exportable to Obsidian, markdown, or any graph viewer

## Projects

| Project                  | Status | Description                                                             |
| ------------------------ | ------ | ----------------------------------------------------------------------- |
| proj.poly-prediction-bot | Active | First domain consuming knowledge plane (prediction market intelligence) |

## Where We're Going

### Near Term

| Initiative              | Status                    | What                                                                                  |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| Data segmentation guide | Not started               | Clear guide for all 4 data planes (Redis, Postgres, Doltgres, Git) — when to use each |
| Branching CI/CD         | story.0248 (needs_design) | Experiment branches, A/B eval, confidence-gated merge to main                         |
| Node lifecycle          | story.0263 (needs_design) | Clone from DoltHub remotes, pull operator updates, push contributions                 |
| Obsidian export         | Not started               | Export knowledge as Obsidian-compatible markdown vault — links, tags, graph view      |
| Knowledge visualization | Not started               | Web UI for browsing knowledge graph — entries, domains, confidence, provenance chains |

### Long Term

- **Cross-node federation** — validated knowledge flows between nodes via x402 payment protocol
- **Semantic search** — pgvector embeddings alongside Doltgres structured data
- **Evidence chains** — claim A supports/contradicts claim B, derived confidence
- **Automatic promotion** — awareness pipeline outcomes automatically update knowledge confidence

## Constraints

- Doltgres is Beta — storage format may change before 1.0. Pin versions, don't use for irreplaceable data without backups.
- No pgvector in Doltgres — semantic search stays in Postgres until Doltgres supports extensions.
- `sql.unsafe()` for all queries — Doltgres doesn't support the extended query protocol. Internal agents only until hardened.

## Invariants

| Rule                            | What                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| AWARENESS_HOT_KNOWLEDGE_COLD    | Operational data in Postgres. Curated expertise in Doltgres.           |
| KNOWLEDGE_SOVEREIGN_BY_DEFAULT  | Each node's knowledge is private. Sharing is explicit, never default.  |
| PORT_BEFORE_BACKEND             | All access through KnowledgeStorePort. Never raw SQL from consumers.   |
| CONFIDENCE_SCORED               | Every claim has a 0-100 confidence. Default draft = 30%.               |
| AUTO_COMMIT                     | Every write creates a Doltgres commit. No uncommitted knowledge.       |
| SCHEMA_GENERIC_CONTENT_SPECIFIC | One table, domain specificity in row content (domain, tags).           |
| FORK_TAKES_KNOWLEDGE            | Self-hosted node takes its Doltgres database with full commit history. |

## Success Metrics

- **Knowledge growth rate** — entries added per week, by domain
- **Confidence distribution** — % of entries at draft vs verified vs hardened
- **Recall hit rate** — % of agent queries that find relevant existing knowledge
- **Staleness** — % of entries older than 30 days without re-verification
- **Commit velocity** — Doltgres commits per day (measures active knowledge curation)

## Key References

| What                   | Where                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Spec                   | [knowledge-data-plane.md](../../docs/spec/knowledge-data-plane.md)                                                   |
| Design doc             | [knowledge-data-plane-prototype.md](../../docs/design/knowledge-data-plane-prototype.md)                             |
| Shared package         | [packages/knowledge-store/](../../packages/knowledge-store/)                                                         |
| Node schema (template) | [nodes/node-template/packages/knowledge/](../../nodes/node-template/packages/knowledge/)                             |
| Poly seeds             | [nodes/poly/packages/knowledge/](../../nodes/poly/packages/knowledge/)                                               |
| Brain prompt           | [packages/langgraph-graphs/src/graphs/brain/prompts.ts](../../packages/langgraph-graphs/src/graphs/brain/prompts.ts) |
| Seed script            | [scripts/db/seed-doltgres.mts](../../scripts/db/seed-doltgres.mts)                                                   |
| Provision script       | [infra/compose/runtime/doltgres-init/provision.sh](../../infra/compose/runtime/doltgres-init/provision.sh)           |
