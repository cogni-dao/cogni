---
id: proj.knowledge-syntropy
type: project
primary_charter: chr.knowledge
title: Knowledge Syntropy — Karpathy-loop umbrella for the node knowledge plane
state: Active
priority: 1
estimate: 13
summary: Umbrella project covering the full compile → Q&A → file-back → lint loop on the node knowledge plane. Spans the write side (gates, EDO crawl, federation), the read side (chain visibility, librarian filtering), and the curator side (auto-summaries, staleness sweeps). Subsumes the previously separate proj.knowledge-write-pipeline (W tiers) and proj.edo-foundation (W1) projects — those were sub-tiers, not independent projects.
outcome: An agent files a hypothesis, takes a decision citing it, the resolver files the outcome on schedule, the chain is browsable on `/knowledge?mode=chains`, the librarian default-filters EDO machinery out of unrelated searches, the curator keeps the index clean, and every editorial write earns its place via the contribution branch. The Karpathy loop runs end-to-end on Doltgres without an agent in the seat.
assignees: derekg1729
created: 2026-05-27
updated: 2026-05-29
labels: [knowledge, dolt, syntropy, edo, karpathy, gates, librarian, curator]
---

# Knowledge Syntropy

> Karpathy's loop: `raw → LLM compile → wiki → LLM Q&A → outputs → file back → wiki → LLM lint → wiki`.
> Our job is to make that loop run on Doltgres-backed node knowledge, with provenance, citation DAGs, and per-node sovereignty bolted on.

## Goal

Stand up the full Karpathy compile / Q&A / file-back / lint cycle on the node knowledge plane. Editorial knowledge claims earn their place through gates and a contribution branch; operational state takes a fast path. Predictions are falsifiable, outcomes file themselves, chains are browsable, search defaults stay clean, and a curator keeps the index honest.

This project is the umbrella. It replaces two earlier projects that were really sub-tiers of the same loop:

