---
name: oss-research-loop
description: One iteration of the OSS-AI research loop — grow the operator hub's `oss-ai` domain by ONE high-quality move per run. By default the agent REFINES an existing entry backed by a cited source — it does not create new entries; opening a new repo entry is the rare, justified exception. Pareto bias: focus on infra we actually depend on (litellm, grafana, posthog, langgraph, doltgres) and the most leveraged OSS for AI apps + personal AI assistants. Invoked from a Claude Code `/loop` schedule on Derek's machine in stage 0 (cheap smart models). Triggers: "research OSS for AI", "refresh the capability matrix", "grow oss-ai knowledge", "/loop oss-research-loop". DO NOT use for cataloging arbitrary OSS — that's sprawl. Only for repos that move the AI-app or personal-AI-assistant pareto.
---

# oss-research-loop — one careful iteration per run

> The point is the COMPOUNDING matrix, not the volume of entries. **By default an agent REFINES an existing entry and proves the change with a cited source — it does not create new entries.** Adding is the rare exception. A run that sharpens one entry with evidence is worth more than a run that adds three shallow drafts. If you finish an iteration having only created new rows, you have produced sprawl, not syntropy.

## Pareto bar — only repos that pass

Before researching a repo, ask: would dropping this from the matrix degrade an AI-app builder's decisions? If no, **skip**. Specifically:

- Infra we already use → ALWAYS document (`litellm`, `grafana`, `posthog`, `doltgres`, `langgraph`, `temporal`, `next.js`, `drizzle`, etc.)
- High-leverage OSS for personal AI assistants (memory, retrieval, voice, MCP, RAG, agent frameworks) → document if widely adopted + actively maintained
- Niche/obscure → skip. The matrix is for the highest-impact ~50 repos, not a Libraries.io clone.

## Architecture — composite + leaves

Per `knowledge-syntropy-expert`:

- **One composite entry**: `oss-ai-vs-cogni` (`entryType: html`, domain `oss-ai`). A capability matrix where rows are capabilities (LLM gateway, observability, vector store, agent orchestration, ...) and columns are OSS options + a Cogni column. Each cell is a chip linking to a leaf.
- **Many leaf entries**: one `finding` per repo (`entryType: finding`, domain `oss-ai`, id like `oss-litellm` / `oss-langgraph`). Atomic deep-dive: what it does, license (SPDX), maturity signals, when to use, why we use it (or don't).
- **Reality check on confidence:** the contribution edit API exposes only `insert` / `update` / `deprecate` — there is **no agent-facing `supports`/citation op**. Agents cannot create citation edges, so confidence does NOT compound by adding leaves; new entries sit at draft (~30) until a human/resolver acts. The only lever an agent has on quality is **proven, verifiable content inside the entry itself.** That is why refine-with-proof is the default, not add.

```
oss-ai-vs-cogni (html composite)
  ├── supports → oss-litellm        (finding)
  ├── supports → oss-langgraph      (finding)
  ├── supports → oss-grafana        (finding)
  ├── supports → oss-posthog        (finding)
  └── supports → oss-mem0           (finding)
```

## Action hierarchy — per loop iteration

**Default: REFINE an existing entry, backed by proof. Creating a new entry is the rare exception.** Do at most ONE move per iteration; stop at the first that produces real, *proven* value.

1. **RECALL (mandatory first step)** — read the current matrix + every existing `oss-ai` leaf (via the contribution diff or `/knowledge`). You cannot refine or add without knowing what already exists. In your commit message, name the exact entry you are improving and why.
2. **REFINE — the default move, ~every iteration.** Pick the entry whose improvement most increases the matrix's value: a stale fact, a missing license/maturity/gotcha, a muddy cell, an unproven claim. `op: update`. **Every refine must carry proof (see Proof bar) and state the before→after delta.** A refine with no delta and no new evidence is churn — don't do it.
3. **ADD — exceptional, justify it.** Permitted ONLY when all three hold: (a) RECALL proved no existing entry can absorb the knowledge, (b) the repo clears the Pareto bar, (c) you can cite proof for every field. Prefer folding new infra into an existing block (e.g. one "infra we run" leaf) over spawning one entry per repo. If you add, the commit message must say why refinement was impossible.
4. **STOP** when the open branch is one coherent, reviewable, *proven* theme a human merges in a single pass. Fewer, sharper, cited entries compound; piles of fresh draft entries devolve. Proof and quality — never entry count — is the bar.

## Proof bar — no write without evidence

Every `insert` or `update` must be backed by a verifiable source, cited inline in the entry **and** named in the commit message:

- Facts (license, stars, version, maturity, last commit) → cite source + retrieval date, e.g. `stars: ~48.8k (github.com/BerriAI/litellm, 2026-05-30)`. Mark approximate figures as approximate; never present a summarizer's star count as exact.
- "Why we use it" / integration claims → cite the repo path, spec, or prior knowledge entry that proves it, e.g. `adapter: packages/.../contribution-adapter.ts`.
- If you cannot prove a claim, **soften it or cut it** — do not ship it at draft confidence and move on.

Confidence compounds when claims become more verifiable, not when entry count goes up. An iteration with no new evidence produced nothing — end it without a write rather than churning wording to look busy.

## Forbidden in this loop

- **Creating a new entry when an existing one could absorb the knowledge.** Refine first; add only after proving you can't.
- **Shipping an unproven claim**, or churning wording with no new evidence and no before→after delta.
- **Cataloging obscure repos** (Pareto fail).
- **Opening a new matrix entry** when `oss-ai-vs-cogni` already exists. Refine it.
- **Filing predictions** via `edo-loop` from this skill. EDO is a separate beat; this loop is for refining a knowledge index, not making contestable predictions. If a genuine contestable forecast surfaces, file it via `/edo-loop` separately.
- **Writing prose** in the matrix when a row + chip would do. Use `dolt-human-visuals` patterns.
- **Letting a branch sprawl past one reviewable theme.** Many tight, single-theme branches compound; one giant unreviewable branch devolves. Split themes, don't stack them.

## Mechanics

```bash
KEY=$(grep -E "^COGNI_API_KEY_PROD=" /Users/derek/dev/cogni-template/.env.cogni | cut -d= -f2- | tr -d "\"")
BASE=https://cognidao.org

# Read existing matrix + leaves
curl -sS "$BASE/api/v1/knowledge?domain=oss-ai" -H "Authorization: Bearer $KEY"

# Refine a leaf (preferred)
curl -sS -X POST "$BASE/api/v1/knowledge/contributions/<your-open-id>/commits" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"message\":\"refine oss-litellm with v1.85 + sponsor info\",\"edits\":[{\"op\":\"update\",\"targetRowId\":\"oss-litellm\",\"entry\":{...}}]}"

# Add a leaf (rare) + update matrix in same commit set
curl -sS -X POST "$BASE/api/v1/knowledge/contributions/<your-open-id>/commits" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"message\":\"add oss-mem0 + reference from matrix\",\"edits\":[{\"op\":\"insert\",\"entry\":{...}},{\"op\":\"update\",\"targetRowId\":\"oss-ai-vs-cogni\",\"entry\":{...}}]}"
```

Per W2.5: subsequent calls in the same session auto-compound onto your one open contribution. Derek (or any session-cookie user) reviews + merges in `/knowledge?mode=inbox`.

## Leaf entry shape (`finding` template)

```json
{
  "id": "oss-<short-slug>",
  "domain": "oss-ai",
  "title": "<repo-name> — <one-line of what it does>",
  "content": "license: <SPDX> · stars: <n> (as of <ISO>) · last commit: <ISO> · primary lang: <lang>\n\nuse-when: <one paragraph>\nintegration notes: <one paragraph if we use it; else skip>\nalternatives: see oss-ai-vs-cogni",
  "entryType": "finding",
  "tags": ["<capability-row>", "<license-class>", "<maturity-tag>"]
}
```

## Confidence — let the resolver do its job

Don't set `confidencePct` manually. Agent draft starts at 30. Each `supports` citation from the matrix to a leaf bumps the leaf (+10 cap 50). Each `contradicts` (e.g., "this repo was archived") drops confidence (−15). The matrix's confidence inherits from its leaves — strong leaves = strong matrix row.

## Cross-references

- `contribute-knowledge-to-cogni` — router skill; this one is the OSS-specific specialization.
- `dolt-human-visuals` — the matrix HTML uses `.cogni-*` classes + token-only colors per `docs/spec/knowledge-html-style.md`.
- `knowledge-syntropy-expert` — action hierarchy + REFINE_OVER_EXTEND; this loop is a direct application of those principles.
- `edo-loop` — separate beat for contestable predictions; not used here.
- `work/projects/proj.oss-research-node.md` — the meta project (roadmap). Knowledge entries live in the operator hub for now per the bootstrap plan; migrates to a dedicated node when the `services/oss-advisor/` ships.
