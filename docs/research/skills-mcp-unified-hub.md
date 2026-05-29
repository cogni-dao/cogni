---
id: skills-mcp-unified-hub
type: research
title: "Unifying agent skills + dolt knowledge behind a 1-URL MCP server"
status: draft
trust: draft
summary: "Cogni maintains 7 parallel agent-harness skill trees (.claude/{skills,commands}, .openclaw/skills, .agents/skills, .clinerules, .cursor, .gemini, .github/prompts) — ~177 files of drifting copies of the same lifecycle commands. Per /knowledge-syntropy-expert review, skills ARE knowledge and belong in dolt (entry_type:skill) with confidence + citations + deprecation lifecycle. Recommendation: purge the 6 non-canonical trees, ingest .claude/skills into dolt as source_type:human, build MVP MCP server so external agents reach skills without monorepo clones, render dolt→.claude/skills via a sync CLI for local Claude Code."
read_when: Designing how external agents discover Cogni skills/knowledge, planning the operator MCP server, deciding whether skills belong in dolt or git, executing the multi-harness purge, or evaluating the Anthropic Skills API pattern adapted to a Dolt-backed substrate.
owner: derekg1729
created: 2026-05-29
verified:
tags:
  [
    skills,
    mcp,
    knowledge,
    dolt,
    agent-onboarding,
    operator,
    anthropic-skills,
    co-location,
  ]
external_refs:
  - spike.5003
---

# Research: Unifying agent skills + dolt knowledge behind a 1-URL MCP server

> spike: spike.5003 | date: 2026-05-29

## Revision history (most recent first — older positions superseded, kept for syntropy doctrine: DEPRECATE_NOT_DELETE)

- **rev 3 (current, syntropy-aligned)** — drove by `/knowledge-syntropy-expert` review. Skills ARE knowledge; they belong in dolt with `confidence_pct` + `citations` + `status` lifecycle + `principal_id` audit. Git becomes a generated cache. MCP server is required, not deferred, because external agents shouldn't need to clone the monorepo. Scope expanded from "3 trees" to **7 harness trees** after inventory: `.claude/{skills,commands}`, `.openclaw/skills`, `.agents/skills`, `.clinerules`, `.cursor`, `.gemini`, `.github/prompts` — ~177 files of drifted parallel copies of the same lifecycle commands. Purge the 6 non-canonical trees.
- **rev 2** (superseded on substrate, partially superseded on scope) — proposed git-canonical + co-located + dolt-indexed + MCP-served. Substrate was wrong: per syntropy doctrine `RECALL_BEFORE_WRITE`, `DEPRECATE_NOT_DELETE`, `ATTRIBUTION_TRACEABLE`, skills can't compound from a git substrate. Scope undercounted drift (treated `.openclaw` as a legitimate category instead of drift artifact; missed 5 other harness trees entirely).
- **rev 1** (superseded) — false-dichotomized "git OR dolt." Recommended git-only.

## Question

