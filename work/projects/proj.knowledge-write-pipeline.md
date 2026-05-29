---
id: proj.knowledge-write-pipeline
type: project
primary_charter: chr.knowledge
title: Knowledge Write Pipeline — Dolt-side CI/CD for the knowledge plane
state: Active
priority: 1
estimate: 8
summary: Every knowledge write passes a structured gate chain — deterministic shape gates at v0, AI-evaluated quality gates at v1, per-node sovereign rules at v2. Mirrors code CI/CD (PR lane / main lane, structural enforcement, per-app sovereignty) without inventing knowledge environments.
outcome: A knowledge entry on a node's trunk is provably valid by construction. Bad writes fail at the boundary; good writes accumulate. The same gate framework hosts AI-powered review at v1, eliminating the parallel infra problem.
assignees: derekg1729
created: 2026-05-27
updated: 2026-05-27
labels: [knowledge, dolt, ci-cd, gates, syntropy]
---

# Knowledge Write Pipeline

> Code commits pass through CI gates before they merge to trunk. Knowledge commits should too.

## Goal

Every write to a node's knowledge hub (internal `core__knowledge_write` OR external HTTP contribution) passes through a deterministic gate chain. Bad writes fail at the API/tool boundary; accepted writes are provably valid by construction. The framework hosts AI-evaluated quality gates at v1 by reusing the existing `.cogni/rules/*.yaml` + `pr-review` graph infrastructure.

## Non-Goals

- **No knowledge environments.** Each node has one Dolt hub, one trunk (`main`). The CI/CD spec's `candidate → preview → production` layering does NOT translate.
- **No confidence-gated promotion across environments.** Low-confidence rows live in the production knowledge db happily; confidence is a row attribute that evolves via citations + outcomes, not a deploy target.
- **No parallel rules engine.** The AI-gate tier (v1+) reuses `.cogni/rules/*.yaml` schema verbatim and the `goal-evaluations` graph runner with a `knowledge-evaluations` variant.

## Architecture

```
write request (HTTP /knowledge/contributions or core__knowledge_write tool)
   │
   ▼
runGateChain(V0_DETERMINISTIC_GATES, candidate, ctx)
   │
   ├─ shape gate        — slug regex, title 3-60, content non-empty
   ├─ provenance gate   — source_type + source_ref coherence
   │  (v1+ adds AI gates via @cogni/langgraph-graphs/graphs/knowledge-review)
   ▼
KnowledgeStorePort.addKnowledge / KnowledgeContributionPort.appendCommit
   │
   ▼
Dolt commit on main (internal) or contrib/* (external)
```

Gates implement a uniform interface (`KnowledgeGate`) with a chain runner. Per-node sovereignty: future per-node gate sets live in `nodes/<node>/.cogni/knowledge-rules/*.yaml`, picked up by the same chain.

## Roadmap

### P0.6.v0 — Deterministic gates (this PR)

