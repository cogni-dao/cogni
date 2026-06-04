---
id: knowledge-syntropy
type: spec
title: "Knowledge Syntropy — Storage, Retrieval, and Compounding Protocol for Dolt-Backed Node Knowledge"
status: draft
spec_state: draft
trust: draft
summary: "Defines how AI agents store, retrieve, cite, and compound knowledge in Dolt tables. Two agent roles — storage expert (writes structured entries with provenance) and librarian (reads with citations and confidence). Dolt is source of truth; Postgres is a derived search index for embeddings. Knowledge compounds through citation DAGs, computed confidence, and promotion lifecycles."
read_when: Building knowledge storage or retrieval agents, designing seed tables for a new node, adding a new knowledge domain, implementing the librarian or storage expert, or planning x402 knowledge access.
implements:
owner: derekg1729
created: 2026-04-02
verified: 2026-05-11
tags:
  [
    knowledge,
    dolt,
    retrieval,
    citations,
    syntropy,
    storage,
    librarian,
    x402,
    edo,
    hypothesis,
  ]
---

# Knowledge Syntropy — Storage, Retrieval, and Compounding Protocol

> Syntropy: the tendency toward increasing order and accumulation. The opposite of entropy.
> Knowledge that cites, validates, and builds on itself grows stronger over time.

### Key References

|                       |                                                                                                |                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Infrastructure**    | [knowledge-data-plane](./knowledge-data-plane.md)                                              | Doltgres server, per-node DBs, port shape          |
| **Awareness Plane**   | [monitoring-engine](./monitoring-engine.md)                                                    | What flows INTO knowledge via promotion gate       |
| **Brain / Citations** | [cogni-brain](./cogni-brain.md)                                                                | Citation guard, tool usage patterns                |
| **Repo Citations**    | [packages/ai-tools/src/capabilities/repo.ts](../../packages/ai-tools/src/capabilities/repo.ts) | Citation token format to mirror                    |
| **Node Sovereignty**  | [node-operator-contract](./node-operator-contract.md)                                          | DATA_SOVEREIGNTY, FORK_FREEDOM                     |
| **x402**              | [x402-e2e](./x402-e2e.md)                                                                      | Future: external agents pay for retrieval          |
| **Prior Research**    | [spike.0137](../../work/items/spike.0137.oss-node-research-spike.md)                           | Three-layer knowledge architecture                 |
| **Karpathy Pattern**  | [research](../research/ai-knowledge-storage-indexing-retrieval.md)                             | LLM Knowledge Bases — compile/query/file-back/lint |

## Design

### Architecture: Dolt Is Source of Truth

```
                    CONSTANT INFLOW
                    ┌─────────────────────────────────────┐
                    │ Research agents, data streams,       │
                    │ analysis signals, external crawling  │
                    └──────────────┬──────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────────────┐
                    │         STORAGE EXPERT               │
                    │  Structures, validates, cites,       │
                    │  decides table placement,            │
                    │  writes to Dolt + commits            │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │           DOLTGRES                    │
                    │  Source of truth for all knowledge    │
                    │  Versioned (commit/log/diff)          │
                    │  Forkable, auditable, sovereign       │
                    │                                      │
                    │  Seed tables:                         │
                    │    knowledge        (claims + facts)  │
                    │    citations        (DAG edges)       │
                    │    domains          (registered)      │
                    │    sources          (external refs)   │
                    └──────────────┬──────────────────────┘
                                   │
                            Sync (one-way)
                                   │
                    ┌──────────────▼──────────────────────┐
                    │      POSTGRES (search index)         │
                    │  Derived, rebuildable from Dolt      │
                    │                                      │
                    │  knowledge_search   (embeddings)     │
                    │  knowledge_fts      (tsvector)       │
                    └──────────────┬──────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────────────┐
                    │          LIBRARIAN                    │
                    │  Hybrid search (FTS + vector)         │
                    │  Citation tokens in results           │
                    │  Confidence-weighted ranking          │
                    │  x402-gated for external agents       │
                    └─────────────────────────────────────┘
```

**Key distinction from knowledge-data-plane spec:** That spec puts `knowledge` in Dolt and mentions Postgres only for awareness. This spec adds a **derived search index** in Postgres specifically for retrieval performance (embeddings, full-text). The Dolt tables are authoritative; the Postgres index is a read-optimized projection that can be rebuilt from Dolt at any time.

## Goal

Define the protocol by which Cogni nodes accumulate domain expertise that compounds over time. This spec answers:

1. **What tables ship with every node?** (seed schema)
2. **How does the storage expert decide what to store and how?** (write protocol)
3. **How does the librarian search and cite knowledge?** (read protocol)
4. **How does knowledge compound instead of rot?** (syntropy principles)
5. **How does constant inflow from research agents get structured?** (inflow architecture)

The [knowledge-data-plane spec](./knowledge-data-plane.md) defines the Doltgres infrastructure and per-node database layout. This spec defines what happens **inside** those databases.

## Non-Goals

- Replacing Postgres for hot operational data (awareness plane is separate)
- Defining the Doltgres server infrastructure (see knowledge-data-plane spec)
- Implementing vector search inside Doltgres (pgvector requires Postgres)
- Designing the full x402 payment flow (see x402-e2e spec)
- Specifying agent graph architecture (see cogni-brain spec)

---

## Seed Schema: What Ships With Every Node

Every node fork inherits these four tables. They are the minimum viable knowledge infrastructure. Domain specificity lives in row content, not table structure.

### `knowledge` — Claims and facts

The atomic unit of what the node believes. Each row is a single assertion with provenance.

| Column                | Type        | Constraints               | Description                                                                                                                                                                                                                                 |
| --------------------- | ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | text        | PK                        | Human-readable: `{domain}:{slug}` (e.g. `pm:fed-rate-base-rate`)                                                                                                                                                                            |
| `domain`              | text        | NOT NULL, FK→domains      | Registered domain key                                                                                                                                                                                                                       |
| `entity_id`           | text        |                           | Stable subject key (market ID, project slug, etc.)                                                                                                                                                                                          |
| `title`               | text        | NOT NULL                  | One-line claim summary                                                                                                                                                                                                                      |
| `content`             | text        | NOT NULL                  | Full knowledge body — the actual assertion                                                                                                                                                                                                  |
| `entry_type`          | text        | NOT NULL                  | `event`, `hypothesis`, `decision`, `outcome` (see § The EDO Loop) + `observation`, `finding`, `conclusion`, `rule`, `scorecard`, `skill`, `guide`, `html`                                                                                   |
| `status`              | text        | NOT NULL, default `draft` | `draft` → `candidate` → `established` → `canonical` → `deprecated`                                                                                                                                                                          |
| `confidence_pct`      | integer     | NOT NULL, default 40      | 0–100, computed from citations. Default 40 matches `analysis_signal` baseline; agents may write lower (30 for draft) or higher per § Confidence Defaults.                                                                                   |
| `source_type`         | text        | NOT NULL                  | `human`, `agent`, `analysis_signal`, `external`, `derived`                                                                                                                                                                                  |
| `source_ref`          | text        |                           | Pointer to origin (URL, signal ID, commit hash)                                                                                                                                                                                             |
| `source_node`         | text        |                           | Which AI node/agent created this                                                                                                                                                                                                            |
| `evaluate_at`         | timestamptz |                           | When this row should be resolved. REQUIRED for `entry_type='hypothesis'`; null otherwise. Resolver cron reads pending rows (see § The EDO Loop).                                                                                            |
| `resolution_strategy` | text        |                           | Namespaced resolver identifier on hypothesis rows. NULL = no automation (cron skips; row is "manual"). v0 non-null value: `agent`. Future kinds (`market:<id>`, `metric:<query>`, `http:<url>`, `deadline`) add new values, not new schema. |
| `created_at`          | timestamptz | NOT NULL, default now     |                                                                                                                                                                                                                                             |
| `updated_at`          | timestamptz | NOT NULL, default now     |                                                                                                                                                                                                                                             |

