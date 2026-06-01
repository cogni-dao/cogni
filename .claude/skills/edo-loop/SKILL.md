---
name: edo-loop
description: File a falsifiable prediction → action → outcome chain on the operator knowledge store via POST /api/v1/edo/{hypothesize,decide,record-outcome}. Rare by design — ~20% of agent work earns an EDO row; most investigations stay in the PR. Use this skill ONLY when the prediction (a) cannot be resolved before the current session ends, (b) is contestable, and (c) shapes what a future agent will do. Triggers: "file an EDO", "predict + later check", "will this PR move the metric over N runs", "close a hypothesis loop". Skip for smoke tests, type checks, anything observable now, routine PR work.
---

# edo-loop — file a falsifiable chain on the knowledge hub

> EDO is for **predictions that resolve later** and **teach the next agent**. Everything else stays in the PR.

## Action hierarchy (mirrors `knowledge-syntropy-expert`)

Walk top-to-bottom. Stop at the first match. **Most agent work stops at step 1.**

1. **STAY SILENT.** Outcome observable now? Routine implementation? Bug fix? Doc change? — **do not write any EDO row.** Knowledge entries are precious; not every action earns one. **≥80% of work belongs here.**
2. **RECALL.** Before opening a new chain, search `/knowledge?mode=chains` (or `GET /api/v1/edo/chain/:id` on a known root) for an existing hypothesis in this `domain` that already covers your prediction. If one exists → step 3.
3. **REFINE via citation.** File your `decide` as `derives_from` THAT hypothesis. File an evidence-bearing observation as `evidence_for` THAT hypothesis. **Compound, don't branch.** This is the most valuable EDO move.
4. **WRITE ATOMIC.** No existing chain fits AND all three gates below pass → file `hypothesize`. Subsequent `decide` + `record-outcome` auto-compound onto your one open contribution (W2.5).
5. **EXTEND.** Anti-pattern. Don't bloat one hypothesis to cover new predictions; that's a sibling cited via `extends` / `supersedes`.

## The three gates — file only if ALL three are true

- **SESSION_SEPARATED_OUTCOME** — you cannot observe the outcome before your current session ends. If a single curl resolves it, it's a smoke test, not EDO.
- **CONTESTABLE_PREDICTION** — a rational adversary could take the other side. If you'd give it 95%+ at write time, the chain teaches nothing.
- **COMPOUNDS_FOR_NEXT_AGENT** — a future agent reading the chain acts differently than they would without it.

If any gate fails → **DO NOT WRITE ANYTHING.** No "write a finding instead" fallback — that's sprawl.

## Refine vs create new — the citation matrix

After RECALL surfaces a related hypothesis, pick the right edge type. Default is REFINE/CITE; opening a new atomic hypothesis is the rare path.

| Your prediction relative to an existing hypothesis | Action                 | Citation edge                                                   | What lands on the chain                                   |
| -------------------------------------------------- | ---------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| Same prediction, you have new evidence             | REFINE                 | `evidence_for` (from observation → hypothesis)                  | One commit; hypothesis confidence recomputes              |
| Same prediction, you're acting on it               | REFINE                 | `derives_from` (from your decision → hypothesis)                | One commit; decision row compounds onto branch            |
| Same prediction, outcome lands now                 | REFINE                 | `validates` / `invalidates` (from outcome → hypothesis)         | Closes the loop; confidence recomputes                    |
| Adjacent / different conditions                    | NEW + cite             | `extends` (new hypothesis → original)                           | New sibling hypothesis, links to parent                   |
| Contradicts the existing claim                     | NEW + cite             | `contradicts` (new hypothesis → original)                       | New sibling; original's confidence decreases on recompute |
| Approach replaced                                  | NEW + cite + deprecate | `supersedes` (new → original) + `status:deprecated` on original | Per DEPRECATE_NOT_DELETE                                  |
| No related hypothesis exists                       | WRITE ATOMIC           | none                                                            | New chain, but only after RECALL confirmed empty          |

## EDO + PRs — when a code contribution carries a chain

EDO is orthogonal to `/contribute-to-cogni` lifecycle (work-items own _intent + execution state_), but a single PR often **is** the decision in a chain:

```
research → file hypothesis (predicts deploy effect)
            │
            ▼
ship PR  → file decision (derives_from hypothesis; source_ref="pr:<N>")
            │
        deploy lands; metric resolves over N sessions
            │
            ▼
file outcome (validates/invalidates hypothesis; source_ref="sha:<deployed-sha>")
```

Concrete patterns:

- **Hypothesis precedes PR** — when an agent has a falsifiable belief about an upcoming change, file `hypothesize` first; the PR description references `proof:<stem>-h` so reviewers see the prediction the code is testing.
- **Decision IS the PR** — file `decide` after the PR merges (or after `candidate-flight` deploys), with `source_ref: "pr:<N>"` in the body so the chain points at the actual diff.
- **Outcome reads the deployed system** — file `record-outcome` only after the deployed code has run long enough to resolve the prediction (per SESSION_SEPARATED_OUTCOME).
- **Don't file EDO for the PR itself.** Implementation findings ("type error fixed", "lint passes") belong in the PR description, not in EDO.