Cogni has three filesystem skill trees, no MCP server, knowledge behind REST + bearer. Industry has converged on (a) Anthropic Agent Skills format and (b) one URL → MCP for skills + knowledge (Anthropic's own Skills API, PromptLayer Skill Collections, skillsmp, mcp.run, Mintlify, Inkeep). Design the convergence: where do skills physically live, how do they relate to the dolt knowledge hub, and how does any external agent connect with one line of config?

Three sub-questions:

1. **Substrate**: where is the source of truth for a skill — git, dolt, or both with one canonical?
2. **Layout**: how do we get out of "all skills at `.claude/skills/` root" and co-locate skills with the code they describe, without breaking existing harnesses?
3. **Surface**: what does the 1-URL MCP server actually expose, with what auth?

## Context

### What exists today (verified — full 7-tree inventory)

**The drift surface is much larger than rev 2 surveyed.** Seven parallel harness trees, ~177 skill-like files, all maintaining their own copy of the same lifecycle commands. Drift confirmed by byte counts on `commit`/`research`:

| Tree                     | File count         | Format                                | Status                                                                         | Notes                                                                                                                                |
| ------------------------ | ------------------ | ------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `.claude/skills/`        | 29 (SKILL.md)      | Anthropic SKILL.md + YAML frontmatter | **CANONICAL — keep**                                                           | Auto-loaded by Claude Code relevance                                                                                                 |
| `.claude/commands/`      | 28 (`.md`)         | Plain markdown                        | **KEEP** (Claude Code slash-commands; native, different mechanism than skills) | Drifts internally vs `.claude/skills/research`, etc. (separate cleanup)                                                              |
| `.openclaw/skills/`      | 37 (SKILL.md)      | SKILL.md + `user-invocable: true`     | **PURGE**                                                                      | OpenClaw deprecated (per user); ui-ux-pro-max bytewise dup of `.claude/skills/`                                                      |
| `.agents/skills/`        | 1 (skill-creator)  | SKILL.md                              | **KEEP**                                                                       | Vendored from `anthropics/skills` via `npx skills add`; tracked in `skills-lock.json`; symlinked from `.claude/skills/skill-creator` |
| `.clinerules/workflows/` | 24 (`.md`)         | Cline workflow format                 | **PURGE**                                                                      | Cline not used                                                                                                                       |
| `.cursor/commands/`      | 25 (`.md`)         | Cursor command format                 | **PURGE**                                                                      | Cursor not used                                                                                                                      |
| `.gemini/commands/`      | 26 (`.toml`)       | Gemini TOML format                    | **PURGE**                                                                      | Gemini not used                                                                                                                      |
| `.github/prompts/`       | 23 (`*.prompt.md`) | Copilot prompts                       | **PURGE**                                                                      | Copilot prompt commands not used (the 3-line `.github/copilot-instructions.md` stays)                                                |

**Drift evidence (file sizes for `commit` across trees):**

- 2138 bytes × 4 (identical): `.claude/commands/`, `.clinerules/workflows/`, `.cursor/commands/`, `.github/prompts/`
- 2231 bytes: `.openclaw/skills/commit/SKILL.md` (drift)
- 2239 bytes: `.gemini/commands/commit.toml` (TOML-conversion drift)

**Drift for `research`:** 3506 bytes (×3 identical) / 3837 (.claude/commands drift) / 3936 (openclaw drift) / 3597 (gemini toml). **No single canonical version anywhere.** This is exactly the syntropy doctrine's anti-pattern: "three competing entries on the same topic = no entry."

These trees were authored once and never re-synced. Every commit-flow improvement landed in only one place. Agents now load whichever copy their harness was configured for, which is functionally non-deterministic from a quality standpoint.

**Claude Code skill discovery** walks _into_ subdirectories — `packages/frontend/.claude/skills/` is auto-discovered when editing files under `packages/frontend/`. Has a 15k-char description budget (visible via `/context`). **Co-location is a Claude-Code-native pattern**, not something we have to invent.

**`.claude/skills/` is baked into 3 architectural touchpoints** — renaming has blast radius:

- `nodes/operator/app/src/app/.well-known/agent.json/route.ts:70` — `validationSkill: ".claude/skills/validate-candidate"`
- `.github/workflows/ci.yaml:86,139` — single-node-scope policy whitelist
- `packages/repo-spec/src/accessors.ts` — classifier `startsWith(".claude/skills/")`

**Knowledge hub** (`packages/knowledge-base/src/schema.ts:42-146`, `nodes/operator/packages/doltgres-schema/src/knowledge.ts:38-90`): `domains`, `knowledge` (atomic claims with extensible `entry_type` — no `skill` type today), `citations` DAG, `sources`, plus `knowledge_contributions` + `knowledge_contribution_commits` (branched submissions with provenance). REST surface `/api/v1/knowledge` + `/contributions/*`. Bearer agents write to `contrib/*`; humans merge to main.

**MCP today**: cogni is MCP-consumer-ready (`packages/langgraph-graphs/src/runtime/mcp/client.ts`), MCP-server-stubbed (`nodes/node-template/app/src/mcp/server.stub.ts` throws). Prior research `docs/research/mcp-production-deployment-patterns.md` already settled auth direction (decoupled resource server, RFC 9728/8707).

### What's actually being built in the market (commercial, not strawmen)

| Product                                    | Storage model                                                                                                              | How agents connect                                               | Notes                                                                                                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Anthropic Skills API** (`/v1/skills`)    | **Workspace-scoped registry, materialized to VM filesystem at runtime.** Pre-built skills bundled; custom skills uploaded. | `container: { skills: [{ skill_id, version }] }` in Messages API | **This is the pattern Anthropic itself ships.** DB-backed + filesystem-rendered. claude.ai / API / Claude Code don't sync — three separate stores. Beta headers: `code-execution-2025-08-25`, `skills-2025-10-02`, `files-api-2025-04-14`. |
| **PromptLayer Skill Collections**          | DB-backed, versioned, SDK pulls into `.claude/`/`.agents/`                                                                 | SDK call                                                         | Closest commercial fit to "dolt source of truth, filesystem at runtime".                                                                                                                                                                   |
| **skillsmp.com**                           | Catalog of 1.2M+ SKILL.md, security-scanned                                                                                | MCP server (`skillsmp-mcp-server`) — semantic search + install   | Real and significant.                                                                                                                                                                                                                      |
| **skillhub.club**                          | 7K+ skills mirrored from GitHub (≥2 stars)                                                                                 | Desktop manager                                                  | Git pull-through, not DB.                                                                                                                                                                                                                  |
| **mcp.run**                                | Wasm artifacts in managed registry                                                                                         | Session URL via `MCP_RUN_SESSION_ID`                             | Registry-backed (artifact, not git pull).                                                                                                                                                                                                  |
| **Continue Hub** (`hub.continue.dev`)      | Service-backed registry of assistants/rules/prompts                                                                        | Continue client install                                          | Registry pattern.                                                                                                                                                                                                                          |
| **skillsovermcp.com**                      | **Stateless proxy** — GitHub fetch per request                                                                             | `https://mcp.skillsovermcp.com/mcp/<owner>/<repo>`               | <40ms median fetch; public repos only.                                                                                                                                                                                                     |
| **bobmatnyc/mcp-skillset** (OSS)           | Vector + knowledge-graph hybrid                                                                                            | MCP server                                                       | Only true RAG-over-skills hit in survey.                                                                                                                                                                                                   |
| **Mintlify / Cloudflare AutoRAG / Inkeep** | Their own KB                                                                                                               | One MCP URL → `search_*` + `read_*` tools                        | Docs-as-MCP precedent for the 1-URL UX.                                                                                                                                                                                                    |

**Two storage patterns dominate among the products that actually scaled**: (a) **DB-backed registry + filesystem-rendered at runtime** (Anthropic, PromptLayer, mcp.run), and (b) **stateless git pull-through** (skillsovermcp). The aggregators (skillhub, claudeskills, agentskills.io) are git pull-through. The proxies-as-product (skillsovermcp) are git pull-through. The platforms that authored the category (Anthropic, PromptLayer) chose DB-backed + filesystem render. **Cogni should follow the platforms, not the aggregators.**

> **Note on what I couldn't confirm**: `skillset.dev`, `skills.dev`, `skillsforge.ai` — no live products found. Pieces / PromptHub have no shipped skill-as-MCP play.

### What v1 of this doc got wrong

Stated "git OR dolt" as a binary and rejected dolt as Option B. That was a strawman: I framed Option B as "skills MIGRATE INTO dolt, git copies deleted." The actual interesting design — and the one Anthropic itself ships — is **dual: git is the authoring substrate, dolt is the served/indexed substrate, filesystem is rendered at runtime**. With that frame, Option B and Option A converge.

## Findings

> Findings 2–4 below capture rev-2 reasoning that argued for the git-canonical position. The rev-3 syntropy synthesis (see Recommendation) inverts the substrate conclusion: dolt is canonical, git is the cache. Finding 1 (skills _are_ knowledge) and Finding 5 (1-URL MCP UX with bearer) are reinforced, not superseded. Finding 3 (co-location) is deferred indefinitely — irrelevant once `.claude/skills/` is a generated cache.

### Finding 1 — Skills and knowledge are the same data shape; today they live apart for accidental reasons

A skill is a markdown document with frontmatter (`name`, `description`, optional metadata like `user-invocable`), a body, and possibly referenced assets. A `knowledge` row is a markdown body with structured metadata (`title`, `entry_type`, `tags`, `source_ref`, `source_node`, `confidence_pct`). The only missing piece in the `knowledge` schema for skills is **`entry_type: skill`**, which is just a new value in a free-text column.

Once skills are rows in `knowledge`, everything in the knowledge hub applies to them for free: domains, citations DAG, confidence scores, source provenance, branched contributions, `principal_id` audit, `source_node` filtering, future vector search. This is what the `knowledge-syntropy-expert` skill describes when it talks about "the codified mind" — skills **are** knowledge.

### Finding 2 — Git as write substrate, dolt as read substrate, filesystem as render target

The "git OR dolt" framing dissolves once you separate **authoring**, **storage**, and **runtime delivery**:

- **Authoring**: SKILL.md in git, edited in a PR, reviewed by humans. PRs are the right unit for skill change-management — diff review, comments, blocking on CI. Dolt's branched contribution flow is parallel but **heavier than git PRs** for the typical "fix a typo / clarify wording" case. Keep PRs as the authoring path.
- **Storage / index**: every SKILL.md synced into the `knowledge` table on merge/deploy. Now there's a queryable read surface with all the knowledge-hub enrichment (tags, source_node, confidence, citations).
- **Runtime delivery**: local Claude Code reads filesystem directly (zero-latency, no MCP round-trip for laptops). Remote agents — anywhere — connect to the MCP URL and get the same skill rendered from dolt.

This is **structurally what Anthropic's Skills API does**: skill files exist as git/filesystem on the developer side, get uploaded to a workspace-scoped registry via `/v1/skills`, then materialized into the VM filesystem at runtime when `container.skills` references them. Cogni replicates the pattern with dolt as the registry.

> **What the dolt sync buys us, concretely** — (1) cross-node skill discovery in one query, (2) one MCP URL serves all skills, (3) skills get domains/tags/confidence/citations from day one, (4) agent-authored skill drafts via the existing contribution flow (with human review → merge to git → next sync goes live), (5) future vector search over skills + knowledge unified, (6) external agents don't need filesystem access to Cogni's repo to use our skills.

### Finding 3 — Co-location is a Claude-Code-native pattern, supported today

Claude Code's filesystem walker descends into subdirectories — `nodes/poly/.claude/skills/poly-market-data/SKILL.md` auto-loads when editing under `nodes/poly/`. Cursor uses proximity-resolved `.cursor/rules/*.mdc` similarly. No invention needed; we just have to _use_ this. The right convention:

```
.claude/skills/                       # cross-cutting (lifecycle + universal)
  research/, commit/, validate-candidate/, contribute-to-cogni/, ...
nodes/operator/.claude/skills/        # operator-only expertise
  deploy-operator/, constraint-evaluator/, ...
nodes/poly/.claude/skills/            # poly-only expertise
  poly-market-data/, poly-copy-trading/, delta-minimizer/, ...
```

Of the 29 skills in `.claude/skills/` today, ~15 belong under a node (`poly-*`, `delta-minimizer`, `deploy-operator`, `deploy-node`, `constraint-evaluator`, `engineering-optimizer`, `landing-page`, `node-setup`, `dolt-human-visuals`). The remaining ~14 are genuinely cross-cutting (`contribute-to-cogni`, `validate-candidate`, `promote`, `schema-update`, `test-expert`, `devops-expert`, `git-app-expert`, `database-expert`, `dns-ops`, `grafana-dashboards`, `monitoring-expert`, `ui-ux-pro-max`, `third-party-integrator`, `data-research`). The 37 OpenClaw skills are all lifecycle commands → stay cross-cutting under `.claude/skills/`.

The `.claude/`-baked-into-3-touchpoints constraint matters: don't rename to `.cogni/skills/`. Keep `.claude/skills/` as the directory name at every depth (root + node-level). One convention, multiple roots.

### Finding 4 — One frontmatter schema accommodates both categories

Today `.claude/skills/` uses `name`/`description`; `.openclaw/skills/` adds `user-invocable: true`. Unify on Anthropic's spec + optional Cogni extensions:

```yaml
---
name: research # required (Anthropic)
description: Use when … # required (Anthropic)
user_invocable: true # optional Cogni extension — exposes as MCP Prompt + /command
node: operator # optional Cogni extension — set by sync if path-inferred
scope: cross-cutting | node | package # optional Cogni extension
---
```

`user_invocable: true` → registered as MCP **Prompt** (slash-callable). All skills → searchable via MCP **Tools** (`list_skills`, `get_skill`, `search_skills`). `node` is path-inferred during dolt sync — no need to set it by hand.

### Finding 5 — One MCP URL + existing bearer auth is the right v0 surface

Single config line for any external agent (Claude Code, OpenClaw, Codex, Cursor, future):

```json
{
  "mcpServers": {
    "cogni": {
      "url": "https://cognidao.org/mcp",
      "headers": { "Authorization": "Bearer ${COGNI_API_KEY}" }
    }
  }
}
```

Tools exposed:

- `search_skills(query, node?, user_invocable?)` — semantic+lexical search over skill descriptions
- `list_skills(node?, scope?)` — frontmatter only (L1 progressive disclosure, ~tens of tokens per skill)
- `get_skill(name)` — body + asset paths (L2; L3 files retrievable via separate tool or HTTP)
- `search_knowledge(query, domain?, entry_type?, node?)` — wraps `KnowledgeStorePort`; can include `entry_type: skill`
- `read_knowledge(id)`
- Each `user_invocable: true` skill additionally registered as an MCP **Prompt** so `/research`, `/commit`, etc. work in clients that support MCP Prompts

Auth = existing `cogni_ag_sk_v1_*` bearer. Same audit trail, same per-principal logging. Plan CIMD migration when the MCP client ecosystem catches up; the bearer-only deployment isn't a dead end (Smithery, Composio, Cloudflare AutoRAG all support bearer-in-header alongside their OAuth proxy options).

OAuth 2.1 + PKCE + CIMD becomes mandatory for _public_ remote servers per the late-2025 spec direction; ours is _bearer-protected per-tenant_, which the spec accommodates today via `Authorization` header. If we ever go public-multi-tenant, that's the migration trigger.

## Recommendation (rev 3 — syntropy-aligned)

**Dolt is the canonical substrate. Git becomes a generated cache. MCP is the remote serving surface — required, not deferred, because external agents must not need to clone the monorepo.**

Why this inversion: skills are knowledge. The `/knowledge-syntropy-expert` skill's own decision tree (step 8) classifies "new `.md` file under `docs/`" as the _almost-never_ path, because git-as-substrate fails every knowledge invariant — no `confidence_pct`, no `DEPRECATE_NOT_DELETE` (git rm = history-only), no `principal_id` audit (git author ≠ principal), no `RECALL_BEFORE_WRITE` enforcement, no `REFINE_OVER_EXTEND` enforcement, no cross-node access without monorepo clone. The 7-harness drift today is what happens when knowledge-shaped artifacts live in git: every harness fork drifts, no agent can search across them, no row can be deprecated cleanly, no contributor chain survives.

Skills also evolve independently of code — they get refined as agents and humans learn from running them. Tying skill versioning to git PR ceremony adds an irrelevant tax to knowledge work that the dolt `knowledge_contributions` flow already handles natively (branch → review → merge → principal_id audit preserved).

Concretely:

1. **Purge the 6 non-canonical harness trees.** Delete `.openclaw/`, `.clinerules/`, `.cursor/`, `.gemini/`, `.github/prompts/`. Keep `.claude/skills/` (canonical for now), `.claude/commands/` (Claude Code slash commands — different mechanism, native), `.agents/skills/skill-creator/` (vendored from `anthropics/skills`, npm-managed via `skills-lock.json`), `.github/copilot-instructions.md` (3 lines, points to root AGENTS.md). This is the syntropy doctrine's anti-sprawl rule: "three competing entries on the same topic = no entry."

2. **Add `entry_type: skill` semantics to the existing `knowledge` schema.** Already free-text — no DDL needed. Document the value + the convention.

3. **One-time git → dolt ingest of `.claude/skills/`.** No new `source_type` value needed — use the schema as-is (`packages/knowledge-base/src/schema.ts:79-84`):
   - `source_type: "human"` (these are human-curated knowledge artifacts; using "agent" would understate them; we've been running them in production)
   - `source_ref: ".claude/skills/<name>/SKILL.md"` (the repo path of origin, preserved for traceability + the optional cache-render path)
   - `confidence_pct: 70` (matches schema default for `human` per the comment on line 80)
   - `content: <SKILL.md body>`, `tags: <frontmatter as JSONB>`, `entry_type: "skill"`, `domain` = inferred from skill (e.g. `dev-lifecycle`, `polymarket`, `deployment`)
   - `status: "established"` for currently-active skills

4. **MVP MCP server at `https://cognidao.org/mcp`.** Two tools v0: `get_skill(name)` + `list_skills()`. Bearer auth (`cogni_ag_sk_v1_*`). Single config line for any external agent:

   ```json
   {
     "mcpServers": {
       "cogni": {
         "url": "https://cognidao.org/mcp",
         "headers": { "Authorization": "Bearer ${COGNI_API_KEY}" }
       }
     }
   }
   ```

   This is the minimum to prove the loop. Tools 3–5 (`search_skills`, `search_knowledge`, `read_knowledge`, Prompts) get layered after the v0 loop is real.

5. **`cogni skills sync` CLI for local Claude Code.** Pulls from dolt → writes `.claude/skills/<name>/SKILL.md`. Run via shell init (or on `pnpm install`). The git tree under `.claude/skills/` becomes a generated cache, refreshed from dolt. Initially: optionally checked into git as convenience for newcomers (zero-config); eventually: gitignored once `cogni skills sync` is reliable in onboarding.

6. **(Later) Refinement & atomic decomposition.** Once dolt is the substrate, apply `REFINE_OVER_EXTEND` to skills themselves: a monolithic skill like `poly-market-data` decomposes into a composite entry citing atomic facts (each atomic fact = its own knowledge row with confidence). New facts get added as siblings + citation edges, not by lengthening the skill. Skills compound the same way knowledge does. This is the deep syntropy win; defer until the substrate is in place.

7. **(Later) Agent-authored skill drafts via existing `knowledge_contributions` flow.** `POST /api/v1/knowledge/contributions { entry_type: "skill" }` → branched contribution → human review → merge. Already-existing infra carries the authoring path; no special-casing for skills.

### Why this addresses every previous pushback

- **"What's the point of dolt"** — dolt is the substrate; skills get confidence + citations + deprecation + audit + cross-node search + remote access for free.
- **"External agents shouldn't need to clone the monorepo"** (your stated requirement) — MCP server delivers skills via 1-URL bearer-protected access. No git clone needed.
- **"Skills are AI-generated text that ships refinements independent of code"** — dolt `knowledge_contributions` flow handles this natively; git PR ceremony was the wrong fit.
- **"7-harness drift"** — purge to one canonical (dolt), render to one cache (`.claude/skills/`).
- **"git-import without hacks"** — no new `source_type` needed; use existing `human` + `source_ref` per the schema's existing semantics.
- **"Reference companies"** — Anthropic Skills API (DB-backed registry, VM-rendered), PromptLayer Skill Collections (DB-backed, SDK-pull), mcp.run (Wasm registry), skillsmp.com (catalog + MCP), Continue Hub. The platforms — not the aggregators — chose DB-backed. Cogni follows the platforms.

### Trade-offs accepted

- Dolt becomes runtime-critical for skills, not just knowledge — uptime contract tightens. Mitigation: `cogni skills sync` writes a local cache, so Claude Code on a laptop keeps working through transient dolt outages.
- Bidirectional sync (dolt → git cache; git → dolt on initial ingest only) requires discipline about which side is canonical. Mitigation: dolt is canonical, the git cache is read-only post-ingest, ingest runs once.
- MCP server is unbuilt — this isn't deferrable any more (was deferred in rev 2 / `/review-design`). Acceptable cost given it satisfies the user's stated external-agent requirement and is the syntropy-correct serving surface.
- `.claude/commands/` vs `.claude/skills/` internal drift (overlapping `commit`/`research`/etc. in both) is a separate cleanup — not in scope for this work.

## Open Questions

- **Skill assets (data/, scripts/, templates/)** — discovered during review: `.claude/skills/ui-ux-pro-max/` has 12 CSV data files + 3 Python scripts; `.claude/skills/skill-creator/` has `agents/`, `assets/`, `eval-viewer/`, `references/`, `scripts/`. The rev-3 ingest plan stores only SKILL.md body in `knowledge.content` — assets get left behind. Options: (a) keep assets in git, dolt row references them via path manifest (breaks "no monorepo clone" for asset-bearing skills); (b) base64-encode into a new `assets` JSONB column (heavier rows); (c) separate `skill_assets` table keyed by `(skill_id, path)` with body blob (cleanest); (d) MCP tool `get_skill_asset(name, path)` that streams from the operator backend reading whatever substrate the asset lives on. Likely (c) + (d) for v0. **Skills with assets are ~10% of the set today but include heavy hitters like `ui-ux-pro-max`.**
- **`entry_type` semantic stretch**: existing `entry_type` values (`observation`, `finding`, `conclusion`, `rule`, `scorecard`) all describe atomic-claim shapes. A skill is a _composite procedural artifact_, not a claim shape. Free-text column accepts it, but worth either (a) adding a `composite_kind` column to distinguish atomic-claim vs composite-procedure entries, or (b) documenting that `entry_type: skill` joins `entry_type: guide` / `entry_type: playbook` as a future "composite procedure" family.
- **Sync timing**: on every merge to main (cheap, frequent) vs. on candidate-a deploy (coarser, matches deploy cadence)? Probably both — merge-time updates "main" rows, candidate-a deploy promotes them.
- **Authoring-via-contribution UX**: how does a human-authored skill PR vs. an agent-authored `knowledge_contribution` with `entry_type: skill` interact? They write to the same target row keyed by `source_ref`. We probably want agent contributions to **propose a draft SKILL.md as a PR**, not write directly to dolt — the dolt write becomes the post-merge sync. (This keeps git as the canonical authoring path for both humans and agents.)
- **MCP transport**: streamable-HTTP (correct for our remote use case) — confirm `@modelcontextprotocol/sdk` HTTP transport stability with late-2025 clients. Most current clients still want stdio + `mcp-remote` shim; pin the patched version (CVSS 9.6 RCE fixed in 2025).
- **`.claude/skills/` rename risk**: zero — we don't rename, we just add depth. Existing `agent.json:70` / `ci.yaml:86,139` references continue to work.
- **OpenClaw `extraDirs` glob**: does the upstream OpenClaw codebase support globs in `extraDirs`? If not, a small upstream PR vs. listing each node's path explicitly. Listing is fine until we have many nodes.
- **Skill index storage**: in-memory at MCP server boot (rebuild from dolt query) vs. dolt-indexed (Postgres FTS / pgvector)? Start with in-memory + dolt query; add FTS/pgvector when search quality demands it.
- **Frontmatter migration**: `.openclaw/skills/*` use `user-invocable: true`. New convention is `user_invocable: true` (snake_case to match the rest of our schemas). One-shot rename script.
- **Cross-surface drift**: Anthropic's own warning ("claude.ai / API / Claude Code do NOT sync") is a sharper version of our problem. Our solution = single substrate (dolt) means every surface reads the same data — the failure mode Anthropic warns about doesn't apply.
- **`.well-known/agent.json` advertises `mcpUrl`**: yes, natural fit. Should it advertise a _list_ of MCP URLs (operator-central + per-node)? Defer until per-node MCP exists.
- **Public-vs-private MCP**: today the MCP server is bearer-protected and effectively per-tenant. If we want a _public_ read-only MCP surface (skills are open-source, knowledge is public for certain nodes), that's a separate endpoint and triggers CIMD migration.

## Proposed Layout

> Directional. Captured as prose, not pre-decomposed work items (per project memory on no preemptive decomposition).

### Project

`proj.*` — **"Cogni skills-as-knowledge + MCP serving v0"**. Phases:

1. **Phase 1 — Purge.** Delete `.openclaw/`, `.clinerules/`, `.cursor/`, `.gemini/`, `.github/prompts/`. Keep `.claude/skills/`, `.claude/commands/`, `.agents/skills/skill-creator/`, `.github/copilot-instructions.md`. **Ships with this research PR.** Atomic. Validates the cleanup hypothesis (laptop Claude Code + flow still works) without committing to the new substrate.

2. **Phase 2 — `entry_type: skill` in the knowledge schema.** Free-text column; this is a documentation update + sync convention, not DDL. One PR documents the convention + adds it to `docs/spec/knowledge-syntropy.md`. Domain registry entries for skill-relevant domains (`dev-lifecycle`, `polymarket`, `deployment`, …) if missing.

3. **Phase 3 — One-time git → dolt ingest.** Script walks `.claude/skills/*/SKILL.md` (post-Phase-1 cleanup), upserts to `knowledge` table with `source_type: "human"`, `source_ref: ".claude/skills/<name>/SKILL.md"`, `confidence_pct: 70`, `status: "established"`. Idempotent by `source_ref`. Run once on prod dolt. Verify rows appear.

4. **Phase 4 — MVP MCP server.** Next.js route at `nodes/operator/app/src/app/mcp/route.ts` using `@modelcontextprotocol/sdk` + `mcp-handler` (Vercel adapter). Two tools: `list_skills()`, `get_skill(name)`. Bearer auth via existing `cogni_ag_sk_v1_*`. Smoke-test via `mcp-remote` from a non-monorepo machine — that's the loop-closure proof. No co-location, no Prompts, no `search_skills` in v0.

5. **Phase 5 — `cogni skills sync` CLI.** Pulls from dolt → renders to `.claude/skills/<name>/SKILL.md`. Run on shell init or as a `pnpm install` postscript. Once reliable, gitignore `.claude/skills/` (it becomes a generated cache). Defer the gitignore step until newcomer onboarding is proven.

6. **Phase 6 (deferred) — Search + atomic decomposition.** `search_skills` (Postgres FTS, then pgvector). `REFINE_OVER_EXTEND` applied to skills themselves: monolithic skills decompose into composite + atomic-citation graph. Skills compound like knowledge. Only build when authoring at scale demands it.

7. **Phase 7 (deferred) — Agent-authored skill drafts.** `POST /api/v1/knowledge/contributions { entry_type: "skill" }` already works via the existing branched contribution flow once Phase 2 lands. No special-casing needed; this is just a documentation update of the contribute-to-cogni flow.

### Specs needed

- **Updated**: `docs/spec/knowledge-syntropy.md` — document `entry_type: skill` as a first-class value; clarify that skills compound the same way other knowledge entries do.
- **New (Phase 4)**: `docs/spec/mcp-surface.md` — MCP contract (tools, auth, transport, progressive disclosure invariants).
- **Updated (Phase 5)**: `docs/guides/contribute-to-cogni` (skill) — onboarding rewrite once MCP is live.
- **Cite from**: `docs/research/mcp-production-deployment-patterns.md` (auth direction settled).

### Likely PR-sized tasks (rough sequence, not yet filed)

1. **This PR**: purge 6 non-canonical harness trees + this research doc rev 3. Cleanup hypothesis validated by surviving laptop Claude Code use.
2. Document `entry_type: skill` in `knowledge-syntropy.md` + register relevant domains.
3. One-time ingest script: `.claude/skills/` → dolt `knowledge` rows.
4. Operator MCP route + bearer + `list_skills` + `get_skill`. Smoke-test from non-monorepo machine.
5. `cogni skills sync` CLI + onboarding rewrite.

Tasks 1–4 are critical-path to "external agent reaches skills without monorepo clone." Task 5 closes the local-laptop loop and lets us deprecate filesystem-as-authoring.

### How this fits the existing architecture

- **Hexagonal layering preserved.** MCP server is a new inbound port alongside REST, in the operator app. Tools call existing `KnowledgeStorePort` adapters. Sync is a one-time outbound script (ingest), not an ongoing CI job.
- **No new auth substrate.** Reuses `cogni_ag_sk_v1_*` bearer — same principal_id, same audit trail, same per-env keys.
- **Dolt is the canonical substrate for skills + knowledge.** Git's `.claude/skills/` becomes a generated cache, refreshed from dolt by `cogni skills sync`. Inverts rev 2's "git canonical, dolt indexed" framing — required by the syntropy doctrine.
- **Skills inherit every knowledge-hub property.** `confidence_pct`, `status` (draft → established → deprecated), `citations` DAG, `source_type`/`source_ref`/`source_node`, `tags`, branched contribution flow, principal_id audit. No special-casing.
- **Per-node sovereignty respected** via the `source_node` column. Per-node MCP endpoints remain a v1 option.
- **Drift surface eliminated, not redistributed.** Six harness trees deleted outright. Only `.claude/skills/` (cache) + `.claude/commands/` (Claude Code slash) + `.agents/skills/skill-creator/` (vendored) + `.github/copilot-instructions.md` (single file) remain.