### `citations` — The DAG that makes knowledge compound

Every edge is a directed relationship between two knowledge entries. The citation DAG is what separates compounding knowledge from a flat document store.

| Column          | Type        | Constraints            | Description                                                                                                                         |
| --------------- | ----------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | text        | PK                     | `{citing_id}→{cited_id}:{type}`                                                                                                     |
| `citing_id`     | text        | NOT NULL, FK→knowledge | The entry making the citation                                                                                                       |
| `cited_id`      | text        | NOT NULL, FK→knowledge | The entry being cited                                                                                                               |
| `citation_type` | text        | NOT NULL               | `supports`, `contradicts`, `extends`, `supersedes`, `evidence_for`, `derives_from`, `validates`, `invalidates` (see § The EDO Loop) |
| `context`       | text        |                        | Why this citation exists (one sentence)                                                                                             |
| `created_at`    | timestamptz | NOT NULL, default now  |                                                                                                                                     |

**Unique constraint:** `(citing_id, cited_id, citation_type)` — one edge per type per pair.

### `domains` — Registered knowledge domains

Domains are structural, not tags. Every knowledge entry belongs to exactly one domain. New domains are registered explicitly — not created ad-hoc.

| Column        | Type        | Constraints           | Description                                                    |
| ------------- | ----------- | --------------------- | -------------------------------------------------------------- |
| `id`          | text        | PK                    | Short key: `prediction-market`, `infrastructure`, `governance` |
| `name`        | text        | NOT NULL              | Human-readable: "Prediction Markets"                           |
| `description` | text        |                       | What this domain covers                                        |
| `created_at`  | timestamptz | NOT NULL, default now |                                                                |

### `sources` — External reference registry

Tracks external sources that knowledge entries cite. Enables source reliability scoring over time.

| Column          | Type        | Constraints           | Description                                   |
| --------------- | ----------- | --------------------- | --------------------------------------------- |
| `id`            | text        | PK                    | URL-derived or human-readable slug            |
| `url`           | text        |                       | Canonical URL (null for non-web sources)      |
| `name`          | text        | NOT NULL              | Human-readable source name                    |
| `source_type`   | text        | NOT NULL              | `paper`, `api`, `website`, `dataset`, `human` |
| `reliability`   | integer     |                       | 0–100 estimated reliability (null = unknown)  |
| `last_accessed` | timestamptz |                       | When this source was last fetched/verified    |
| `created_at`    | timestamptz | NOT NULL, default now |                                               |

---

## The Storage Expert: Write Protocol

The storage expert is the agent role responsible for structuring and writing knowledge into Dolt. It does not retrieve — that is the librarian's job.

### When Data Arrives

Constant inflow from three channels:

```
1. Research agents     → structured findings (scorecards, tables, assertions)
2. Awareness promotion → outcome-validated signals cross the promotion gate
3. External crawling   → web data, API responses, document ingestion
```

The storage expert processes each inflow item through this protocol:

### Write Protocol Rules

**ENTRY_HAS_PROVENANCE** — Every entry must have `source_type` and `source_ref`. No knowledge without a traceable origin.

**ENTRY_HAS_DOMAIN** — Every entry belongs to exactly one registered domain. If the domain doesn't exist, register it first (new row in `domains` + Dolt commit).

**CITATIONS_ON_DERIVED** — Any entry with `source_type: 'derived'` must create at least one `citations` edge of type `supports` or `extends` pointing to the entries it was derived from.

**CONFIDENCE_INITIALIZED** — New entries start at the confidence level matching their source:

| Source Type       | Initial Confidence | Rationale                                    |
| ----------------- | ------------------ | -------------------------------------------- |
| `agent`           | 30%                | Unvalidated AI output                        |
| `analysis_signal` | 40%                | Promoted from awareness, has some validation |
| `external`        | 50%                | External source, not yet corroborated        |
| `human`           | 70%                | Human-reviewed                               |
| `derived`         | Inherited          | Average of cited entries' confidence         |

**COMMIT_PER_LOGICAL_WRITE** — Each logical write operation (which may touch multiple rows) gets one Dolt commit with a descriptive message. Not one commit per row, not batched across unrelated writes.

```sql
-- Write the entry
INSERT INTO knowledge (id, domain, title, content, ...) VALUES (...);
-- Write the citation
INSERT INTO citations (id, citing_id, cited_id, citation_type, context) VALUES (...);
-- Commit atomically
SELECT dolt_commit('-Am', 'add: fed rate cut base rate from BLS data (conf: 50%)');
```

**DEPRECATE_NOT_DELETE** — Never delete knowledge rows. Superseded entries get `status: 'deprecated'` plus a `citations` edge of type `supersedes` from the new entry. The old entry remains in Dolt history for audit.

**SOURCE_REGISTRATION** — External references should be registered in `sources` table on first use. This enables reliability tracking over time.

**EXTERNAL_WRITES_TO_BRANCH** — Bearer-authenticated agents (external principals) MUST land their writes on a `contrib/<id>` branch, never directly on `main`. Session-cookie users (trusted humans, v0) may write direct to main. This rule applies to **all** external write surfaces:

- `POST /api/v1/knowledge/contributions` — single/multi-row edits via the `ContributionService.create` path.
- `POST /api/v1/edo/{hypothesize,decide,record-outcome}` — atomic EDO multi-row batches via `ContributionService.createEdo{Hypothesis,Decision,Outcome}Contribution`. Bearer → contrib branch (one Dolt commit per atomic batch on the branch); session → direct `EdoCapability.*` against main.

The internal `core__edo_*` langgraph tools are NOT external — they run inside the operator's trust boundary and write direct to main via `EdoCapability`. The rule gates the HTTP perimeter only.

### When to Create New Tables

The four seed tables cover most knowledge needs. Domains don't get their own tables — they get their own rows with `domain` scoping. New tables are warranted only when:

1. **The data has a fundamentally different shape** — not just different content. If it fits in `knowledge` with `entry_type` differentiation, it goes there.
2. **The data has relationships that don't map to the citation DAG** — e.g., `strategies` have `strategy_versions` which have `strategy_evaluations`. This is a different entity lifecycle, not a knowledge claim.
3. **Query patterns require dedicated indexes** — e.g., time-series data with range scans doesn't belong in a flat knowledge table.