| Deliverable                                                             | Status          | Notes                                        |
| ----------------------------------------------------------------------- | --------------- | -------------------------------------------- |
| `KnowledgeGate` interface + `runGateChain` runner                       | In flight       | `packages/knowledge-store/src/domain/gates/` |
| `shape` gate — Zod-backed (slug regex, title 3-60, content non-empty)   | In flight       | Composable, replaces inline Zod parse calls  |
| `provenance` gate — `source_type` + `source_ref` coherence              | In flight       | External/derived require `source_ref`        |
| Wire chain into `contribution-service` (create + appendCommit)          | In flight       | Single integration point                     |
| Wire chain into `core__knowledge_write` tool                            | In flight       | Same gates, internal path                    |
| Tighten existing Zod (slug max 40, title max 60) at API + tool boundary | In flight       | API rejects garbage before the chain         |
| UI projection: relative timestamps, drop branch column from inbox       | In flight       | Human-view layer; AI API path unchanged      |
| Skill: `.claude/skills/knowledge-syntropy-expert/SKILL.md`              | Done (PR #1356) | Authoritative planner                        |

### P0.6.v0b — Description field + slug retrofit

| Deliverable                                      | Status              | Notes                                         |
| ------------------------------------------------ | ------------------- | --------------------------------------------- |
| Add `knowledge.description text NOT NULL` column | Filed when v0 ships | Doltgres migration 0004 + drizzle snapshot    |
| Wipe + re-author the 2 existing stale meta rows  | Filed when v0 ships | No backcompat shim                            |
| Render description in browse row (line 2, muted) | Filed when v0 ships | Discoverability surface for humans            |
| `core__knowledge_write` requires description     | Filed when v0 ships | Force the "use when X" framing on every write |

### P0.6.v0c — DoltHub mirror (task.5069, PR #1360)

| Deliverable                                                    | Status                  | Notes                                                                                                                            |
| -------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `createDoltgresPusher` + `wrapPushSafe` in knowledge-store     | In review (PR #1360)    | `packages/knowledge-store/src/adapters/doltgres/dolt-remote.ts`                                                                  |
| `ContributionServiceDeps.pushMainOnMerge` hook                 | In review (PR #1360)    | Optional, fire-and-forget; caller owns error handling                                                                            |
| Operator container DI wiring (gate-by-secret-presence)         | In review (PR #1360)    | `nodes/operator/app/src/bootstrap/container.ts` — wires hook iff `DOLTHUB_REMOTE_URL` is set; prod-only secret scope is the gate |
| `install-creds.sh` doltgres entrypoint wrapper                 | In review (PR #1360)    | Installs Dolt keypair from `DOLT_CREDS_JWK` + `DOLT_CREDS_KEYID` before server start                                             |
| Env wiring through all 9 surfaces (workflows, compose, deploy) | In review (PR #1360)    | `DOLTHUB_REMOTE_URL`, `DOLT_CREDS_{JWK,KEYID}`                                                                                   |
| Bootstrap runbook                                              | In review (PR #1360)    | `docs/runbooks/dolthub-remote-bootstrap.md` — REST repo creation, `dolt creds new`, prod-only secret provisioning                |
| Reconciliation cron for missed pushes                          | Filed when v0 ships     | v1: diff `dolt_log` against `origin/main`, idempotent re-push of any local commits not yet on remote                             |
| Contributor attribution at Dolt commit-author level            | task.5070 (OAuth-blocked) | v0 all pushes appear as `cogni`/`steward@cognidao.org`; principalId is preserved in row data only                                |

### P0.6.v1 — YAML rule loader + per-node sovereignty

| Deliverable                                                        | Notes                             |
| ------------------------------------------------------------------ | --------------------------------- |
| `KnowledgeGatePort` abstraction                                    | Lifts gates above hand-coded list |
| YAML loader for `.cogni/knowledge-rules/*.yaml`                    | Mirror `.cogni/rules/` schema     |
| Per-node rule directories: `nodes/<node>/.cogni/knowledge-rules/*` | Fork freedom                      |
| `applies_to` scoping (entry_types, domains, min_confidence_target) | Affected-only gate runs           |

### P2 — AI-evaluated quality gates

| Deliverable                                                                              | Notes                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------- |
| `createKnowledgeReviewGraph` — single-call structured-output graph                       | Mirrors `pr-review` graph factory     |
| `knowledge-evaluations` workflow_id                                                      | Parallels existing `goal-evaluations` |
| v1-quality.yaml — concise, discoverable, cited, non-duplicate, refine-not-extend metrics | Same YAML schema as `.cogni/rules`    |
| Gate runs on every contribution merge to main                                            | Promotion gate for canonical claims   |

### P3 — Confidence walker + DAG enforcement

(Already filed in syntropy spec — gate framework hosts the recompute walker's pre-commit checks)

## Invariants

| Rule                       | Constraint                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GATES_FAIL_CLOSED          | A gate returns `{ ok: false }` → write rejected at API/tool boundary. No soft-warn bypass.                                                  |
| TRUNK_BASED_PER_NODE       | Each node has one Dolt hub, one trunk. No knowledge environments.                                                                           |
| CONFIDENCE_OUTSIDE_GATES   | Confidence is a row attribute that evolves via citations + outcomes. Gates do NOT promote across confidence tiers.                          |
| GATES_REUSE_AI_RULES_INFRA | v1+ AI gates reuse `.cogni/rules/*.yaml` schema and the graph runner with `workflow_id: knowledge-evaluations`. No parallel engine.         |
| PER_NODE_SOVEREIGN_RULES   | Each node's gate set lives in `nodes/<node>/.cogni/knowledge-rules/*`. Forks own their gates.                                               |
| AI_PATH_RETURNS_FULL_ROW   | AI consumers (`GET /knowledge/...`, `core__knowledge_search/read`) get full row fidelity. Human-view projection is a separate render layer. |

## Constraints

- Each node has one Dolt hub, one trunk — no knowledge environments mirroring the code CI/CD `candidate → preview → production` ladder.
- Gates run synchronously inside the write path (HTTP request, tool call). v0 gates must be fast (sub-millisecond per check); v1+ AI gates will run async or be reserved for promotion events to avoid blocking the write.
- v1+ must reuse the existing `.cogni/rules/*.yaml` schema + `pr-review` graph runner. A parallel rules engine is explicitly disallowed.
- Confidence is a row attribute that compounds via citations + outcomes. Gates do NOT promote across confidence tiers — confidence sits outside the gate chain entirely.

## Dependencies

- [x] `KnowledgeStorePort` + Doltgres adapter (shipped)
- [x] `core__knowledge_write` tool (shipped)
- [x] External contribution API + `KnowledgeContributionPort` (PR #1133 / #1343)
- [x] Domain registry FK enforcement — P0.5 (PR #1312 merged 2026-05-11)
- [ ] `.cogni/rules` schema + `pr-review` graph factory — for v1+ AI gates (already exists; needs `knowledge-evaluations` variant)

## As-Built Specs

- [knowledge-syntropy.md](../../docs/spec/knowledge-syntropy.md) — schema, citation DAG, confidence lifecycle; critical-path table tracks the tier in flight
- [knowledge-data-plane.md](../../docs/spec/knowledge-data-plane.md) — Doltgres infrastructure
- [knowledge-contribution-api.md](../../docs/design/knowledge-contribution-api.md) — external-write path the gates integrate with
- [ci-cd.md](../../docs/spec/ci-cd.md) — code CI/CD this pipeline mirrors structurally (lanes, gates fail-closed, per-app sovereignty)

## Design Notes

- Gate chain lives in `packages/knowledge-store/src/domain/gates/` — pure domain layer with no port dependencies in v0. v1 will introduce `KnowledgeGatePort` once YAML loading + per-node rule discovery need an injectable seam.
- v0 deliberately ships TypeScript-coded gates rather than YAML-loaded rules to keep the prototype tight. The YAML loader at v1 is mechanical once the architecture is exercised.
- The capability layer (`createKnowledgeCapability`) is the seam for the internal-tool path; the contribution service is the seam for the external HTTP path. Both run the same gate chain.
- See [knowledge-syntropy-expert skill](../../.claude/skills/knowledge-syntropy-expert/SKILL.md) — authoritative planner; tier ordering lives there.

## Related

- [Knowledge Syntropy Spec](../../docs/spec/knowledge-syntropy.md) — schema, citation DAG, confidence lifecycle
- [Knowledge Data Plane Spec](../../docs/spec/knowledge-data-plane.md) — Doltgres infrastructure
- [Knowledge Contribution API](../../docs/design/knowledge-contribution-api.md) — external-write path
- [CI/CD Spec](../../docs/spec/ci-cd.md) — code CI/CD that this mirrors structurally
- [Knowledge Syntropy Expert Skill](../../.claude/skills/knowledge-syntropy-expert/SKILL.md) — authoritative planner
- `.cogni/rules/*.yaml` + `packages/langgraph-graphs/src/graphs/pr-review/` — infra reused at v1+
