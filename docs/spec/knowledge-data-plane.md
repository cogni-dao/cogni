---
id: knowledge-data-plane-spec
type: spec
title: "Knowledge Data Plane — Doltgres-Backed Expertise for Node-Template"
status: active
spec_state: active
trust: draft
summary: "Separates hot operational awareness (Postgres) from cold curated knowledge (Doltgres). Doltgres is a Postgres-wire-compatible Dolt server with git-like versioning (dolt_commit, dolt_log, dolt_diff). Per-node `knowledge_<node>` databases. Agents read/write via three core tools (knowledge_search, knowledge_read, knowledge_write) backed by a KnowledgeStorePort + DoltgresKnowledgeStoreAdapter. Schema applied via drizzle-kit migrator (k8s PreSync Job); every write auto-commits."
read_when: Designing a knowledge store for a Cogni node, choosing where data lives (awareness vs knowledge), understanding the promotion boundary, debugging Doltgres RBAC or query protocol quirks, or forking the node-template.
implements:
owner: derekg1729
created: 2026-03-31
verified: 2026-05-28
tags: [knowledge, dolt, node-template, awareness, data-plane, cogni-template]
---

# Knowledge Data Plane — Doltgres-Backed Expertise for Node-Template

> Awareness is what you see. Knowledge is what you've learned. Don't store them in the same place.

### Key References

|                      |                                                                             |                                               |
| -------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| **Awareness Plane**  | [monitoring-engine spec](./monitoring-engine.md)                            | ObservationEvent, triggers, signals, outcomes |
| **Prior Research**   | spike.0137 (branch `docs/spike-0137-knowledge-store`)                       | Three-layer knowledge architecture            |
| **Prior Design**     | proj.knowledge-store (branch `docs/spike-0137-knowledge-store`)             | Postgres-based entity/relation/observation    |
| **Market Provider**  | [market-provider AGENTS.md](../../packages/market-provider/AGENTS.md)       | Polymarket + Kalshi adapters                  |
| **Poly Project**     | [proj.poly-prediction-bot](../../work/projects/proj.poly-prediction-bot.md) | First domain consuming both planes            |
| **Node vs Operator** | [node-operator-contract](./node-operator-contract.md)                       | Fork freedom, data sovereignty                |

## Goal

Enable Cogni nodes to accumulate domain expertise — strategies, prompt versions, evaluations, evidence — in a versioned knowledge store that is architecturally separate from the hot awareness pipeline. Adding a new domain's expertise requires only seed data; the schema is generic. The port abstraction enables a future migration from Postgres to Dolt when branching, fork inheritance, and cross-node sharing are needed.

## Design

### Problem

The monitoring-engine spec defines an awareness plane — observation events, trigger evaluation, AI analysis runs, scored signals, calibration outcomes. All of this is hot operational data: append-only, high-frequency, domain-specific, stored in Postgres.

But there's a second class of data that accumulates slower and has different lifecycle needs:

- **Strategies** — named decision approaches (e.g., "base-rate-anchored calibrated analyst")
- **Prompt versions** — the actual system prompts, versioned, diffable
- **Evaluations** — which strategy+prompt versions performed against what outcomes
- **Evidence references** — curated pointers to external research, papers, data sources
- **Playbooks** — operational runbooks ("if market shows X pattern, consider Y")
- **Knowledge claims** — curated assertions the system believes to be true, with provenance

This data is:

- **Mutable** — strategies evolve, prompts get refined, claims get corrected
- **Versioned** — you need to know what changed, when, and why
- **Forkable** — when a node forks the template, it should inherit the knowledge base
- **Experimental** — you want to branch, test a new prompt on a branch, eval it, merge if it works
- **Shareable** — validated knowledge can flow between nodes (operator → node, node → operator)