**Rule of thumb:** If you're tempted to create a new table, first try adding an `entry_type` to `knowledge`. If the entry_type needs more than 3 columns that other entry_types don't have, it's probably a new table.

New tables require a Dolt commit with message format: `schema: add {table_name} table — {one-line reason}`.

---

## The Librarian: Read Protocol

The librarian is the agent role responsible for retrieving knowledge with citations. It does not write — that is the storage expert's job.

### Search Strategy

The librarian searches in order of speed, escalating only when needed:

```
1. Dolt direct query    → WHERE domain = $d AND LOWER(title) LIKE LOWER('%query%')
                           Fast, no extensions needed. Sufficient at < 10K rows.

2. Postgres FTS index   → tsvector @@ plainto_tsquery($query)
                           When Dolt text search is insufficient.

3. Postgres vector      → embedding <=> $query_embedding ORDER BY distance
                           When semantic similarity matters.

4. Hybrid RRF fusion    → combine FTS + vector ranks via reciprocal rank fusion
                           When precision matters. 70/30 BM25/vector default weighting.
```

At node launch with < 1K entries, step 1 is sufficient. Steps 2–4 activate when the Postgres search index is populated.

### Citation Token Format

Mirroring the `repo:` citation token pattern from [cogni-brain](./cogni-brain.md):

```
knowledge:{node}:{entry-id}#conf={confidence}&v={dolt-commit-7}
```

Examples:

```
knowledge:poly:pm:fed-rate-base-rate#conf=72&v=abc1234
knowledge:operator:infra:k3s-memory-baseline#conf=85&v=def5678
```

**Components:**

- `knowledge:` — prefix (distinguishes from `repo:` tokens)
- `{node}` — which node's knowledge store (`poly`, `operator`, etc.)
- `{entry-id}` — the `knowledge.id` value
- `conf=` — current `confidence_pct` at time of retrieval
- `v=` — first 7 chars of the Dolt commit hash when this entry was last modified

### Citation Token Regex

```typescript
const KNOWLEDGE_CITATION_REGEX =
  /\bknowledge:[a-z0-9_-]+:[a-z0-9_:-]+#conf=\d+&v=[0-9a-f]{7}\b/g;
```

### Retrieval Output Contract

When the librarian returns results, each entry includes:

```typescript
interface KnowledgeSearchHit {
  id: string; // knowledge.id
  title: string; // knowledge.title
  content: string; // knowledge.content (or summary for large entries)
  domain: string; // knowledge.domain
  confidence_pct: number | null; // knowledge.confidence_pct
  status: string; // knowledge.status
  citation: string; // knowledge citation token
  source_refs: string[]; // top 1-3 source URLs from source_ref + sources table
  cited_by_count: number; // count of citations where cited_id = this entry
  dolt_commit: string; // 7-char commit hash
}
```

### Retrieval Rules

**SEARCH_BEFORE_INTERNET** — Agents must search node knowledge via the librarian before falling back to web search. This is the recall loop from [cogni-brain](./cogni-brain.md).

**CONFIDENCE_WEIGHTED_RANKING** — Higher-confidence entries rank above lower-confidence entries at equal relevance scores. Deprecated entries are excluded by default.

**CITATIONS_IN_RESPONSE** — Every knowledge claim in an agent's response must include the citation token. The citation guard (per cogni-brain spec) validates these.

**SOURCE_REFS_INCLUDED** — Retrieval results include the top source URLs so agents can provide human-verifiable references alongside knowledge citations.

---

## Syntropy Principles: How Knowledge Compounds

Syntropy is not automatic. It requires active maintenance. These principles define the mechanisms by which knowledge grows stronger over time instead of decaying.

### 1. Confidence Is Computed, Not Assigned

After initialization, confidence is recomputed by the storage expert whenever citations change. The formula is application-level (Doltgres has no PL/pgSQL triggers):

```
confidence = initial_confidence
           + (10 * supporting_citations, capped at +50)
           - (15 * contradicting_citations)
           + (10 if updated in last 7 days, else 0)
           - (10 if no citations added in 90 days)
           clamped to [0, 100]
```

This runs in the adapter, not as a database trigger. The storage expert calls `recomputeConfidence(entryId)` after writing citations.

### 2. Promotion Lifecycle

```
draft (< 30%)       → Single-source observation. Unvalidated.
candidate (30–60%)  → Has citations. At least one corroborating source.
established (60–80%) → Multiple corroborating sources. No unresolved contradictions.
canonical (> 80%)   → Outcome-validated or human-verified. High citation count.
deprecated          → Superseded by newer knowledge. Status set explicitly.
```

Promotion is triggered by the storage expert when confidence crosses a threshold AND one of:

- Outcome validation (awareness signal resolved correctly)
- Human review
- Statistical significance (N>30 corroborating observations)

Promotion is not automatic on confidence alone — it requires evidence.

### 3. Staleness Decay

Knowledge that is not cited, updated, or validated decays:

| Age Without Activity | Confidence Adjustment |
| -------------------- | --------------------- |
| 0–30 days            | No change             |
| 31–90 days           | -5 per 30-day period  |
| 90+ days             | -10 per 30-day period |
| 180+ days            | Flagged for review    |

The storage expert runs staleness checks periodically (cron or manual). Stale entries are not automatically deprecated — they are flagged and their confidence is reduced.

### 4. Contradiction Resolution

When a new entry has a `contradicts` citation to an existing entry:

1. Both entries get flagged for review
2. The contradicted entry's confidence is penalized (-15 per contradiction)
3. Neither is automatically deprecated — contradictions require human or outcome-based resolution
4. Resolved contradictions result in one entry being `deprecated` with a `supersedes` edge

### 5. Filing Back: The Compounding Flywheel

Every agent query that produces a useful finding should be filed back into knowledge. This is the Karpathy insight: "my explorations always add up in the knowledge base."

```
Agent asks question
  → Librarian searches knowledge
  → Agent combines knowledge with web research
  → Agent produces finding/report
  → Storage expert extracts knowledge claims from output
  → Storage expert writes to Dolt with citations to sources used
  → New entries are searchable for future queries
  → Cycle repeats
```

This is the core loop. Without it, queries are ephemeral and knowledge doesn't compound.

---

## Inflow Architecture: Handling Constant Data Streams

### Channel 1: Research Agent Outputs

```
/research produces findings
  → Storage expert parses structured claims from output
  → Each claim becomes a knowledge entry with:
      source_type: 'agent'
      source_ref: 'research:{spike-id}' or commit hash
      confidence_pct: 30% (initial agent confidence)
  → Citations created to any existing knowledge referenced
  → Dolt commit: 'ingest: {N} findings from research {id}'
```

### Channel 2: Awareness Promotion

