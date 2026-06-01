---
name: oss-research-loop
description: One iteration of the OSS-AI research loop on the operator knowledge hub (domain oss-ai). The job is to DISCOVER the frontier — OSS for AI apps + personal AI assistants that Cogni does NOT already run — and deepen open research questions with cited, real repos. NOT to document our own stack (that already exists: the oss-ai-vs-cogni matrix + the oss-infra-cogni block). RECALL is mandatory and first. Most iterations REFINE an existing entry; new entries are rare and must pass the frontier bar. Triggers: "research OSS for AI", "deepen the oss-ai questions", "/loop oss-research-loop". Invoked from a local Claude Code /loop (with the prod key available) or a remote routine with COGNI_API_KEY_PROD set. Prove the prompt with a few manual iterations before automating it.
---

# oss-research-loop — discover the frontier, do not inventory the stack

> A prior loop violated this and got closed: it wrote 9 leaves for infra we already run, all redundant with the matrix + oss-infra-cogni block. RECALL first, every time. If main already knows it, STOP.

## Hard gate 0 — RECALL_BEFORE_WRITE (mandatory first action, no exceptions)

Before composing ANY write, run these reads and actually digest them:

```bash
# COGNI_API_KEY_PROD comes from the environment (remote routine secret) or the
# workspace .env.cogni (local). Never hardcode an absolute path or the key itself.
KEY="${COGNI_API_KEY_PROD:?set COGNI_API_KEY_PROD (env or workspace .env.cogni)}"
BASE=https://cognidao.org

# (a) what is ALREADY on main / merged — do not recreate any of it
curl -sS "$BASE/api/v1/knowledge/contributions?state=merged&limit=40" -H "Authorization: Bearer $KEY"
# (b) what was ALREADY REJECTED — read every closedReason; do not reintroduce killed sprawl
curl -sS "$BASE/api/v1/knowledge/contributions?state=closed&limit=40" -H "Authorization: Bearer $KEY"
```

The live reads above are the source of truth — re-derive current state from them every run. As of this writing the canonical entries you must NOT duplicate are: `oss-ai-vs-cogni` (the capability matrix — large, already carries SPDX licenses + every infra repo we run), `oss-infra-cogni` (consolidated "infra we use" block), and two OPEN research questions `oss-cicd-agents` + `oss-multitenant-agents`. Trust the reads over this list; the hub grows.

If what you were about to write is already covered by the matrix or oss-infra-cogni → **STOP, write nothing, report "already on main".** That is a successful iteration, not a failure.

## What this loop is FOR (frontier, not inventory)

Cogni already documented its own stack. The valuable, sellable knowledge is **what an AI-app builder should use that we do NOT run** — and answers to the open research questions. Each iteration, in priority order:

1. **DEEPEN an open research question** (`oss-cicd-agents`, `oss-multitenant-agents`, or a future one) via `op:update` — add concrete, real, _frontier_ repos (ones we do NOT use), each with SPDX license + maturity + the specific tradeoff. This is the most valuable move.
2. **REFINE the matrix** (`op:update` on oss-ai-vs-cogni) when a row's frontier options are stale or a new credible OSS option emerged in a capability we do NOT yet own.
3. **ADD a new research question** (atomic `finding`, Q+A shape) only when you've identified a real gap an AI-app builder would pay to have answered, and no existing question covers it.
4. **STOP.** If none of the above has real frontier signal this iteration, write nothing and say "no high-value move."

**Forbidden:** adding a per-repo leaf for anything already named in the matrix or oss-infra-cogni (litellm, langgraph, doltgres, grafana, loki, posthog, temporal, langfuse, next-auth, x402, pgvector, postgres, …). That is the sprawl that got the last thread closed.

## Frontier bar — what earns a write

A repo/answer earns a place only if ALL hold:

- **We do NOT already run it** (else it's in oss-infra-cogni — STOP).
- **An AI-app or personal-AI-assistant builder would weigh it in a real decision.**
- **Grounded in real data** — actual repo, real SPDX license, real maturity signal. NO hallucinated project names or licenses. If you cannot verify the license, say "license unverified" rather than guessing.

Examples that PASS (frontier we don't run): mem0 / letta / zep (agent memory), openhands / aider (OSS code agents), ollama / llama.cpp (local serving), open-webui / librechat (assistant UIs), qdrant / lancedb (vector stores we don't use), inngest (workflow alt). Each is a candidate ONLY if it sharpens an open question or a not-yet-owned matrix row.

Examples that FAIL: anything in our stack; a 10th synonym of an existing entry; a prediction (that's `edo-loop`, not this).

## Anti-sprawl mechanics (compounding, one thread)

- Append to ONE open thread via `POST $BASE/api/v1/knowledge/contributions/<id>/commits`. NEVER re-POST the root `/contributions` endpoint (spawns a new branch = sprawl).
- Find your thread: list open contributions, match message prefix `oss-research-loop:`. If none open, create exactly one with that prefix (root POST, once), then append forever after.
- `op:update` to refine existing rows is strongly preferred over `op:insert`. REFINE_OVER_EXTEND.
- Title gate: no `—`, `·`, `--` separators. id = kebab-slug ≤4 segments.
- Do NOT set `confidencePct` (the resolver computes it). Do NOT merge (human-gated). Do NOT run pnpm/tests/builds or open code PRs.
- Cap: one append commit per iteration. Quality over volume.

## Where entries live

- Operator hub, domain `oss-ai`, on prod (`cognidao.org`). Writes land on `contrib/*` branches; a session-cookie human merges. The hub migrates to a dedicated oss-advisor node (Dolt fork) when `services/oss-advisor/` ships — do not block on that.

## Cross-references

- `knowledge-syntropy-expert` — RECALL_BEFORE_WRITE + REFINE_OVER_EXTEND + anti-sprawl (this skill is a strict application).
- `contribute-knowledge-to-cogni` — the general router; this is the oss-ai specialization.
- `dolt-human-visuals` — matrix HTML style (tokens + .cogni-\* classes).
- `edo-loop` — for contestable _predictions_ (separate beat; not used here).
- `work/projects/proj.oss-research-node.md` — the meta roadmap.