## Confidence — what the numbers mean

Initial confidence depends on `sourceType` (set automatically from your principal). The resolver recomputes after every citation edge lands:

```
final_pct = clamp(0..100,
  initial_by_source
  + min(supporting_count * 10, 50)        # validates/supports/evidence_for/extends
  - contradicting_count * 15              # invalidates/contradicts
)
```

| Source type                   | Initial pct | Means                                                   |
| ----------------------------- | ----------- | ------------------------------------------------------- |
| `human`                       | 70          | A signed-in human authored — high trust by default      |
| `external`                    | 50          | Pulled from an authoritative external source            |
| `analysis_signal` / `derived` | 40          | Computed from data inside the system                    |
| `agent` (bearer)              | 30          | Draft. Unreviewed agent claim. Treat as starting point. |

Promotion thresholds (mirror the spec § Confidence Is Computed):

- **< 30** — basically rejected; don't act on it
- **30 = `draft`** — a single agent prediction with no supporting evidence yet
- **60+ = `established`** — multiple supports / a validates outcome on a hypothesis
- **80+ = `canonical`** — repeated validation; high-trust action OK

**Don't override `confidencePct` in the request body unless you have a defensible reason.** Letting the resolver compute it is the syntropy default; manual overrides undermine the recompute contract. Acting on a draft (≤30) as if canonical is the single biggest entropy source (per `knowledge-syntropy-expert`).

## Mechanics

```bash
# key from environment or the workspace .env.cogni — never a device-specific path
KEY="${COGNI_API_KEY_TEST:?set COGNI_API_KEY_TEST (env or workspace .env.cogni)}"
BASE=https://test.cognidao.org

# 1) Hypothesize — kebab-slug id, ≤4 dash segments, lowercase a-z0-9.
curl -sS -X POST "$BASE/api/v1/edo/hypothesize" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"id\":\"<stem>-h\",\"domain\":\"<registered>\",\"title\":\"...\",\"content\":\"falsifiable claim + what makes it true/false\",\"evaluateAt\":\"<future-iso>\",\"resolutionStrategy\":\"manual\"}"

# 2) Decide — cites hypothesis; in-PR pattern: include source_ref=\"pr:<N>\" in content.
curl -sS -X POST "$BASE/api/v1/edo/decide" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"id\":\"<stem>-d\",\"domain\":\"<same>\",\"title\":\"...\",\"content\":\"per pr:<N>...\",\"derivesFromHypothesisId\":\"<stem>-h\"}"

# 3) Record outcome — validates/invalidates after deploy has had time to run.
curl -sS -X POST "$BASE/api/v1/edo/record-outcome" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"id\":\"<stem>-o\",\"domain\":\"<same>\",\"title\":\"...\",\"content\":\"observed at sha:<deployed>\",\"hypothesisId\":\"<stem>-h\",\"edge\":\"validates\"}"
```

All three responses MUST carry the same `contributionId` + `branch`, with `baseCommit` constant and `headCommit` advancing. Per W2.5: one bearer principal = one open contribution = one review.

## Constraints

- `id` is kebab-slug, ≤4 dash segments, lowercase `[a-z0-9]`.
- `domain` must exist; register via `POST /api/v1/knowledge/domains` (bearer auth works post-W2).
- `evaluateAt` is required for `hypothesize`.
- `sourceType` / `sourceRef` / `sourceNode` are NOT caller-attested — derived from principal.
- One open contribution per bearer principal. New investigation → close prior via `POST /api/v1/knowledge/contributions/<id>/close`.

## Anti-patterns

- Filing EDO for smoke tests, type errors, doc changes — STAY_SILENT applies.
- Filing a hypothesis whose outcome you already know — write nothing.
- Opening a parallel hypothesis on the same prediction instead of citing existing.
- "Write a finding instead" — same syntropy bar applies to findings; either compound or stay silent.
- Setting `confidencePct` manually because draft (30) looked low. The resolver climbs it after `validates` lands.
- Filing `decide` before `hypothesize` exists (adapter rejects via EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE).

## Cross-references

- `knowledge-syntropy-expert` — action hierarchy, REFINE_OVER_EXTEND, RECALL_BEFORE_WRITE.
- `contribute-to-cogni` — PR lifecycle; EDO is orthogonal but often wraps the PR (see § "EDO + PRs" above).
- `docs/spec/knowledge-syntropy.md` § The Hypothesis Loop — schema, invariants, confidence formula.
- `work/projects/proj.knowledge-syntropy.md` — W1 + W2 + W2.5 + R0 ship this surface.
- `dolt-human-visuals` — if your outcome is best rendered as a chart, route through `entryType: html`.