```
analysis_signal with outcome validation (from monitoring-engine)
  → Promotion gate checks criteria (outcome-validated, repeated, etc.)
  → Storage expert creates knowledge entry with:
      source_type: 'analysis_signal'
      source_ref: 'signal:{signal_id}'
      confidence_pct: 40% (promoted signal baseline)
  → Citation to the analysis_signal record
  → Dolt commit: 'promote: signal {id} → knowledge (outcome-validated)'
```

### Channel 3: External Crawling

```
Web crawler / API poller produces raw data
  → Storage expert registers source in sources table (if new)
  → Storage expert extracts structured claims
  → Each claim becomes knowledge entry with:
      source_type: 'external'
      source_ref: source URL
      confidence_pct: 50% (external source baseline)
  → Dolt commit: 'ingest: {N} claims from {source_name}'
```

### Inflow Rate Expectations

| Node Maturity | Entries/Day | Commits/Day | Domains |
| ------------- | ----------- | ----------- | ------- |
| Week 1        | 10–50       | 5–15        | 1–2     |
| Month 1       | 50–200      | 20–50       | 2–5     |
| Month 6       | 200–1000    | 50–100      | 5–10    |
| Year 1        | 1000–5000   | 100–200     | 10+     |

At these scales, Dolt direct queries remain fast (< 10ms for indexed lookups). The Postgres search index becomes important around 1K+ entries for full-text and semantic search.

---

## The Hypothesis Loop — Event → Hypothesis → Decision → Outcome

> **Agent contract:** see [`.claude/skills/edo-loop/SKILL.md`](../../.claude/skills/edo-loop/SKILL.md) for the recipe agents follow when filing a chain (action hierarchy, the three gates, refine-vs-create, PR linkage, confidence reading).

> Knowledge that doesn't predict, decide, and resolve is just a filing cabinet. The hypothesis loop turns the knowledge plane into a self-evaluating reasoning system. It is the foundation for self-improving agentic loops: agents form falsifiable predictions, act, observe, and update.
>
> **Codename `EDO`.** The project + tool prefix (`proj.edo-foundation`, `core__edo_*`) is shorthand. The accurate beat count is four — Hypothesis is the falsifiability bridge between Event and Decision and is structurally required, not optional.

### The Four Beats

Every closing-the-loop interaction is a sequence of four `knowledge` rows linked by citations:

| Beat           | `entry_type` | What it captures                                                                            | Required citations                                            |
| -------------- | ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Event**      | `event`      | A signal-bearing thing that happened — market move, log line, user action, scheduled tick   | none (or `extends` into existing knowledge)                   |
| **Hypothesis** | `hypothesis` | A falsifiable prediction with a resolution date. MUST set `evaluate_at`.                    | ≥1 `evidence_for` from events                                 |
| **Decision**   | `decision`   | The action taken (or explicitly not taken) on the basis of the hypothesis                   | ≥1 `derives_from` to a hypothesis                             |
| **Outcome**    | `outcome`    | What actually happened by `evaluate_at` — fills in the truth value, may also record a delta | ≥1 `validates` OR `invalidates` to the hypothesis it resolved |

These four are `entry_type` values on the existing `knowledge` table. **No new tables.** The structure is the citation DAG.

### Recursion via the Citation DAG

EDO trees are emergent, not materialized. An `outcome` row is just a knowledge entry; the next `hypothesis` cites it via `evidence_for`. Tree depth = causal depth.

```
Outcome A ───────evidence_for───────▶ Hypothesis B ──derives_from──▶ Decision B
                                            │                              │
                                       evaluate_at                          │
                                            ▼                               ▼
                                       Outcome B ◀────validates/invalidates─┘
                                            │
                                            └──── evidence_for ────▶ Hypothesis C ...
```

To walk an EDO chain: follow `citations` edges from any node. No `parent_id`, no `chain_id`, no recursive CTE schema. The fractal/recursive nature is the property of the relation table, not a separate structure to maintain.

### Four New Citation Types

| Type           | Direction                        | Use                                        |
| -------------- | -------------------------------- | ------------------------------------------ |
| `evidence_for` | event → hypothesis (or decision) | "this event motivates this prediction"     |
| `derives_from` | decision → hypothesis            | "this action follows from this prediction" |
| `validates`    | outcome → hypothesis             | "the prediction held"                      |
| `invalidates`  | outcome → hypothesis             | "the prediction failed"                    |

Existing types (`supports`, `contradicts`, `extends`, `supersedes`) remain for non-temporal knowledge (claims, rules, scorecards). The two groups are orthogonal — a `finding` row uses the original four; a `hypothesis` row uses the EDO four.

### `evaluate_at`: The Loop Closer

`hypothesis` rows MUST set `evaluate_at` (timestamptz). It is the appointment with truth. Orphan hypotheses are surfaced by `pendingResolutions(now)` — they cannot rot silently.

**Resolution strategy in v0: opt-in via `resolution_strategy` column.** Hypothesis writes set this namespaced text column to declare how the row should be resolved:

| `resolution_strategy` | Resolver behavior                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NULL` (default)      | Cron skips the row. No automation policy set. Row is available for explicit `core__edo_record_outcome` calls by operator scripts or, when the manual-inbox surface lands, by humans through `/knowledge`. |
| `agent`               | Cron hands off to a single resolver graph that gathers evidence and files the outcome via `core__edo_record_outcome`.                                                                                     |

**Why a column, not a `tags` key:** the shipped `tags` field is `jsonb` typed as `string[]` (an array, not an object), and Doltgres 0.56 has known limitations on JSONB `@>` / `->>` operators (see the data-plane spec's "Surface today"). A dedicated text column is indexable (`CREATE INDEX ... WHERE resolution_strategy IS NOT NULL`), queryable with `=` or `LIKE 'agent%'`, and the NULL default is semantically clean — absence of a policy means "no automation".

**Why namespaced text, not an enum:** v0 ships with one allowed value (`agent`). Future resolver kinds (`market:0x123abc`, `metric:rate(...)`, `http://...`, `deadline`) are new values, never new columns. Validation of allowed values lives in the Zod schema of `core__edo_hypothesize`, not in a DB CHECK constraint — so adding a resolver kind is a code-change, not a schema migration.

LLM cost is bounded by default: NULL is free, only `agent` opts into the resolver graph.

Either resolution path lands the outcome row + `validates`/`invalidates` citation on `main` with a Dolt commit, and triggers `recomputeConfidence` on the cited hypothesis.

### Enforcement Points

Invariants live at the adapter layer — the universal choke point — mirroring `DOMAIN_FK_ENFORCED_AT_WRITE` from [knowledge-domain-registry](./knowledge-domain-registry.md). Tools and capabilities are convenience wrappers; the adapter is law.