Plain Postgres can serve this with append-only version rows, but it gets clumsy — manual `version` columns, `valid_from`/`valid_to` ranges, and audit triggers recreate what a version-controlled database gives you natively. **Doltgres** solves this: it's a Postgres-compatible drop-in with native git-like versioning (commit, log, diff, branch, merge). Same wire protocol, same Drizzle schemas, same `postgres` driver. The only additions are Dolt-specific SQL functions for versioning workflows.

---

## Design: Two Planes, Two Tempos

```
┌────────────────────────────────────────────────────────┐
│                     POSTGRES                            │
│  "Hot + immutable data, users, operations"             │
│                                                        │
│  Existing: auth, billing, ai, scheduling, identity,   │
│            reservations, attribution, ingestion        │
│            (see db-schema/src/*.ts)                    │
│                                                        │
│  Awareness tables (monitoring-engine spec, not yet     │
│  implemented): observation_events, analysis_runs,     │
│  analysis_signals, analysis_outcomes, base_rates      │
│                                                        │
│  Tempo: real-time to minutes                           │
│  Mutability: append-only / operational                 │
└──────────────────────────┬─────────────────────────────┘
                           │
                    Promotion Gate
                    (reviewed, repeated, or outcome-backed)
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│                    DOLTGRES                              │
│  "Compounding memory — what the AI has learned"        │
│                                                        │
│  Starter kit: knowledge, strategies, ...               │
│  Grows as the node accumulates expertise               │
│                                                        │
│  Tempo: hours to days                                  │
│  Mutability: versioned (dolt_commit, dolt_log, diff)   │
└────────────────────────────────────────────────────────┘
```

**Postgres** is for hot/immutable data and operational concerns: user accounts, billing, auth, scheduling, append-only ingestion receipts, and (per [monitoring-engine spec](./monitoring-engine.md)) the awareness pipeline tables. These are defined in `packages/db-schema/src/` and the monitoring-engine spec respectively — this spec does not own them.

**Doltgres** is for compounding memory: domain-specific knowledge, strategies, and (eventually) versioned prompts that accumulate and evolve over time. Version-controlled natively. The table set is a starter kit that grows as the node matures — not a fixed schema.

---

## Why Doltgres

Doltgres is a Postgres-compatible database with native git-like versioning. It's a **drop-in replacement** — same wire protocol, same SQL, same Drizzle ORM, same `postgres` driver. The only additions are Dolt-specific SQL functions for versioning.

| Capability            | What Doltgres adds                                          |
| --------------------- | ----------------------------------------------------------- |
| Version history       | `SELECT * FROM dolt_log ORDER BY date DESC`                 |
| Commit changes        | `SELECT dolt_commit('-Am', 'added poly strategy v2')`       |
| Diff two versions     | `SELECT * FROM dolt_diff('HEAD~1', 'HEAD', 'strategies')`   |
| Pin analysis to state | `SELECT hashof('HEAD')` → store as `knowledge_commit`       |
| Audit by default      | Every commit has author + message + timestamp               |
| Future: branching     | `SELECT dolt_checkout('-b', 'experiment/prompt-v4')`        |
| Future: remotes       | `SELECT dolt_push('origin', 'main')` for cross-node sharing |

**What stays the same:** Drizzle table definitions, `postgres` driver, existing Drizzle migration tooling, testcontainer patterns, `@cogni/db-client` factory. The knowledge schema is standard Postgres DDL.

**What's new:** Workflows for committing, logging, and (future) pushing/syncing knowledge data. These are additional SQL calls, not a different database engine.

### Surface today

Single branch (`main`), commit-based versioning. Read, write, commit, log, diff. No branching, no remotes, no merge workflows.

### Versioning Workflows

**After writes — commit:**

```sql
-- Standard Drizzle INSERT (unchanged)
INSERT INTO strategies (id, domain, name, ...) VALUES (...);
INSERT INTO strategy_versions (id, strategy_id, version, ...) VALUES (...);
-- Then commit the change
SELECT dolt_commit('-Am', 'add calibrated market analyst strategy v1');
```

