---
name: contribute-knowledge-to-cogni
description: Umbrella skill for contributing durable knowledge to a Cogni node hub. Triggers when an agent has — or is about to research — context worth compounding for future agents/humans, AND the knowledge is durable enough to survive the syntropy bar. Routes to the right sub-skill by content shape (falsifiable prediction → `edo-loop`; visual for humans → `dolt-human-visuals`; AI-readable text → direct contribution). Use whenever you'd otherwise drop a research finding into a chat log or PR description that should outlive the session. RARE by design — most agent context dies with the session; only what compounds earns an entry.
---

# contribute-knowledge-to-cogni — route any knowledge contribution

> Knowledge entries are precious. The right question is rarely "what do I write?" — it's "should I write anything, or refine what already exists?"

## ONE PRINCIPAL · ONE OPEN CONTRIBUTION · refine via `/commits` — never fork

This is the rule the rest of the skill hangs on. Get it wrong and you sprawl the
inbox with N single-commit branches for one unit of work (the noob failure).

- **One principal.** Reuse your saved API key. Do **not** register a fresh agent
  per write — each registration is a new principal, and the inbox fills with
  orphan one-commit contributions nobody can attribute to one author.
- **One open contribution at a time.** A principal holds a single open
  `contrib/*` branch. Everything you contribute this session lands on it.
- **First write creates the branch; every write after that appends.**
  `POST /contributions` **always forks a new branch** — call it exactly once.
  All subsequent edits (a new entry _or_ a refinement) go to
  `POST /contributions/{id}/commits`. Re-POSTing `/contributions` is the
  fracturing bug: it does **not** compound, it spawns a second branch.
- **Start something genuinely unrelated?** Close the current one first
  (`POST /contributions/{id}/close`), then create. Don't run two open branches.

> Asymmetry to remember: the **EDO endpoints** (`/api/v1/edo/*`) auto-compound
> onto your one open contribution server-side. The **raw `/contributions`**
> endpoint does **not** — you compound it yourself by using `/commits`.

## Action hierarchy (mirrors `knowledge-syntropy-expert`)

Walk top-to-bottom. **Most agent work stops at step 1.**

1. **STAY SILENT.** Is this context: ephemeral (dies with session), routine work-item state, an in-PR finding, an obvious factual lookup, OR something an existing entry already says? → **write nothing.** Knowledge entries are precious; sprawl is the failure mode. **≥80% of contributable-feeling moments belong here.**
2. **RECALL — both planes.** (a) The **merged** plane: `/knowledge?mode=browse` filtered by domain, or `core__knowledge_search`. (b) **Your own open contribution _branch_**: `GET /contributions?state=open` for the id, then **`GET /contributions/{id}/diff` to read the entries already on it.** Branch-local entries do **not** appear in `/knowledge?domain=` (it returns merged-`main` only) — so an agent who recalls the merged plane alone will re-discover, re-author, or outright deny knowledge it wrote minutes ago on its own branch. Read the branch before you write or before you answer "does X exist / is it linked." Cite the siblings you find; append rather than fork.
3. **REFINE.** Found a related entry that's slightly off, stale, or bloated? **Sharpen it in place** via an `op: update` edit. Shorter + sharper + raises confidence. **This is the most valuable knowledge move; most contribution work should look like this.**
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

**One entry, one shape.** Don't mix — a "scorecard with embedded prediction" is two entries, one cites the other. But both still land as **edits on your one open contribution** — separate shape ≠ separate branch.

## EDO vs knowledge entry vs spec — what truth goes where

Three durable homes. Pick by the _shape of the truth_, not by which is easiest.

| You have…                                                                                                                            | Home                                                                       | Why                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| As-built fact about how the system works **right now** — architecture, a contract, an invariant a future agent needs as ground truth | **`docs/spec/*` in the repo** (refine an existing spec; ship it in the PR) | `SPECS_ARE_AS_BUILT`. Versioned with the code, reviewed in the PR that makes it true. Not in the hub. |
| Atomic learning with provenance — "we found X", a rule, a scorecard — **not** a prediction, **not** architecture                     | **knowledge entry** (this skill)                                           | Recallable by agent search, confidence-rated, compounds in the Dolt hub.                              |
| Falsifiable **prediction** that resolves in a **later** session, is contestable, and changes what the next agent does                | **EDO chain** ([`edo-loop`](../edo-loop/SKILL.md))                         | Time-bound belief → action → outcome; confidence recomputes when the outcome lands.                   |

**EDO linked to a spec** — when your prediction is _about_ a spec'd subsystem:

- The **spec** stays the as-built description (what the system does).
- The **EDO** carries the time-bound belief (whether a change moves a metric).
- Wire them, don't merge them: `hypothesize.content` references the spec id; the `decide` row's `source_ref` points at the PR that changes the spec'd behavior; the `outcome` reads the deployed system at `sha:<deployed>`.
- Don't fold the prediction into the spec (specs aren't predictions). Don't restate the spec inside the EDO (cite it).

Tie-breakers:

- Tempted to write a `docs/spec/knowledge-*` doc for a one-off learning? Almost always wrong — refine a hub entry. Specs are for durable as-built contracts, not findings.
- Tempted to file a `finding` for a prediction because EDO feels heavy? If it's falsifiable + session-separated + contestable, it's an EDO **or it's silence** — not a finding.

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