| Invariant                            | Adapter check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYPOTHESIS_HAS_EVALUATE_AT`         | `addKnowledge` / `upsertKnowledge` rejects rows where `entry_type='hypothesis'` and `evaluate_at` is null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CITATION_TARGET_EXISTS_AT_WRITE`    | `addCitation` rejects rows whose `cited_id` is not present in `knowledge` (port adds `knowledgeExists(id)` for the check)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE` | `addCitation` verifies the cited row's `entry_type` against the citation_type: `derives_from`, `validates`, `invalidates` require `cited.entry_type='hypothesis'`. `evidence_for` accepts any cited entry_type (events, observations, findings can all be evidence). Without this check the falsifiability gates below are bypassable. **Adapter implementation collapses this with `CITATION_TARGET_EXISTS_AT_WRITE` into a single roundtrip: `SELECT entry_type FROM knowledge WHERE id = $1` — `null` ⇒ not exists (404); value ⇒ check against citation_type contract. No double-fetch.** |
| `OUTCOME_CITES_HYPOTHESIS`           | `addKnowledge` for `entry_type='outcome'` requires the atomic `core__edo_record_outcome` path (raw write rejects)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DECISION_CITES_HYPOTHESIS`          | `addKnowledge` for `entry_type='decision'` requires the atomic `core__edo_decide` path (raw write rejects)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Fail-closed enumeration.** Define `RAW_WRITE_REJECTS_TYPES = {hypothesis, decision, outcome}`. The `core__knowledge_write` tool rejects rows whose `entry_type ∈ RAW_WRITE_REJECTS_TYPES` with a typed error mapped to HTTP 400. `entry_type='event'` is NOT in the set — events flow through `core__knowledge_write` unchanged. Adding a future EDO-like entry_type is a deliberate two-step: define the type AND add it to the set. Categorical wording ("EDO types") is rejected — it fails open on additions.

### Computation Surface

A new port — separate from `KnowledgeStorePort` (CRUD) — owns causal/evaluative logic:

```typescript
interface EdoResolverPort {
  scheduleResolution(hypothesisId: string, evaluateAt: Date): Promise<void>;
  pendingResolutions(now: Date, limit?: number): Promise<Knowledge[]>;
  resolveHypothesis(
    hypothesisId: string,
    outcome: NewKnowledge,
    edge: "validates" | "invalidates"
  ): Promise<{ outcome: Knowledge; resolvedConfidence: number }>;
  recomputeConfidence(entryId: string, depth?: 1): Promise<number>;
}
```

`recomputeConfidence` walks `citations` one hop in v1 and applies the formula from § "Confidence Is Computed, Not Assigned". Multi-hop transitive propagation is filed when v1 data shows the need — premature optimization otherwise.

### Port Surface Additions