**Audit — log:**

```sql
SELECT * FROM dolt_log ORDER BY date DESC LIMIT 10;
```

**Diff — what changed:**

```sql
SELECT * FROM dolt_diff('HEAD~1', 'HEAD', 'prompt_versions');
```

**Pin analysis to knowledge state:**

```sql
SELECT hashof('HEAD') as knowledge_commit;
-- Store in analysis_runs.knowledge_commit for reproducibility
```

### Relationship to Prior Work

The spike.0137 research identified a three-layer architecture (raw → claims → canonical). The proj.knowledge-store design placed all layers in plain Postgres. This spec refines that by:

1. Clarifying the awareness/knowledge boundary (which the prior design blurred)
2. Using Doltgres for the knowledge layer (native versioning instead of manual version columns)
3. Using a simpler schema (strategies/prompts/evaluations — the immediate need)

Layer 0 (raw archive) stays in plain Postgres — it's append-only and benefits from Postgres's ecosystem (TimescaleDB, RLS).

---

## The Split: Polymarket Intelligence vs Node-Template Knowledge

This is the critical architectural boundary. Getting it wrong means either:

- Poly-specific data leaks into the generic template (every fork inherits prediction market tables), or
- Generic capabilities get trapped in domain-specific code (other domains can't reuse strategy versioning)

### What stays in Postgres

Everything that exists today (`packages/db-schema/src/*.ts`) plus the awareness pipeline tables defined in the [monitoring-engine spec](./monitoring-engine.md). This spec does not define or own any Postgres tables — it only defines the Doltgres knowledge tables below.

### What lives in Doltgres (knowledge plane)

Curated expertise that compounds over time. The table set is open — domain specificity lives in row content (`domain`, `tags`), not in table structure. Nodes add companion tables only when a domain needs genuinely new columns (see SCHEMA_GENERIC_CONTENT_SPECIFIC).

| Table        | Purpose                                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge`  | Domain-specific facts, claims, and curated assertions with provenance                                                                                                                                                                     |
| `work_items` | Operator-only companion table — lifecycle artifacts (tasks, bugs, spikes, stories). Structured columns + per-row dolt_log audit; not subject to `domain`/`tags` syntropy because rows are typed lifecycle entities, not free-form claims. |

### Domain Extension Pattern

Domains don't add tables to the knowledge plane. They add **rows with domain-specific content**:

```sql
-- Generic schema, domain-specific content
INSERT INTO strategies (id, domain, name, description)
VALUES ('poly-calibrated-analyst', 'prediction-market',
        'Calibrated Market Analyst',
        'Base rate -> news update -> fair probability -> thesis');

INSERT INTO strategy_versions (strategy_id, version, prompt_ref, params)
VALUES ('poly-calibrated-analyst', 1, 'poly-synth-prompt',
        '{"triggerThresholdBps": 500, "confidenceFloor": 40}');

-- Same schema, different domain
INSERT INTO strategies (id, domain, name, description)
VALUES ('infra-anomaly-detector', 'infrastructure',
        'Anomaly Detector',
        'Baseline -> deviation -> root cause -> severity');
```

If a domain truly needs domain-specific columns, it adds a **companion table** (e.g., `poly_market_categories` for prediction market category taxonomy). But the core knowledge schema stays generic.

---

## Knowledge Schema

Postgres-native types, snake_case columns, Drizzle conventions. Doltgres is Postgres-compatible, so these work unchanged.

### `knowledge` — domain-specific facts and claims

Curated domain knowledge that agents reference during reasoning.

| Column           | Type        | Constraints           | Description                                                     |
| ---------------- | ----------- | --------------------- | --------------------------------------------------------------- |
| `id`             | text        | PK                    | Deterministic or human-readable                                 |
| `domain`         | text        | NOT NULL              | `prediction-market`, `reservations`, `infrastructure`, etc.     |
| `entity_id`      | text        |                       | Stable subject key (optional — not all knowledge has a subject) |
| `title`          | text        | NOT NULL              | Human-readable summary                                          |
| `content`        | text        | NOT NULL              | The knowledge claim or fact                                     |
| `confidence_pct` | integer     |                       | 0–100 (null if not applicable)                                  |
| `source_type`    | text        | NOT NULL              | `human`, `analysis_signal`, `external`, `derived`               |
| `source_ref`     | text        |                       | Pointer to origin (signal ID, URL, paper, etc.)                 |
| `tags`           | jsonb       |                       | Searchable tags                                                 |
| `created_at`     | timestamptz | NOT NULL, default now |                                                                 |

Examples:

- `{ domain: "prediction-market", title: "Fed rate cut base rate", content: "Historical frequency of Fed rate cuts in election years is ~35%", source_type: "external", source_ref: "https://..." }`
- `{ domain: "reservations", title: "Le Bernardin cancellation pattern", content: "Cancellations spike 24h before for Tuesday-Thursday prime slots", source_type: "derived" }`

---

## Port Interface

> **Canonical surface.** This is the source of truth for `KnowledgeStorePort`. Cross-cutting specs ([knowledge-domain-registry](./knowledge-domain-registry.md), [knowledge-syntropy](./knowledge-syntropy.md)) cross-reference this section and contribute methods; they never redefine the interface.

```typescript
interface KnowledgeStorePort {
  // Read — rows
  getKnowledge(id: string): Promise<Knowledge | null>;
  listKnowledge(
    domain: string,
    opts?: { tags?: string[]; limit?: number }
  ): Promise<Knowledge[]>;
  searchKnowledge(
    domain: string,
    query: string,
    opts?: { limit?: number }
  ): Promise<Knowledge[]>;
  knowledgeExists(id: string): Promise<boolean>; // shared FK check (knowledge-syntropy)

  // Read — domains
  listDomains(): Promise<string[]>; // distinct domain values from knowledge rows
  listDomainsFull(): Promise<Domain[]>; // domains table + entry_count (knowledge-domain-registry)
  domainExists(id: string): Promise<boolean>; // FK gate (knowledge-domain-registry)

  // Write — rows
  addKnowledge(entry: NewKnowledge): Promise<Knowledge>; // insert-only
  upsertKnowledge(entry: NewKnowledge): Promise<Knowledge>; // insert-or-update by id
  updateKnowledge(
    id: string,
    update: Partial<NewKnowledge>
  ): Promise<Knowledge>;
  deleteKnowledge(id: string): Promise<void>; // admin/cleanup only; agents use DEPRECATE_NOT_DELETE

  // Write — edges (knowledge-syntropy)
  addCitation(edge: NewCitation): Promise<Citation>;

  // Write — domains (knowledge-domain-registry)
  registerDomain(input: NewDomain): Promise<Domain>;

  // Doltgres versioning
  commit(message: string): Promise<string>; // returns commit hash
  log(limit?: number): Promise<DoltCommit[]>;
  diff(fromRef: string, toRef: string): Promise<DoltDiffEntry[]>;
  currentCommit(): Promise<string>;
}
```

Adapter: `DoltgresKnowledgeStoreAdapter` (`packages/knowledge-store/src/adapters/doltgres/index.ts`). Scoped to one node's knowledge database. Adapter-layer invariants — `DOMAIN_FK_ENFORCED_AT_WRITE`, `CITATION_TARGET_EXISTS_AT_WRITE`, `HYPOTHESIS_HAS_EVALUATE_AT`, `RAW_WRITE_REJECTS_TYPES` — fire inside `addKnowledge` / `addCitation` before INSERT.

Causal/evaluative concerns (resolver, confidence recompute) live on a separate `EdoResolverPort` defined in [knowledge-syntropy § Computation Surface](./knowledge-syntropy.md#computation-surface).

---

## Agent Access

Agents access knowledge through the tool catalog, not raw database connections.

### Tool Catalog

Three tools in `@cogni/ai-tools`, registered in `TOOL_CATALOG`:

| Tool                     | Effect       | Description                        |
| ------------------------ | ------------ | ---------------------------------- |
| `core__knowledge_search` | read_only    | Text search by domain + query      |
| `core__knowledge_read`   | read_only    | Get by ID or list by domain + tags |
| `core__knowledge_write`  | state_change | Add entry + auto-commit            |

### Capability Wiring

```
packages/knowledge-store/           ← KnowledgeStorePort + adapter + createKnowledgeCapability()
packages/ai-tools/                  ← KnowledgeCapability interface + tool contracts
nodes/{node}/app/src/bootstrap/     ← env vars → client → adapter → capability → tool bindings
```

`createKnowledgeCapability(port)` lives in `packages/knowledge-store/` (pure function, shared across all nodes). It wraps `KnowledgeStorePort` as a `KnowledgeCapability` with auto-commit on every write. Per-node bootstrap creates the Doltgres client from env vars and passes the port.

### Confidence Defaults

| Level    | Score | When                                                               |
| -------- | ----- | ------------------------------------------------------------------ |
| Draft    | 30%   | Default for all new agent writes                                   |
| Verified | 80%   | Human-reviewed or agent-confirmed with fresh sources               |
| Hardened | 95%   | Outcome-validated, statistically significant, repeatedly confirmed |

### Agent Recall Protocol

Agents search knowledge BEFORE web search. The recall loop:

1. `core__knowledge_search(domain, query)` — check existing knowledge
2. Found + high confidence? → Use it, cite the entry ID
3. Found but stale/low confidence? → Re-research, update via `core__knowledge_write`
4. Not found? → `core__web_search`, then `core__knowledge_write` to save findings

---

## Promotion Gate: Awareness → Knowledge

Not every signal becomes knowledge. The promotion gate decides what crosses the boundary:

```
Awareness (Postgres)                    Knowledge (Postgres v0 / Dolt v1)
────────────────────                    ─────────────────────────────────

analysis_signal ──→ [promotion criteria] ──→ knowledge_claims
                                             evidence_refs

analysis_outcomes ─→ [calibration eval] ──→ strategy_evaluations

repeated pattern ──→ [codification] ────→ playbooks

prompt iteration ──→ [validated A/B] ───→ prompt_versions
```

### Promotion Criteria

An awareness artifact becomes knowledge when at least one holds:

| Criterion                     | Example                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| **Outcome-validated**         | Signal predicted correctly against resolved market               |
| **Statistically significant** | Strategy version outperforms baseline in N>30 evals              |
| **Human-reviewed**            | Operator marks a signal as high-quality insight                  |
| **Repeated pattern**          | Same trigger+analysis pattern fires >3 times with similar result |

### What does NOT get promoted

- Individual observations (raw data stays in awareness)
- Failed analysis runs (operational artifact, not knowledge)
- Low-confidence signals that weren't validated
- One-off alerts that didn't recur

---

## Knowledge Classes

All knowledge belongs to exactly one class. The class determines visibility, ownership, and how it moves between layers.

| Class             | Visibility       | Owner    | Mutability                  | Example                                                      |
| ----------------- | ---------------- | -------- | --------------------------- | ------------------------------------------------------------ |
| **Public/shared** | All nodes        | Operator | Operator writes, nodes read | Base strategies, reference prompts, evidence library         |
| **Node-private**  | Owning node only | Node     | Node writes freely          | Tuned prompts, local evaluations, domain-specific strategies |
| **Experimental**  | Owning node only | Node     | Branch, discard freely      | Prompt A/B tests, threshold experiments                      |

Knowledge moves **upward** by explicit promotion only:

```
experimental ──→ node-private    (node merges validated experiment)
node-private ──→ public/shared   (operator reviews + accepts node contribution)
```

Knowledge moves **downward** by explicit pull only:

```
public/shared ──→ node-private   (node pulls operator update into local store)
```

**No default visibility across nodes.** Monorepo code sharing does not imply knowledge sharing. A node's tuned prompts and evaluations are private unless explicitly promoted.

---

## Per-Node Knowledge Distribution

Each Cogni node has its own agent graphs package (domain logic) and its own knowledge store (domain expertise). The operator maintains base knowledge that new nodes inherit. This section designs how knowledge flows between operator and nodes across the lifecycle.

### Three-Layer Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  OPERATOR BASE KNOWLEDGE                                     │
│  Curated strategies, reference prompts, evidence library     │
│  Published as: @cogni/knowledge-seeds or Doltgres remote    │
│  Class: public/shared                                        │
└──────────────────────────┬───────────────────────────────────┘
                           │ seed / pull (node decides when)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  NODE-LOCAL SOVEREIGN KNOWLEDGE (per-node, isolated)         │
│  Own Doltgres database (knowledge_{node_name})              │
│  Base (seeded from operator) + private tuned knowledge      │
│  Class: node-private (+ merged public/shared)                │
└──────────────────────────┬───────────────────────────────────┘
                           │ KnowledgeStorePort
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  GRAPH LAYER (per-node agent graphs)                         │
│  packages/langgraph-graphs/ reads from KnowledgeStorePort    │
│  Doesn't know or care about distribution mechanism           │
└──────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
                    │  OPTIONAL: PUBLISHED COMMONS          │
                    │  Shared Dolt remote or DoltHub repo  │
                    │  Nodes explicitly promote into this  │
                    │  Class: public/shared                │
                    └──────────────────────────────────────┘
```

**Key separation:** The agent graphs package is **code** (the logic). The knowledge store is **data** (the expertise). The awareness plane is **operational data** (what's happening now). A node's graphs read strategies and prompts from its local knowledge store — they never import them as code constants.

### Shared Doltgres Server, Per-Node Databases

One Doltgres server process. Each node gets its own database. Same pattern as Postgres (one server, `CREATE DATABASE` per node).

```
┌─────────────────────────────────────────────────────────┐
│ Shared Doltgres Server                                   │
│                                                         │
│  knowledge_operator    ← operator's sovereign store      │
│                                                         │
│  knowledge_poly        ← poly node's sovereign store     │
│                                                         │
│  knowledge_resy        ← resy node's sovereign store     │
└─────────────────────────────────────────────────────────┘
```

**Why per-node databases?**

- **DATA_SOVEREIGNTY** — a node's database is its own. Isolation is structural, not policy.
- **KNOWLEDGE_SOVEREIGN_BY_DEFAULT** — no default visibility across nodes.
- **Self-hosted exit** — node takes its Doltgres database as a standalone repo with full commit history.

### Node Provision Flow

1. Node's Postgres database created (awareness plane — existing step)
2. Doltgres knowledge database created by compose `doltgres-provision` service: `CREATE DATABASE knowledge_{node_name}` (+ reader/writer roles, vestigial until Doltgres RBAC works)
3. Schema applied by the node's drizzle-kit migrator as a k8s PreSync Job (see `infra/k8s/base/poly-doltgres/`); the Job also runs `stamp-commit.mjs` after `drizzle-kit migrate` to capture the DDL in `dolt_log`
4. Node boots empty (NODES_BOOT_EMPTY); no operator seed
5. `KnowledgeStorePort` adapter connects to `knowledge_{node_name}` via `DOLTGRES_URL_<NODE>` (superuser, per RUNTIME_URL_IS_SUPERUSER)

### Node Customization

- Agents accumulate knowledge via `core__knowledge_write` (see Agent Access). Every write auto-commits via the capability layer
- Custom entries have `domain` matching the node's domain
- All node-written knowledge is **node-private** by default

### Pinning Analysis to Knowledge State

```sql
SELECT hashof('HEAD') as knowledge_commit;
-- Store in analysis_runs.knowledge_commit for reproducibility
```

Given same observations + same knowledge commit → same analysis outputs.

---

## Invariants

| Rule                            | Constraint                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWARENESS_HOT_KNOWLEDGE_COLD    | Live operational data stays in Postgres. Curated expertise lives in Doltgres.                                                                                                                                                                                                                                                                                                                            |
| KNOWLEDGE_SOVEREIGN_BY_DEFAULT  | Node knowledge is local and private by default. Cross-node sharing is explicit promotion, never default visibility. Monorepo code sharing does not imply knowledge sharing.                                                                                                                                                                                                                              |
| DOLTGRES_PER_NODE_DATABASE      | Each node gets its own Doltgres database (`knowledge_{node_name}`). Per-node databases, not shared tables or branch-per-node.                                                                                                                                                                                                                                                                            |
| PROMOTE_NOT_MIRROR              | Knowledge is promoted from awareness via explicit gate. Only reviewed, repeated, or outcome-backed artifacts cross the boundary.                                                                                                                                                                                                                                                                         |
| PORT_BEFORE_BACKEND             | All knowledge access goes through `KnowledgeStorePort`. Consumers use standard Drizzle queries.                                                                                                                                                                                                                                                                                                          |
| SCHEMA_GENERIC_CONTENT_SPECIFIC | Domain specificity lives in row content (`domain`, `tags`), not table structure. Companion tables are added only for genuinely new entities.                                                                                                                                                                                                                                                             |
| KNOWLEDGE_VERSION_PINNED        | Analysis runs record `knowledge_commit` (Doltgres commit hash). Same inputs + same knowledge → same outputs.                                                                                                                                                                                                                                                                                             |
| FORK_TAKES_KNOWLEDGE            | When a node self-hosts, it takes its Doltgres database with full commit history.                                                                                                                                                                                                                                                                                                                         |
| SCHEMA_VIA_DRIZZLE_PRESYNC      | Knowledge-plane schema is applied by the node's drizzle-kit migrator as a k8s PreSync Job. `provision.sh` creates databases + roles only; it never issues DDL.                                                                                                                                                                                                                                           |
| AUTO_COMMIT_ON_WRITE            | Every `core__knowledge_write` call commits via the capability layer (`SELECT dolt_commit('-Am', ...)`). The schema migrator also commits post-migration via `stamp-commit.mjs`.                                                                                                                                                                                                                          |
| RUNTIME_URL_IS_SUPERUSER        | `DOLTGRES_URL_<NODE>` runtime secret connects as the `postgres` superuser. Doltgres 0.56 RBAC is non-functional (GRANT silently no-ops); revisit when upstream lands working role access.                                                                                                                                                                                                                |
| NODES_BOOT_EMPTY                | New nodes boot with **empty content** — `knowledge`, `citations`, and `sources` rows are zero. Nodes do not inherit operator-curated knowledge claims. Reference data — the `domains` registry — IS migrator-seeded with the base set per [knowledge-domain-registry](./knowledge-domain-registry.md) § Seeding. The dev-only `scripts/db/seed-doltgres.mts` populates local dev only, never production. |
| MIRROR_PROD_ONLY_WRITER         | DoltHub remote mirror (`cogni-dao/knowledge-<node>`) is written by the production operator only. Test/preview have no `DOLTHUB_REMOTE_URL` configured, so `pushMainOnMerge` is wired to `undefined` and merges only land in local Doltgres. No `DEPLOY_ENVIRONMENT` runtime check — gate-by-secret-presence per the established repo pattern (Langfuse, Privy, PostHog).                                 |
| MIRROR_BEST_EFFORT_NO_RETRY     | The post-merge push is fire-and-forget. A failed push is logged (`dolthub_push_failed`) but never retried, never blocks the merge response, and never re-runs on next merge. Recovery for v0 is a manual `dolt_push` from the operator pod. v1+: reconciliation cron diffs `dolt_log` against `origin/main`.                                                                                             |

---

## Non-Goals

- Replacing Postgres for hot operational data (awareness plane stays where it is)
- Cross-node sharing or branching — single branch (`main`) only. The DoltHub mirror (v0, prod → `cogni-dao/knowledge-<node>`) is a one-way publication of `main`, not a federation primitive.
- Operator → node seed on provision — nodes boot empty
- Real-time knowledge updates during analysis (read at start, not mid-flight)
- Automatic promotion without any validation gate (human or statistical)
- Embedding/vector search in knowledge plane (stays in Postgres with pgvector if needed)

### File Pointers

| File                                                            | Purpose                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/knowledge-store/src/port/knowledge-store.port.ts`     | `KnowledgeStorePort` interface                                                                    |
| `packages/knowledge-store/src/adapters/doltgres/`               | `DoltgresKnowledgeStoreAdapter` + `buildDoltgresClient()`                                         |
| `packages/knowledge-store/src/capability.ts`                    | `createKnowledgeCapability()` — wraps port with auto-commit on writes                             |
| `packages/ai-tools/src/tools/knowledge-{read,search,write}.ts`  | Tool contracts + impls (registered in `TOOL_CATALOG`)                                             |
| `nodes/poly/packages/doltgres-schema/`                          | Per-node Doltgres drizzle schema (re-exports base `knowledge`; companion tables here)             |
| `nodes/poly/drizzle.doltgres.config.ts`                         | drizzle-kit config for poly's Doltgres plane (dialect-separated from Postgres)                    |
| `nodes/poly/app/src/adapters/server/db/doltgres-migrations/`    | Checked-in drizzle-kit output                                                                     |
| `nodes/poly/packages/doltgres-schema/stamp-commit.mjs`          | Post-migrate `dolt_commit` hook (per dolthub/dolt#4843 — DDL doesn't auto-commit)                 |
| `infra/k8s/base/poly-doltgres/`                                 | PreSync Job manifest (`migrate-poly-doltgres`)                                                    |
| `infra/compose/runtime/doltgres-init/provision.sh`              | Idempotent database + role provisioning (no DDL)                                                  |
| `infra/compose/runtime/doltgres-init/install-creds.sh`          | Entrypoint wrapper — installs DoltHub keypair at `/root/.dolt/creds/<keyid>.jwk` from env         |
| `packages/knowledge-store/src/adapters/doltgres/dolt-remote.ts` | `createDoltgresPusher` (lazy `dolt_remote add` + `dolt_push`), `wrapPushSafe` (fire-and-forget)   |
| `packages/knowledge-store/src/service/contribution-service.ts`  | `ContributionServiceDeps.pushMainOnMerge` — optional post-merge mirror hook                       |
| `docs/runbooks/dolthub-remote-bootstrap.md`                     | One-time setup: API repo create, `dolt creds new`, pubkey paste, prod-only secret provisioning    |
| `scripts/ci/deploy-infra.sh`                                    | Derives `DOLTGRES_*` from `POSTGRES_ROOT_PASSWORD`, writes `DOLTGRES_URL_<NODE>` into k8s secrets |

## Open Questions

<!-- none -->

## Related

- [Monitoring Engine Spec](./monitoring-engine.md) — awareness plane (Postgres)
- [Architecture](./architecture.md) — hexagonal layering
- [Node vs Operator Contract](./node-operator-contract.md) — fork freedom, data sovereignty, upgrade autonomy
- [Node Launch Spec](./node-launch.md) — `provisionNode` workflow, per-node infrastructure
- [Node Formation Spec](./node-formation.md) — DAO creation, repo-spec output
- spike.0137 (branch) — knowledge store research
- proj.knowledge-store (branch) — prior Postgres-based design (refined here)
- [proj.poly-prediction-bot](../../work/projects/proj.poly-prediction-bot.md) — first domain consuming both planes
- task.0233 (cogni-template) — node-template extraction design
