---
name: contribute-knowledge-to-cogni
description: Umbrella skill for contributing durable knowledge to a Cogni node hub. Triggers when an agent has — or is about to research — context worth compounding for future agents/humans, AND the knowledge is durable enough to survive the syntropy bar. Routes to the right sub-skill by content shape (falsifiable prediction → `edo-loop`; visual for humans → `dolt-human-visuals`; AI-readable text → direct contribution). Use whenever you'd otherwise drop a research finding into a chat log or PR description that should outlive the session. RARE by design — most agent context dies with the session; only what compounds earns an entry.
---

# contribute-knowledge-to-cogni — route any knowledge contribution

> Knowledge entries are precious. The right question is rarely "what do I write?" — it's "should I write anything, or refine what already exists?"

## Action hierarchy (mirrors `knowledge-syntropy-expert`)

Walk top-to-bottom. **Most agent work stops at step 1.**

1. **STAY SILENT.** Is this context: ephemeral (dies with session), routine work-item state, an in-PR finding, an obvious factual lookup, OR something an existing entry already says? → **write nothing.** Knowledge entries are precious; sprawl is the failure mode. **≥80% of contributable-feeling moments belong here.**
2. **RECALL.** Use `/knowledge?mode=browse` filtered by domain, or `core__knowledge_search`. Is there an existing entry that already covers your claim? If yes → step 3.
3. **REFINE.** Found a related entry that's slightly off, stale, or bloated? **Sharpen it in place** via a `KnowledgeContributionEdit` `op: update`. Shorter + sharper + raises confidence. **This is the most valuable knowledge move; most contribution work should look like this.**
4. **CITE.** Your claim is a relationship between existing atoms or an example of one? Add a `citation` edge — `supports`, `contradicts`, `extends`, `supersedes`. Or write a sibling atom that cites the parent. Never inline "companion to X" prose.
5. **WRITE ATOMIC.** No existing atom fits AND the claim earns its keep → file new entry. See routing below for which entry type / sub-skill.
6. **EXTEND.** Anti-pattern. Don't bloat an existing atom to cover more cases — write a sibling, cite the parent.

## Routing by content shape

After RECALL confirms a new write is genuinely needed, pick exactly one path:

| Content shape                                                                            | Audience | Entry type                                                                          | Sub-skill                                              |
| ---------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Falsifiable prediction that resolves in a later session and shapes future agent action   | agent    | `hypothesis` / `decision` / `outcome` (atomic chain)                                | [`edo-loop`](../edo-loop/SKILL.md)                     |
| Visual artifact (diagram, scorecard, roadmap, status grid, design diff) for human review | human    | `html` (sandboxed iframe)                                                           | [`dolt-human-visuals`](../dolt-human-visuals/SKILL.md) |
| Atomic factual claim with provenance, recallable by future agent search                  | agent    | `observation` / `finding` / `conclusion` / `rule` / `scorecard` / `skill` / `guide` | direct (this skill)                                    |

**One entry, one shape.** Don't mix — a "scorecard with embedded prediction" is two entries, one cites the other.

Text entry types render their `content` as **GFM markdown** in the human UI (structure it — see "Format the `content` field"). `html` is reserved for visual artifacts markdown can't express.

## Picking the right node

Cogni nodes own niche hubs. Pick by primary subject:

- **operator** (`https://cognidao.org` / `https://test.cognidao.org`) — cross-cutting infrastructure, knowledge platform itself, syntropy, deploy + flight, work-item lifecycle, governance. **Default when in doubt.**
- **poly** (`poly.cognidao.org`) — Polymarket CLOB, copy-trade mirror, wallet provisioning, market-data analytics.
- **resy** (`resy.cognidao.org`) — reservation knowledge.
- Other nodes — see each node's charter.

If a claim is genuinely cross-node (e.g. "Doltgres `WITH RECURSIVE` works at 1k rows"), file once on **operator** and cite from per-node hubs as they need it. Don't duplicate.

## Picking the right domain

`domain` is a registered FK on every entry (DOMAIN_FK_ENFORCED_AT_WRITE). Pick from existing — register a new one ONLY if no existing domain fits and the new one will accumulate ≥5 entries.

Common operator-node domains (seeded): `meta`, `infrastructure`, `prediction-market`, `governance`, `reservations`.

If unsure → use `meta` (knowledge about the knowledge system itself) or the closest existing match. Register new via `POST /api/v1/knowledge/domains` (bearer or session auth, post-W2).

## Mechanics — direct text path

For text entry types (`observation`/`finding`/`conclusion`/`rule`/`scorecard`/`skill`/`guide`). For `html` use `dolt-human-visuals`; for EDO chains use `edo-loop`.

```bash
KEY=$(grep -E "^COGNI_API_KEY_TEST=" /Users/derek/dev/cogni-template/.env.cogni | cut -d= -f2- | tr -d "\"")
BASE=https://test.cognidao.org   # or production cognidao.org

curl -sS -X POST "$BASE/api/v1/knowledge/contributions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{
    \"message\": \"<one-line intent>\",
    \"edits\": [{
      \"op\": \"insert\",
      \"entry\": {
        \"id\": \"<kebab-slug, ≤4 dash segments>\",
        \"domain\": \"<registered>\",
        \"title\": \"<use-when-X framing>\",
        \"content\": \"<atomic claim with provenance>\",
        \"entryType\": \"finding\",
        \"tags\": [\"<short>\", \"<discoverable>\"]
      }
    }]
  }"
```

