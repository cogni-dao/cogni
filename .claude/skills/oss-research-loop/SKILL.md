---
name: oss-research-loop
description: One iteration of the OSS-AI research loop — grow the operator hub's `oss-ai` domain by ONE high-quality move per run. Default move is REFINE the capability matrix (`oss-ai-vs-cogni`) and its leaf per-repo finding entries; opening a new repo entry is rare. Pareto bias: focus on infra we actually depend on (litellm, grafana, posthog, langgraph, doltgres) and the most leveraged OSS for AI apps + personal AI assistants. Invoked from a Claude Code `/loop` schedule on Derek's machine in stage 0 (cheap smart models). Triggers: "research OSS for AI", "refresh the capability matrix", "grow oss-ai knowledge", "/loop oss-research-loop". DO NOT use for cataloging arbitrary OSS — that's sprawl. Only for repos that move the AI-app or personal-AI-assistant pareto.
---

# oss-research-loop — one careful iteration per run

> The point is the COMPOUNDING matrix, not the volume of entries. Most loop iterations should sharpen one row of `oss-ai-vs-cogni` and/or refine one leaf. Adding a new repo is the exception, not the default.

## Pareto bar — only repos that pass

Before researching a repo, ask: would dropping this from the matrix degrade an AI-app builder's decisions? If no, **skip**. Specifically:

- Infra we already use → ALWAYS document (`litellm`, `grafana`, `posthog`, `doltgres`, `langgraph`, `temporal`, `next.js`, `drizzle`, etc.)
- High-leverage OSS for personal AI assistants (memory, retrieval, voice, MCP, RAG, agent frameworks) → document if widely adopted + actively maintained
- Niche/obscure → skip. The matrix is for the highest-impact ~50 repos, not a Libraries.io clone.

## Architecture — composite + leaves

Per `knowledge-syntropy-expert`:

- **One composite entry**: `oss-ai-vs-cogni` (`entryType: html`, domain `oss-ai`). A capability matrix where rows are capabilities (LLM gateway, observability, vector store, agent orchestration, ...) and columns are OSS options + a Cogni column. Each cell is a chip linking to a leaf.
- **Many leaf entries**: one `finding` per repo (`entryType: finding`, domain `oss-ai`, id like `oss-litellm` / `oss-langgraph`). Atomic deep-dive: what it does, license (SPDX), maturity signals, when to use, why we use it (or don't).
- **Composite cites leaves** via `supports` citations. Composite confidence inherits from the leaves; a row with 4 high-confidence leaves becomes a strong matrix row.

```
oss-ai-vs-cogni (html composite)
  ├── supports → oss-litellm        (finding)
  ├── supports → oss-langgraph      (finding)
  ├── supports → oss-grafana        (finding)
  ├── supports → oss-posthog        (finding)
  └── supports → oss-mem0           (finding)
```

## Action hierarchy — per loop iteration

Walk top-to-bottom. **Stop at the first action that produces real value. Do NOT do more than one major action per iteration.**

1. **RECALL** — `GET /api/v1/knowledge/contributions?state=merged&limit=50` or browse `/knowledge?domain=oss-ai`. Read the current state of the matrix + at least 5 leaves.
2. **REFINE A LEAF** — pick a per-repo `finding` that is stale (info changed), incomplete (missing license / maturity / use-when), or muddy. `op: update` via the contribution API. **This is the most valuable move.**
3. **REFINE THE MATRIX** — if a leaf's state changed (e.g., maturity went from beta to v1.0, or you discovered we use it more centrally than the row showed), `op: update` the matrix row.
4. **ADD A LEAF** — only if RECALL confirmed a high-pareto repo is missing AND it passes the Pareto bar above. `op: insert` a new `finding`. Same iteration: `op: update` the matrix to reference it.
5. **STOP.** One contribution branch, ≤3 commits, ≤500 net lines. Bigger = sprawl.

## Forbidden in this loop

- **Cataloging obscure repos** (Pareto fail).
- **Opening a new matrix entry** when `oss-ai-vs-cogni` already exists. Refine it.
- **Filing predictions** via `edo-loop` from this skill. EDO is a separate beat; this loop is for refining a knowledge index, not making contestable predictions. If a genuine contestable forecast surfaces, file it via `/edo-loop` separately.
- **Writing prose** in the matrix when a row + chip would do. Use `dolt-human-visuals` patterns.
- **Single iteration > 3 commits.** Stop early. Next loop iteration picks up.

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