- **proj.knowledge-write-pipeline** → folded in as the **W0 Gates** tier (shipped via PR #1356).
- **proj.edo-foundation** → folded in as the **W1 EDO Crawl** tier (shipping via PR #1327).

A reviewer reading this page should see one roadmap with one tier ordering and never wonder why those two existed as separate projects.

## Non-Goals

- **No knowledge environments.** Each node has one Dolt hub, one trunk. The code CI/CD `candidate → preview → production` ladder does NOT translate to knowledge.
- **No parallel rules engine.** v1+ AI gates reuse `.cogni/rules/*.yaml` + the `pr-review` graph runner with a `knowledge-evaluations` workflow variant.
- **No cross-node EDO compounding in v1.** Per-node sovereignty bounds chains until Dolt remotes (KNOWLEDGE charter) close that gap.
- **No new tables for the EDO loop.** The four beats are `entry_type` values on `knowledge`; recursion is emergent from `citations`.
- **No materialized confidence triggers.** Doltgres 0.56 has no PL/pgSQL — recompute runs in the adapter.

## The Karpathy Loop on Cogni

```
raw signals / agent output / external sources
        │
        │  W tiers — "LLM compile"
        ▼
contribution branch → gates → main on the node's Dolt hub
        │
        │  R tiers — "LLM Q&A"
        ▼
librarian search + chain UI → agent / human reads
        │
        │  F tier — "file back"
        ▼
agent's outputs re-enter as new knowledge entries with citations
        │
        │  L tiers — "LLM lint"
        ▼
curator: stale sweeps, dedup, promotion, auto-summaries
```

W → R → F → L. Each tier closes one gap before the next is filed.

---

## Tier Roadmap

| Tier | Karpathy beat | Outcome | Status |
| ---- | -------------- | ------- | ------ |
| **W0 — Gates** | compile | `KnowledgeGate` interface + `runGateChain` + deterministic `shape` + `provenance` gates wired into both `core__knowledge_write` and `POST /knowledge/contributions`. Fails closed at the API/tool boundary, never reaches Doltgres. UI projection cleanup (relative timestamps, branch column drop) shipped in the same PR. | 🟢 Shipped via PR #1356. |
| **W0b — Description field** | compile | `knowledge.description text NOT NULL` column + slug retrofit + browse row line 2 + `core__knowledge_write` requires description. Forces the "use when X" framing on every write. | 🔴 Filed when v0 is exercised. |
| **W0c — DoltHub mirror** | compile (durability) | `createDoltgresPusher` + `ContributionServiceDeps.pushMainOnMerge` hook + `install-creds.sh` + 9-surface env wiring (`DOLTHUB_REMOTE_URL`, `DOLT_CREDS_{JWK,KEYID}`). Optional, fire-and-forget, gated on secret presence. Reconciliation cron (task.5073) and per-contributor commit authorship (task.5070, OAuth-blocked) tracked as follow-ups. | 🟡 In review (PR #1360). |
| **W1 — EDO Crawl** | compile (falsifiable) | Schema migration 0005 adds `evaluate_at` + `resolution_strategy`; `EntryTypeSchema` widens to include `event`/`hypothesis`/`decision`/`outcome`; `CitationTypeSchema` adds `evidence_for`/`derives_from`/`validates`/`invalidates`; `EdoCapability` + `EdoResolverPort` + three atomic tools (`core__edo_{hypothesize,decide,record_outcome}`) + bearer REST surface (`POST /api/v1/edo/{hypothesize,decide,record-outcome}`) + 1-hop `recomputeConfidence`. Stack test exercises the full loop. Replaces the standalone proj.edo-foundation project. | 🟡 Shipping via PR #1327 (head `de92d9bb4`), tracked on task.5040. |
| **W2 — Federation gate** | compile (provenance) | Bearer-token EDO writes route through `contrib/<id>` branches like other editorial writes. Closes the split-brain finding from #1327 validation: today bearer EDO bypasses the contribution branch and lands directly on main. Trusted internal `core__edo_*` tools keep the direct path. | 🔴 Immediate next once W1 merges. |
| **R0 — Chains read** | Q&A | `GET /api/v1/edo/chain/:id` walks the citation DAG; `/knowledge?mode=chains` UI renders recent EDO chains so humans can see the loop running. Makes syntropy visible. | 🔴 Immediate next; without this, the W1 write side is invisible. |
| **R1 — LibrarianReadFilter** | Q&A | `core__knowledge_search` default-excludes EDO machinery (`entry_type IN {event, hypothesis, decision, outcome}` filtered by default; opt-in flag to include). Stops EDO chain noise from drowning out canonical claims in unrelated searches. | 🔴 Filed after R0; needed before the brain leans on search. |
| **F0 — File-back** | file back | Brain prompt teaches the Karpathy "explorations always add up" discipline — after a research turn, file the finding as `knowledge` + cite sources. Post-session indexer hook syncs Postgres search index. Closes the compounding flywheel. | 🔴 vNext. |
| **L0 — Curator** | lint | `staleHypothesisSweep` cron flags hypotheses past `evaluate_at` without an outcome; dedup pass surfaces near-duplicate entries; promotion lifecycle (`draft → candidate → established → canonical`) runs from confidence + outcome validation; confidence decay applies the formula in syntropy spec § "Confidence Is Computed, Not Assigned". | 🔴 vNext; needs W1 (citation edges) + R0 (chains) first. |
| **L1 — Auto-summaries** | lint (distinctive) | Karpathy's distinctive insight: LLM auto-maintains index entries + per-domain summaries. Curator emits `summary` entries that compress recent knowledge into navigable index files. | 🔴 vNext. |
| **Rd-PORTABLE** | (infra) | Extract `/knowledge` page into `@cogni/knowledge-base-ui` so every knowledge-capable node mounts the same hub. Same pattern as `@cogni/knowledge-base`. | 🔴 Filed when a second node (poly) needs `/knowledge`. |

**Anti-sprawl rule:** if a future agent considers expanding scope beyond their tier, file the next-tier work item and stop. Don't bundle.

---

## Five Write Paths to Operator-Doltgres Knowledge

Knowledge writes are not uniform. There are five paths today, each with a different trust model. The split-brain finding from PR #1327 validation is that path 3 currently violates the editorial-vs-operational split — W2 closes it.

| # | Path | Surface | Trust source | Lands on | Notes |
| --- | ---- | ------- | ------------ | -------- | ----- |
| 1 | `POST /api/v1/knowledge/contributions` | Bearer or session | API key / session cookie | `contrib/<id>` → session merge | The canonical editorial path. Gates fail-closed; session user merges. |
| 2 | `POST /api/v1/knowledge/domains` (post-#1327) | Bearer or session | API key / session cookie | **Direct to main** | Reference data, not editorial claims. FK target — registry must exist before content writes can cite it. |
| 3 | `POST /api/v1/edo/{hypothesize,decide,record-outcome}` (post-#1327) | Bearer or session | API key / session cookie | **Currently direct to main; W2 routes bearer through `contrib/*`** | This is the split-brain. Hypotheses are editorial knowledge claims — they should earn their place via the contribution branch when authored by an external bearer principal. Trusted internal `core__edo_*` tools keep the direct path. |
| 4 | `POST /api/v1/work/items/*` | Bearer or session | API key / session cookie | `work_items` table, direct to main | Operational state, not editorial knowledge. Direct-to-main is correct by design. |
| 5 | `core__knowledge_write` + `core__edo_*` (langgraph tools) | Internal tool | Caller (graph runtime) | Direct to main | Trusted internal callers. Gates still run; branch detour would add latency without trust gain. |

**Frame:** editorial knowledge claims → contribution branch (paths 1, 3-after-W2). Operational state and reference data → direct (paths 2, 4, 5). W2 is specifically about moving path 3 from the wrong column to the right column for bearer principals.

---

## Architecture

```
write request
   │
   ├─ editorial bearer principal? ────► contrib/<id> branch
   │                                       │
   ├─ trusted internal / session? ───► main (after gates)
   │
   ▼
runGateChain(gates, candidate, ctx)
   │
   ├─ shape gate        — slug regex, title 3-60, content non-empty
   ├─ provenance gate   — source_type + source_ref coherence
   ├─ (W1) entry-type gate — hypothesis requires evaluate_at; citation targets exist
   │  (v1+ adds AI gates via @cogni/langgraph-graphs/graphs/knowledge-review)
   ▼
KnowledgeStorePort.addKnowledge / KnowledgeContributionPort.appendCommit
   │
   ▼
Dolt commit on main (internal/session merge) or contrib/* (external editorial)
   │
   ▼ (W0c)
DoltHub mirror push (fire-and-forget when DOLTHUB_REMOTE_URL set)
```

Gates implement a uniform `KnowledgeGate` interface with a chain runner. Per-node sovereignty: future per-node gate sets live in `nodes/<node>/.cogni/knowledge-rules/*.yaml`, picked up by the same chain (W0 v1).

---

## Invariants

| Rule | Constraint |
| ---- | ---------- |
| GATES_FAIL_CLOSED | A gate returns `{ ok: false }` → write rejected at API/tool boundary. No soft-warn bypass. |
| TRUNK_BASED_PER_NODE | Each node has one Dolt hub, one trunk. No knowledge environments. |
| EDITORIAL_VIA_CONTRIB | External bearer principals writing editorial knowledge (knowledge/contributions, EDO post-W2) land on a `contrib/<id>` branch first. Operational state and trusted internal callers skip the branch. |
| CONFIDENCE_OUTSIDE_GATES | Confidence is a row attribute that evolves via citations + outcomes. Gates do NOT promote across confidence tiers. |
| GATES_REUSE_AI_RULES_INFRA | v1+ AI gates reuse `.cogni/rules/*.yaml` schema and the graph runner with `workflow_id: knowledge-evaluations`. No parallel engine. |
| PER_NODE_SOVEREIGN_RULES | Each node's gate set lives in `nodes/<node>/.cogni/knowledge-rules/*`. Forks own their gates. |
| AI_PATH_RETURNS_FULL_ROW | AI consumers (`GET /knowledge/...`, `core__knowledge_search/read`) get full row fidelity. Human-view projection is a separate render layer. |
| HYPOTHESIS_HAS_EVALUATE_AT | (W1) `entry_type='hypothesis'` rows must have a non-null `evaluate_at`. Adapter enforces; typed error → HTTP 400. |
| RAW_WRITE_REJECTS_TYPES | (W1) `core__knowledge_write` rejects `entry_type ∈ {hypothesis, decision, outcome}`. EDO types come through `core__edo_*` only. |
| RECOMPUTE_IS_PURE_FROM_CITATIONS | (W1) `recomputeConfidence` reads all relevant citations and computes from scratch; never increments. Order-independent; no locks needed. |
| LIBRARIAN_HIDES_EDO_BY_DEFAULT | (R1) Default `core__knowledge_search` excludes EDO machinery types unless the caller opts in. |

---

## Dependencies

- [x] `KnowledgeStorePort` + Doltgres adapter (shipped)
- [x] `core__knowledge_write` tool (shipped)
- [x] External contribution API + `KnowledgeContributionPort` (PR #1133 / #1343)
- [x] Domain registry FK enforcement — P0.5 (PR #1312 merged 2026-05-11)
- [x] W0 gates (PR #1356, shipped)
- [ ] W1 EDO Crawl — PR #1327, task.5040
- [ ] `.cogni/rules` schema + `pr-review` graph factory — for v1+ AI gates (already exists; needs `knowledge-evaluations` variant)

## As-Built Specs

- [knowledge-syntropy.md](../../docs/spec/knowledge-syntropy.md) — schema, citation DAG, confidence lifecycle, EDO loop, critical-path table mirrors the tier roadmap above.
- [knowledge-data-plane.md](../../docs/spec/knowledge-data-plane.md) — Doltgres infrastructure.
- [knowledge-contribution-api.md](../../docs/design/knowledge-contribution-api.md) — external-write path the gates integrate with.
- [knowledge-domain-registry.md](../../docs/spec/knowledge-domain-registry.md) — registry that EDO writes depend on for FK validity.
- [ci-cd.md](../../docs/spec/ci-cd.md) — code CI/CD this pipeline mirrors structurally (lanes, gates fail-closed, per-app sovereignty).

## Design Notes

- Gate chain lives in `packages/knowledge-store/src/domain/gates/` — pure domain layer with no port dependencies in v0. v1 introduces `KnowledgeGatePort` once YAML loading + per-node rule discovery need an injectable seam.
- v0 deliberately ships TypeScript-coded gates rather than YAML-loaded rules to keep the prototype tight. The YAML loader at v1 is mechanical once the architecture is exercised.
- The capability layer (`createKnowledgeCapability` / `createEdoCapability`) is the seam for internal-tool paths; the contribution service is the seam for the external HTTP path. Both run the same gate chain.
- W1 EDO writes are atomic: one capability call writes the entry + the citation edges + the Dolt commit in one transaction-equivalent unit, so a half-written hypothesis cannot escape.
- Per-node sovereignty bounds EDO chains: an outcome on `poly` cannot cite a hypothesis on `operator`. Cross-node compounding waits on Dolt remotes (see KNOWLEDGE charter).
- See [knowledge-syntropy-expert skill](../../.claude/skills/knowledge-syntropy-expert/SKILL.md) — authoritative planner; tier ordering lives there too.

## Related

- [Knowledge Syntropy Spec](../../docs/spec/knowledge-syntropy.md)
- [Knowledge Data Plane Spec](../../docs/spec/knowledge-data-plane.md)
- [Knowledge Contribution API](../../docs/design/knowledge-contribution-api.md)
- [CI/CD Spec](../../docs/spec/ci-cd.md)
- [Knowledge Syntropy Expert Skill](../../.claude/skills/knowledge-syntropy-expert/SKILL.md)
- [Karpathy LLM Knowledge Bases research](../../docs/research/ai-knowledge-storage-indexing-retrieval.md) — § 0 "The Karpathy Pattern"
- `.cogni/rules/*.yaml` + `packages/langgraph-graphs/src/graphs/pr-review/` — infra reused at W0 v1+