Response: `{ contributionId, branch: "contrib/<id>", state: "open", ... }`. Lands in `/knowledge?mode=inbox` for session-cookie merge.

**Refining existing — same endpoint, `op: "update"`:**

```bash
# In edits: {"op": "update", "targetRowId": "<existing-id>", "entry": { ... refined fields ... }}
```

**Compounds onto your one open contribution** (per-principal — W2.5 behaviour applies here too). Submit multiple edits in one POST when they belong together (one merge review for a coherent unit of work).

## Format the `content` field as Markdown

The human UI renders `content` for text entries through `<Markdown>` (GFM: headings, **bold**, lists, tables, `code`, links). The same bytes stay plain-text for AI search + embeddings. **One source of truth, both audiences** — so write structured markdown, not a prose blob. A wall of prose renders as a wall of prose; it's the failure mode in most existing entries.

Lead with a **`use-when` / claim line in bold**, then structure the evidence. Reach for a table when you have ≥2 parallel facts.

**❌ Prose blob — unscannable, renders identically to its raw source:**

```
We found that the Doltgres adapter cannot use postgres.js extended protocol
because prepared statements break on Doltgres, so the adapter uses sql.unsafe()
with manual escapeValue and JSONB containment operators like @> and ILIKE are
not supported which means queries must avoid them.
```

**✅ Structured markdown — same claim, scannable, renders as formatted HTML:**

```markdown
**Use when:** writing a query adapter against Doltgres.

Doltgres breaks `postgres.js` **extended protocol** (prepared statements fail),
so the adapter routes around it:

| Constraint                | Workaround                              |
| ------------------------- | --------------------------------------- |
| No prepared statements    | `sql.unsafe()` + manual `escapeValue()` |
| No JSONB `@>` containment | rewrite as key extraction               |
| No `ILIKE`                | `LOWER(col) LIKE`                       |

Source: `spike.0229` — 13 integration tests passing.
```

A `scorecard` entry is a markdown table of `dimension | us | optimal | gap` rows. A `rule` is a bold imperative + a short rationale list. A `guide` is `##` sections with fenced commands. Keep it atomic — structure sharpens one claim; it is **not** license to lengthen.

**Markdown text vs `html` entry.** Markdown covers ~all knowledge: headings, tables, lists, code. Reach for an `html` entry (via [`dolt-human-visuals`](../dolt-human-visuals/SKILL.md)) **only** when the artifact is genuinely visual — an SVG architecture diagram, a chart, a status grid markdown can't express. Default is markdown text; `html` is the rare escape hatch, not "anything a human reads." Raw HTML is **not** rendered in the markdown lane (it's escaped) — full HTML only runs in the sandboxed-iframe `html` path.

## Confidence — what you set vs what the system computes

Don't set `confidencePct` on the request unless you have a defensible reason. Initial confidence comes from your principal's `sourceType` (agent=30 = draft; human=70). Recompute raises it as citation evidence lands. Manual overrides undermine the recompute contract — let the resolver do its job.

## When to invoke this skill

- Before opening any `core__knowledge_write` tool call
- Before posting to `/api/v1/knowledge/contributions` directly
- When tempted to "just write it in the PR description" but the claim is reusable
- When tempted to write a doc under `docs/spec/knowledge-*` — almost never the right home; refine an existing knowledge entry or write a new atomic one in the hub

## Anti-patterns

- Filing a new entry when RECALL would surface an existing match
- Writing a `content` prose blob instead of structured markdown (headings / bold lead / table / list) — renders as an unscannable wall; see "Format the `content` field"
- Reaching for `html` for ordinary human-facing content that a markdown table or list expresses fine — `html` is the rare visual escape hatch (SVG / chart), not the default for "a human reads it"
- Filing a falsifiable prediction as `finding` to avoid EDO overhead — use `edo-loop` or stay silent
- Authoring a genuinely visual artifact (diagram, chart) as plain text (loses the styling contract from `knowledge-html-style.md`)
- Setting `confidencePct` manually because the draft (30) looked low
- Duplicating cross-node — file once, cite from other nodes

## Cross-references

- `knowledge-syntropy-expert` — action hierarchy + REFINE_OVER_EXTEND + RECALL_BEFORE_WRITE
- `edo-loop` — falsifiable predictions
- `dolt-human-visuals` — HTML entries for human review
- `contribute-to-cogni` — separate skill for **code** contributions (PRs); this skill is for **knowledge** contributions
- `docs/spec/knowledge-syntropy.md` — schema, invariants, write/read protocol
- `docs/spec/knowledge-html-style.md` — tokens + utility classes for `entryType: html`
- `docs/design/knowledge-contribution-api.md` — full request/response envelope contract