For text entry types (`observation`/`finding`/`conclusion`/`rule`/`scorecard`/`skill`/`guide`). For `html` use `dolt-human-visuals`; for EDO chains use `edo-loop`. Full envelope contract: [`docs/design/knowledge-contribution-api.md`](../../../docs/design/knowledge-contribution-api.md).

```bash
KEY=$(grep -E "^COGNI_API_KEY_TEST=" .env.cogni | cut -d= -f2- | tr -d "\"")   # reuse your ONE key
BASE=https://test.cognidao.org   # or production cognidao.org
```

**Step 1 — recall your open contribution AND read what's already on its branch:**

```bash
CID=$(curl -sS "$BASE/api/v1/knowledge/contributions?state=open&limit=20" \
  -H "Authorization: Bearer $KEY" | jq -r '.contributions[0].contributionId // empty')

# MANDATORY when CID exists: read the entries already on YOUR branch. These are
# NOT in /knowledge?domain= (merged-main only) — skip this and you'll re-author
# or deny knowledge you wrote this session. Cite/refine these siblings.
[ -n "$CID" ] && curl -sS "$BASE/api/v1/knowledge/contributions/$CID/diff" \
  -H "Authorization: Bearer $KEY" | jq -r '.entries[] | "\(.rowId): \((.after // .before).title)"'
```

**Step 2 — only if you have none open, create ONCE and capture the id:**

```bash
CID=$(curl -sS -X POST "$BASE/api/v1/knowledge/contributions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "message": "<one-line intent for this unit of work>",
    "edits": [{
      "op": "insert",
      "entry": {
        "id": "<kebab-slug, ≤4 dash segments>",
        "domain": "<registered>",
        "title": "<use-when-X framing>",
        "content": "<atomic claim with provenance>",
        "entryType": "finding",
        "tags": ["<short>", "<discoverable>"]
      }
    }]
  }' | jq -r .contributionId)
```

**Step 3 — every further edit appends to that SAME branch via `/commits`:**

```bash
# Add another atom, refine a row you created earlier on this branch, or deprecate —
# all on the open contribution. NEVER POST /contributions again for this work.
curl -sS -X POST "$BASE/api/v1/knowledge/contributions/$CID/commits" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "message": "append: <what this commit changes>",
    "edits": [{ "op": "insert", "entry": { ... } }]
  }'
```

One POST can carry a **mixed-op batch** (`insert` + `update` + `deprecate`, up to 50) in a single commit when the changes belong together — that's one review for one coherent unit, not N branches.

**Two distinct "refine" cases — don't conflate them:**

| You want to refine…                             | How                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| a row you wrote earlier **on your open branch** | `POST /contributions/{id}/commits` with `{op:"update", targetRowId, entry}` — `targetRowId` resolves on the branch |
| an entry **already merged to `main`**           | `POST /contributions` once with `{op:"update", targetRowId:<main id>}`, then keep refining **that** via `/commits` |

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

- **Re-POSTing `/contributions` for related work instead of appending via `/commits`** — the fracturing failure: N single-commit branches for one unit of work (and an inbox no human wants to triage).
- **Recalling the merged plane only — never reading your own open branch.** `/knowledge?domain=` returns merged-`main`; your `contrib/*` branch entries are invisible to it. Answering "does X exist / is it linked" or deciding to write _without_ `GET /contributions/{id}/diff` is how an agent denies or duplicates knowledge it authored minutes ago (the exact failure that prompted this rule).
- **Registering a fresh agent key per contribution** — multiplies principals; reuse your one saved key.
- Filing a new entry when RECALL would surface an existing match
- Writing a `content` prose blob instead of structured markdown (headings / bold lead / table / list) — renders as an unscannable wall; see "Format the `content` field"
- Reaching for `html` for ordinary human-facing content that a markdown table or list expresses fine — `html` is the rare visual escape hatch (SVG / chart), not the default for "a human reads it"
- Filing a falsifiable prediction as `finding` to avoid EDO overhead — use `edo-loop` or stay silent
- Authoring a genuinely visual artifact (diagram, chart) as plain text (loses the styling contract from `knowledge-html-style.md`)
- Putting a one-off learning in `docs/spec/*` — specs are durable as-built contracts, not findings
- Setting `confidencePct` manually because the draft (30) looked low
- Duplicating cross-node — file once, cite from other nodes

## Cross-references

- `knowledge-syntropy-expert` — action hierarchy + REFINE_OVER_EXTEND + RECALL_BEFORE_WRITE
- `edo-loop` — falsifiable predictions (auto-compounds onto your one open contribution)
- `dolt-human-visuals` — HTML entries for human review
- `contribute-to-cogni` — separate skill for **code** contributions (PRs); this skill is for **knowledge** contributions
- `docs/spec/knowledge-syntropy.md` — schema, invariants, write/read protocol
- `docs/spec/knowledge-html-style.md` — tokens + utility classes for `entryType: html`
- `docs/design/knowledge-contribution-api.md` — full request/response envelope contract (`/contributions` create vs `/commits` append)