The canonical `KnowledgeStorePort` shape lives in [knowledge-data-plane.md § Port Interface](./knowledge-data-plane.md#port-interface) — never redefined here. This spec contributes these methods:

| Method on `KnowledgeStorePort`                      | Why                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `addCitation(edge: NewCitation): Promise<Citation>` | Citation writes have no existing port surface. Required by `OUTCOME_CITES_HYPOTHESIS` etc.     |
| `knowledgeExists(id: string): Promise<boolean>`     | Shared check for `CITATION_TARGET_EXISTS_AT_WRITE`. Mirrors `domainExists` from registry spec. |

`EdoResolverPort` (above) lives separately — causal/evaluative concerns are not CRUD.

### Atomic Agent Tools

Three new tools in `@cogni/ai-tools`, each composes a knowledge write + citation write(s) + commit in one capability call. Agents call these instead of `core__knowledge_write` when the entry is part of a loop.

| Tool                       | Effect       | Writes                                                                                                        |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `core__edo_hypothesize`    | state_change | `hypothesis` row + N `evidence_for` citations + `evaluate_at` set                                             |
| `core__edo_decide`         | state_change | `decision` row + 1 `derives_from` citation                                                                    |
| `core__edo_record_outcome` | state_change | `outcome` row + 1 `validates`/`invalidates` citation + triggers `recomputeConfidence` on the cited hypothesis |

Existing `core__knowledge_write` remains for non-EDO knowledge (rules, guides, scorecards). The two surfaces are deliberately type-narrow — type-narrow tools beat polymorphic ones for model accuracy.

### Why No New Tables

| Tempting alternative                                      | Why rejected                                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hypotheses`, `decisions`, `outcomes` tables with FK cols | Violates `SCHEMA_GENERIC_CONTENT_SPECIFIC`. The four beats are content roles, not entity types. Locks out future entry_types that don't fit the pattern. |
| `edo_chains` materialized parent table                    | The chain IS the citation DAG. Materializing is double-bookkeeping that drifts.                                                                          |
| DB triggers for confidence recompute                      | Doltgres 0.56 has no PL/pgSQL. App-layer only, per `CONFIDENCE_APPLICATION_LEVEL`.                                                                       |
| Temporal workflow for resolver                            | One cron + idempotent resolver matches the `scheduler-worker` pattern already in use. Temporal is the third tool, not the second.                        |

### Filing Back Through the Loop

The Karpathy insight ("my explorations always add up in the knowledge base") becomes mechanical with EDO:

```
Agent observes data        → core__edo_record_outcome (if resolving) OR core__knowledge_write (if just an event)
Agent forms a prediction   → core__edo_hypothesize     (binds to events via evidence_for)
Agent takes action         → core__edo_decide          (binds to hypothesis via derives_from)
evaluate_at fires          → resolver cron files outcome → validates/invalidates → confidence updates
Outcome becomes evidence   → cited by the next hypothesis
```

Syntropy by construction: agents that follow the loop produce a growing, self-evaluating corpus. Hypotheses that fail get invalidated and their author-strategies lose confidence. Hypotheses that hold compound into established knowledge.

### Read-Path Filters — Why EDO Doesn't Pollute `knowledge`

A reasonable objection to the single-table design: won't `hypothesis` / `decision` / `outcome` rows pollute the table over time, effectively turning `knowledge` into an activity log? The answer is: **filter on read, not split on write.** Splitting transient EDO rows into separate tables would shred the citation DAG (chains would require cross-table UNIONs and a target-table discriminator on `citations`); filtering keeps the DAG intact while presenting a refined surface to the librarian.

The contract for any read path that surfaces "what does this node know" — librarian search, knowledge-hub UI, `core__knowledge_search` — is:

```sql
WHERE status IN ('established', 'canonical')
  AND entry_type NOT IN ('hypothesis', 'decision', 'outcome', 'event')
-- explicit opt-in surfaces (mode=chains, mode=audit, EHDO calibration view)
-- skip this filter to expose the EDO machinery
```

The Postgres search index materializes this filter at index time:

```sql
CREATE INDEX idx_ks_canonical_read ON knowledge_search (domain, confidence_pct DESC)
  WHERE status IN ('established', 'canonical')
    AND entry_type NOT IN ('hypothesis', 'decision', 'outcome', 'event');
```

`SCHEMA_REFINED_BY_READ_FILTER` is the load-bearing invariant — without the filter in the default librarian path, hypothesis-shaped noise reaches agents that asked for canonical knowledge, and the design fails the spec's syntropy bar in practice even though it satisfies it in shape.

#### Chain Read API

The `mode=chains` opt-in surface needs a single read path that walks the citation DAG anchored at one entry — the EDO loop is only visible when hypothesis, decision, and outcome rows are stitched back together by their `validates` / `derives_from` / `evidence_for` edges. This is `EdoCapability.getChain(rootId, …)` on the package side and the following HTTP route on the operator node:

```
GET /api/v1/edo/chain/:id?direction=out|in|both&maxDepth=N
```

| Query param | Type    | Default | Notes                                                          |
| ----------- | ------- | ------- | -------------------------------------------------------------- |
| `direction` | enum    | `both`  | `out` = follow citing→cited; `in` = follow cited→citing.       |
| `maxDepth`  | integer | `5`     | Clamped to `[1, 10]`. Higher values 400 at the route boundary. |

Response shape (mirrors `EdoCapability.getChain` 1:1):

```jsonc
{
  "root": KnowledgeEntry,                       // depth-0 row
  "chain": [
    { "entry": KnowledgeEntry,
      "edgeFromParent": null,                   // null only on the root
      "depth": 0 },
    { "entry": KnowledgeEntry,
      "edgeFromParent": { "citationType": "derives_from", "direction": "out" },
      "depth": 1 },
    // …
  ]
}
```

Auth mirrors the rest of the EDO surface — bearer (agent) and session (human) both pass `getSessionUser`. The walk is cycle-safe (first-visit-wins, BFS-ordered) and returns a flat list — clients reconstruct depth groups by bucketing on `node.depth`. `DoltgresEdoResolverAdapter.walkChain` issues one `WITH RECURSIVE` query (no N+1); `FakeEdoResolverAdapter` mirrors with an in-memory BFS for tests.

### v0 Limitations + Walk-Tier Filters

The Crawl tier ships the **write side** (schema + capability + tools). Two read-side gaps land in Walk:

| v0 (Crawl) state                                           | Walk-tier deliverable                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Default search returns all `entry_type` values             | `LibrarianReadFilter` — applies the WHERE clause above unless the caller opts into `mode=chains/audit` |
| Hypotheses past `evaluate_at` linger forever if unresolved | `staleHypothesisSweep` — auto-`status: deprecated` past `evaluate_at + grace` (v0 grace: 30d)          |
| EHDO calibration view (validates/invalidates by source)    | SQL view aggregating hit-rate per `source_node × resolution_strategy` over 30d rolling                 |

Without these, the spec's intent (refined read surface, bounded transient growth, measurable calibration) is satisfied in principle but not in observable behavior. They are not optional polish — they're the bridge between "the design is correct" and "a human looking at `knowledge` row counts next month doesn't see noise."

---

## Postgres Search Index: Derived and Rebuildable

The Postgres search index is a **read-optimized projection** of Dolt data. It exists solely for retrieval performance. If destroyed, it can be rebuilt from Dolt.

### Sync Direction

```
DOLTGRES (source of truth) ──→ POSTGRES (search index)
         one-way sync
         triggered after Dolt commits
```

### Search Index Table (in Postgres)

**`knowledge_search`** — embedding + full-text index for hybrid retrieval

| Column           | Type         | Description                                      |
| ---------------- | ------------ | ------------------------------------------------ |
| `id`             | text PK      | Same as knowledge.id in Dolt                     |
| `domain`         | text         | Copied from Dolt                                 |
| `title`          | text         | Copied from Dolt                                 |
| `content`        | text         | Copied from Dolt                                 |
| `status`         | text         | Copied from Dolt                                 |
| `confidence_pct` | integer      | Copied from Dolt                                 |
| `embedding`      | vector(1024) | Generated by embedding model (BGE-M3 or similar) |
| `tsv`            | tsvector     | Generated from title + content                   |
| `synced_at`      | timestamptz  | When this row was last synced from Dolt          |

**Indexes:**

```sql
CREATE INDEX idx_ks_embedding ON knowledge_search USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_ks_tsv ON knowledge_search USING gin (tsv);
CREATE INDEX idx_ks_domain_status ON knowledge_search (domain, status);
CREATE INDEX idx_ks_confidence ON knowledge_search (confidence_pct DESC)
  WHERE status != 'deprecated';
```

### Sync Mechanism

Application-level sync after Dolt commits:

1. After storage expert commits to Dolt, sync worker reads changed rows
2. For each changed row: generate embedding, compute tsvector, upsert into Postgres
3. Deprecated rows: update status in Postgres (don't delete — maintain index consistency)

Sync is eventually consistent. Librarian queries may lag behind Dolt writes by seconds. This is acceptable — knowledge queries are not real-time.

### Rebuild

```bash
pnpm knowledge:rebuild-index  # full rebuild of Postgres search index from Dolt
```

Reads all non-deprecated entries from Dolt, generates embeddings, populates `knowledge_search`. Idempotent.

---

## x402: External Knowledge Access

Future: external agents pay per-query to access a node's librarian via [x402](./x402-e2e.md).

```
External Agent
  → x402 payment (USDC on Base, upto amount)
  → Node's librarian endpoint
  → Search + retrieve with citations
  → Response includes knowledge citation tokens
  → Settlement via facilitator
```

The librarian's retrieval contract (same `KnowledgeSearchHit` shape) is the x402 response body. No separate API — the same port that internal agents use is exposed externally with x402 gating.

**What is NOT exposed via x402:**

- Write access (external agents cannot write to a node's Dolt)
- Citation DAG traversal (internal only)
- Confidence recomputation (internal only)
- Raw Dolt access (commit/log/diff)

---

## Invariants

| Rule                                     | Constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DOLT_IS_SOURCE_OF_TRUTH                  | All knowledge data lives in Doltgres. Postgres search index is derived and rebuildable.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ENTRY_HAS_PROVENANCE                     | Every knowledge entry must have `source_type` and `source_ref`. No knowledge without traceable origin.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ENTRY_HAS_DOMAIN                         | Every entry belongs to exactly one registered domain (FK to `domains` table).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| CITATIONS_ON_DERIVED                     | Entries with `source_type: 'derived'` must have at least one citation edge to their source entries.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| CONFIDENCE_APPLICATION_LEVEL             | Confidence is computed in the adapter, not via database triggers. Doltgres has no PL/pgSQL.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DEPRECATE_NOT_DELETE                     | Knowledge is never deleted. Superseded entries get `status: 'deprecated'` + `supersedes` citation edge.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| COMMIT_PER_LOGICAL_WRITE                 | Each logical write gets one Dolt commit with descriptive message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEARCH_BEFORE_INTERNET                   | Agents search node knowledge before falling back to web search.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CITATIONS_IN_RESPONSE                    | Agent responses referencing knowledge must include citation tokens. Citation guard validates.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SYNC_DIRECTION_DOLT_TO_POSTGRES          | Search index sync is one-way: Dolt → Postgres. Never write to Postgres search index directly.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TABLES_NEED_JUSTIFICATION                | New Dolt tables require a fundamentally different data shape, not just different content.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| NODE_KNOWLEDGE_SOVEREIGN                 | Inherited: node knowledge is private by default. Sharing is explicit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| KNOWLEDGE_LOOP_CLOSED_VIA_SIGNED_IN_USER | v0 merge gate: any wallet/cookie-session user can merge a contribution. Bearer-token agents cannot merge, but they can close their own open contribution branch. The session cookie is the trust signal until per-user RBAC lands.                                                                                                                                                                                                                                                                                                         |
| EDO_BEARER_VIA_CONTRIB_BRANCH            | Bearer-authenticated EDO writes (`POST /api/v1/edo/{hypothesize,decide,record-outcome}`) MUST land on a `contrib/<id>` branch via `ContributionService.createEdo*Contribution`. Session-cookie users go direct to main via `EdoCapability.*` (humans are trusted in v0). Internal langgraph tools (`core__edo_*`) keep the direct-to-main path. Same auth-routed rule as `POST /api/v1/knowledge/contributions`.                                                                                                                           |
| KNOWLEDGE_READ_REQUIRES_PRINCIPAL        | The knowledge read endpoints (`GET /api/v1/knowledge`, `GET /api/v1/knowledge/[id]`) require any authenticated principal — cookie-session human **or** bearer agent. External agents must be able to recall the merged plane (`RECALL_BEFORE_WRITE`); a read gate that blocks them breaks the compounding loop. Per-principal x402 metering for paid external readers remains future work (see [x402-e2e](./x402-e2e.md)). Writes still route per `EXTERNAL_WRITES_TO_BRANCH`; merge still per `KNOWLEDGE_LOOP_CLOSED_VIA_SIGNED_IN_USER`. |
| DOMAIN_FK_ENFORCED_AT_WRITE              | Every write to `knowledge` verifies `domain` exists in `domains` before INSERT or contribution-branch UPDATE. Unregistered → `DomainNotRegisteredError` → HTTP 400. Contract: [knowledge-domain-registry](./knowledge-domain-registry.md).                                                                                                                                                                                                                                                                                                 |
| DOMAIN_REGISTRY_EXTENDS_VIA_UI           | Base domains are seeded by the schema migrator (reference data); UI extends beyond the base via cookie-session POST. `NODES_BOOT_EMPTY` scopes to content tables only. Contract: [knowledge-domain-registry](./knowledge-domain-registry.md).                                                                                                                                                                                                                                                                                              |
| EDO_FOUR_BEATS_VIA_ENTRY_TYPE            | Event / Hypothesis / Decision / Outcome are `entry_type` values on `knowledge`, not separate tables. The four beats are content roles, structure lives in the citation DAG.                                                                                                                                                                                                                                                                                                                                                                |
| HYPOTHESIS_HAS_EVALUATE_AT               | Every `entry_type='hypothesis'` row MUST set `evaluate_at` (timestamptz). Enforced at the **adapter layer** (`addKnowledge`/`upsertKnowledge` rejects null `evaluate_at` for hypothesis rows). `evaluate_at` is null for all other entry_types. Resolver cron reads pending rows on `evaluate_at <= now()`.                                                                                                                                                                                                                                |
| CITATION_TARGET_EXISTS_AT_WRITE          | Every `citations.cited_id` MUST reference an existing `knowledge.id` at write time. Enforced at the adapter layer via `port.knowledgeExists(id)` before INSERT. Mirrors `DOMAIN_FK_ENFORCED_AT_WRITE`.                                                                                                                                                                                                                                                                                                                                     |
| OUTCOME_CITES_HYPOTHESIS                 | Every `entry_type='outcome'` row MUST have ≥1 `validates` OR `invalidates` citation edge. Enforced by routing all `outcome` writes through `core__edo_record_outcome` (raw `core__knowledge_write` rejects EDO entry_types).                                                                                                                                                                                                                                                                                                               |
| DECISION_CITES_HYPOTHESIS                | Every `entry_type='decision'` row MUST have ≥1 `derives_from` citation edge to a hypothesis. Enforced by routing all `decision` writes through `core__edo_decide`. Decisions without a falsifiable prediction get filed as `finding` instead.                                                                                                                                                                                                                                                                                              |
| RESOLUTION_STRATEGY_NULL_MEANS_MANUAL    | `knowledge.resolution_strategy` is NULL by default — cron skips. Non-null is a namespaced resolver identifier; v0 allows `agent`. New kinds (`market:<id>`, `metric:<query>`, `http:<url>`, `deadline`) are new column values, never new columns or new tables. Validation in Zod, not DB CHECK.                                                                                                                                                                                                                                           |
| EDO_RECURSION_VIA_CITATIONS              | EDO chain depth is emergent from the citation DAG. No `parent_id`, no `chain_id`, no chain table. To walk a chain, follow citation edges.                                                                                                                                                                                                                                                                                                                                                                                                  |
| CONFIDENCE_RECOMPUTE_ON_RESOLVE          | `validates` / `invalidates` writes trigger a 1-hop `recomputeConfidence` on the cited row. Multi-hop transitive propagation is deferred until v1 data shows the need.                                                                                                                                                                                                                                                                                                                                                                      |
| RESOLVER_IDEMPOTENT                      | `resolveDueHypotheses` MUST be idempotent on hypothesis id. Double-firing a resolution is a no-op (already-resolved hypotheses are skipped).                                                                                                                                                                                                                                                                                                                                                                                               |
| EDO_TOOLS_ATOMIC                         | `core__edo_hypothesize` / `core__edo_decide` / `core__edo_record_outcome` each write entry + edges + commit in one capability call. No partial-loop writes.                                                                                                                                                                                                                                                                                                                                                                                |
| EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE       | `addCitation` verifies the cited row's `entry_type` matches the citation_type's contract: `derives_from`/`validates`/`invalidates` require `cited.entry_type='hypothesis'`; `evidence_for` accepts any. Without this check, falsifiability gates are bypassable.                                                                                                                                                                                                                                                                           |
| RECOMPUTE_IS_PURE_FROM_CITATIONS         | `recomputeConfidence` reads ALL relevant `citations` rows for the target and recomputes from scratch — never increments, never reads prior `confidence_pct`. Concurrent recomputes converge regardless of order; no locks needed.                                                                                                                                                                                                                                                                                                          |
| RESOLVER_MAX_BATCH_PER_TICK              | The resolver cron processes at most N hypotheses per tick (v0: N=10) across all `resolution_strategy` namespaces, with a per-strategy sub-budget. Bounds LLM cost under fan-out spikes (e.g. 100 hypotheses due at the same minute).                                                                                                                                                                                                                                                                                                       |
| RESOLVER_SINGLE_LEADER_PER_NODE          | At most one `resolveDueHypotheses` worker per node runs at a time. **Cost-bounding only, not correctness-load-bearing** — `RESOLVER_IDEMPOTENT` + `RECOMPUTE_IS_PURE_FROM_CITATIONS` already make double-firing safe. v0 mechanism: existing `scheduler-worker` single-replica deploy. If horizontal scaling lands later, a Postgres advisory lock keyed on `cron:resolver:<node>` is sufficient — no consensus needed.                                                                                                                    |

---

## Critical Path After v0

Ordered as the Karpathy compile → Q&A → file-back → lint loop. Each tier = one work item; tier N+1 is filed only when N is in flight or done. **No fan-out.** Tracked end-to-end on [proj.knowledge-syntropy](../../work/projects/proj.knowledge-syntropy.md) — the umbrella project that subsumes the previously separate `proj.knowledge-write-pipeline` (W0) and `proj.edo-foundation` (W1) projects. Every roadmap item that touches contracts/Zod must reference these tiers in its scoping section.

| Tier                                                                        | Karpathy beat         | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                                                                  |
| --------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **P0** — operator-side merging                                              | (foundation)          | A signed-in user can list + merge open contributions through `/knowledge` (Inbox mode). Without this, the contribution flow is theatre.                                                                                                                                                                                                                                                                                | ✅ Done — PR #1308 (task.5037).                                                                         |
| **P0.5** — domain registry + FK enforcement                                 | (foundation)          | `domains` table is enforced at write time. New 3-mode toggle (`Browse · Domains · Inbox`) lets a signed-in user register starter domains via UI; `core__knowledge_write` and HTTP contributions both reject unregistered domains with `DomainNotRegisteredError`. Closes the entropy hole where `ENTRY_HAS_DOMAIN` was a wish.                                                                                         | ✅ Done — PR #1312 (task.5038), merged 2026-05-11.                                                      |
| **W0** — knowledge write gates                                              | compile               | Structured gate chain runs against every write. v0 = `shape` + `provenance` deterministic gates; gates fail closed at the API/tool boundary, never reach Doltgres. v1 layers AI-evaluated quality gates via the existing `.cogni/rules` + `pr-review` graph infra. See [proj.knowledge-syntropy](../../work/projects/proj.knowledge-syntropy.md). Must precede W1 (hypothesis rows also need the gates).               | ✅ Shipped — PR #1356.                                                                                  |
| **W1** — EDO Crawl                                                          | compile (falsifiable) | Hypothesis rows can be written + retrieved + cited; outcomes can validate them via `validates` / `invalidates` citation edges. Adds `evaluate_at` + `resolution_strategy` columns, widens `EntryTypeSchema` / `CitationTypeSchema`, ships `EdoCapability` + three atomic tools + bearer REST surface. Closes the "confidence drifts over time" mechanic at the column level.                                           | 🟡 In flight — PR #1327 (task.5040).                                                                    |
| **W2** — Federation gate                                                    | compile (provenance)  | Bearer-token EDO writes route through `contrib/<id>` branches like other editorial writes. Closes the split-brain finding from #1327 validation (bearer EDO currently bypasses contribution branch and lands directly on main). Trusted internal `core__edo_*` tools keep the direct path.                                                                                                                             | 🟡 In flight — PR #1327 (combined with W1 + R0 for one shippable unit).                                 |
| **R0** — Chains read                                                        | Q&A                   | `GET /api/v1/edo/chain/:id` walks the citation DAG; `/knowledge?mode=chains` UI renders recent EDO chains. Makes syntropy visible to humans; without this, W1's write side is invisible.                                                                                                                                                                                                                               | 🟡 In flight — PR #1327 (combined with W1 + W2).                                                        |
| **R1** — LibrarianReadFilter                                                | Q&A                   | `core__knowledge_search` default-excludes EDO machinery (`entry_type ∈ {event, hypothesis, decision, outcome}` filtered by default; opt-in flag to include). Stops EDO chain noise from drowning out canonical claims in unrelated searches.                                                                                                                                                                           | 🔴 After R0.                                                                                            |
| **R1.5** — Poly-side route bindings                                         | Q&A                   | Poly mirrors operator's contribution + browse surface (currently 404 on poly).                                                                                                                                                                                                                                                                                                                                         | 🔴 Trivial follow-up; combine with R0/R1 if natural.                                                    |
| **F0** — File-back                                                          | file back             | Brain prompt teaches the Karpathy "explorations always add up" discipline — after a research turn, file the finding as `knowledge` + cite sources. Post-session indexer hook syncs Postgres search index. Closes the compounding flywheel.                                                                                                                                                                             | 🔴 vNext.                                                                                               |
| **L0** — Curator                                                            | lint                  | `staleHypothesisSweep` cron flags hypotheses past `evaluate_at` without an outcome; dedup pass surfaces near-duplicates; promotion lifecycle runs from confidence + outcome validation; confidence decay applies the formula in § "Confidence Is Computed, Not Assigned". Combines DAG traversal in search (1-hop neighbors + `cited_by_count`), the confidence-recompute walker, and the `evaluate_at` resolver cron. | 🔴 vNext; needs W1 (citation edges) + R0 (chains) first.                                                |
| **L1** — Auto-summaries                                                     | lint (distinctive)    | Karpathy's distinctive insight: LLM auto-maintains index entries + per-domain summaries. Curator emits `summary` entries that compress recent knowledge into navigable index files.                                                                                                                                                                                                                                    | 🔴 vNext.                                                                                               |
| **Rd-PORTABLE** — extract `/knowledge` page into `@cogni/knowledge-base-ui` | (infra)               | Operator-side `/knowledge` (task.5037) is the reference implementation; every knowledge-capable node will need its own knowledge hub. Move the page + `_api/*` + `_components/*` into a shared package, mounted from each node's `(app)/knowledge/page.tsx` as a thin re-export. Same pattern as `@cogni/knowledge-base` (schema).                                                                                     | Filed when a second node (poly) needs `/knowledge` — the carve-out cost is amortized across nodes 2..N. |

**Anti-sprawl rule**: If a future agent considers expanding scope beyond their tier, file the next-tier work item and stop. Don't bundle.

---

## Open Questions

- [ ] Embedding model choice: BGE-M3 (self-hosted, 1024d, MIT) vs voyage-3-large (API, $0.06/1M tokens) vs defer embeddings until scale demands it?
- [ ] Sync mechanism: post-commit hook in adapter vs polling vs Temporal workflow?
- [ ] Dolt ILIKE support: confirmed broken in spike — is `LOWER(col) LIKE LOWER(...)` sufficient, or does all text search go through Postgres?
- [ ] x402 query pricing: flat per-query or proportional to result count / token size?
- [ ] Should `sources` table track per-source hit rate (how often knowledge from this source is validated)?
- [ ] Citation DAG depth limit for confidence computation — should contradictions propagate transitively?

## Related

- [knowledge-data-plane](./knowledge-data-plane.md) — Doltgres infrastructure, per-node databases, KnowledgeStorePort
- [cogni-brain](./cogni-brain.md) — citation guard, recall loop, NO_CLAIMS_WITHOUT_CITES
- [monitoring-engine](./monitoring-engine.md) — awareness plane tables, promotion criteria
- [x402-e2e](./x402-e2e.md) — payment protocol for external access
- [node-operator-contract](./node-operator-contract.md) — DATA_SOVEREIGNTY, FORK_FREEDOM
- [data-streams](./data-streams.md) — awareness pipeline, what flows into knowledge
- [Research: AI Knowledge Storage](../research/ai-knowledge-storage-indexing-retrieval.md) — embedding models, chunking, hybrid search patterns
