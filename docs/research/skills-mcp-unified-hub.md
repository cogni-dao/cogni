---
id: skills-mcp-unified-hub
type: research
title: "Unifying agent skills + dolt knowledge behind a 1-URL MCP server"
status: draft
trust: draft
summary: "How to converge Cogni's scattered filesystem skills (.claude/skills, .openclaw/skills) and the per-node dolt knowledge hub into a single MCP surface that any external agent (Claude Code, OpenClaw, Codex, Cursor) can connect to with one URL — modeled on Anthropic Agent Skills + Smithery/mcp.run/Mintlify patterns."
read_when: Designing how external agents discover Cogni skills/knowledge, planning the operator MCP server, deciding whether skills move into dolt, or evaluating Anthropic Agent Skills adoption.
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
  ]
external_refs:
  - spike.5003
---

# Research: Unifying agent skills + dolt knowledge behind a 1-URL MCP server

> spike: spike.5003 | date: 2026-05-29

## Question

Can Cogni converge two things that live in separate places today — (a) filesystem skills under `.claude/skills/` and `.openclaw/skills/` and (b) the per-node dolt knowledge hub behind `/api/v1/knowledge` — into a single MCP surface, so any external agent (Claude Code, OpenClaw, Codex, Cursor) onboards with one URL + one bearer token and immediately has context-efficient discovery + on-demand "activation" of skills and knowledge? Industry has converged on a clear pattern (Anthropic Agent Skills + filesystem progressive disclosure, exposed as MCP). We want to ride the standard, not invent a parallel one.

## Context

### What exists today

**Skills are filesystem, per-repo, not centralized.**

- `.claude/skills/` — ~31 Claude Code skills consumed by the Claude Code harness via filesystem convention (no manifest; the harness enumerates `<name>/SKILL.md` and reads YAML frontmatter `name` + `description`).
- `.openclaw/skills/` — ~40 OpenClaw skills, parallel tree. Activation = full file injected into the agent's system prompt before each request (the user's "open and read the file").
- `.agents/skills/` — shared skill-creator + evals bootstrap.
- No cross-repo federation; each node carries its own copy. `.well-known/agent.json` only points at one skill (`validationSkill = .claude/skills/validate-candidate`) — discovery for everything else is implicit.

**Knowledge lives in dolt behind REST + bearer.**

- Base schema (`packages/knowledge-base/src/schema.ts:42-146`): `domains`, `knowledge` (atomic claims with `entry_type`, `confidence_pct`, `source_ref`, `source_node`, JSONB `tags`), `citations` (DAG), `sources`.
- `entry_type` is free-text (`observation`, `finding`, `conclusion`, `rule`, `scorecard`, `html`). **No `skill` entry type exists.**
- Operator-specific: `knowledge_contributions` + `knowledge_contribution_commits` (`nodes/operator/packages/doltgres-schema/src/knowledge.ts:38-90`) implement branched contributions with full provenance.
- API: `GET /api/v1/knowledge?domain=&sourceType=&limit=`, `POST /api/v1/knowledge/contributions` + lifecycle (`/commits`, `/close`, `/merge`, `/diff`), `GET/POST /api/v1/knowledge/domains`. Auth is session-cookie (humans) or bearer (agents). Bearer agents write to `contrib/*` branches; only humans merge to main.

**MCP today.**

- Cogni is **MCP-consumer-ready, not MCP-server-ready.** `packages/langgraph-graphs/src/runtime/mcp/client.ts` loads external MCP tools; `nodes/node-template/app/src/mcp/server.stub.ts:1-26` throws "not yet implemented".
- Prior research: `docs/research/mcp-production-deployment-patterns.md` already concluded MCP auth should be decoupled (resource server + external IdP, RFC 9728 PRM, audience-bound tokens per RFC 8707), STDIO should not use OAuth.

### What prompted this research

The user observed startups (Smithery, mcp.run, agentskills.io, Cloudflare AutoRAG, Mintlify) bringing skills + knowledge into one MCP-addressable place. Cogni's current state — skills in two filesystem trees, knowledge behind REST, agent onboarding requiring bespoke API + bearer setup — is the opposite of "1-line URL". Every external agent we add (Claude Code, OpenClaw, Codex, future Cursor / VS Code Copilot) re-pays the same onboarding cost. The cost compounds when the agent has to discover what skills/knowledge are even relevant before doing the work.

## Findings

### The industry has converged on a clear pattern

**Anthropic Agent Skills (Oct 2025, open spec Dec 2025)** define the canonical "skill" shape and it has been adopted by VS Code Copilot, Cursor, Cline, etc. Cogni already follows ~80% of this shape by accident (SKILL.md + YAML frontmatter + `name`/`description`). The 20% missing is the loading protocol and the MCP surface.

Two load mechanisms, both standard:

- **Filesystem** (Claude Code / Desktop): harness enumerates `<dir>/SKILL.md`, injects frontmatter only as L1 (~1500 tokens for 40 skills), body on demand as L2, additional files via filesystem reads as L3 ("progressive disclosure").
- **Skills API / MCP**: `container: { skills: [{ type, skill_id, version }] }` in the Messages API; or community shims (FastMCP `SkillsDirectoryProvider`, `skill-to-mcp`, `intellectronica/skillz`, `back1ply/agent-skill-loader`) expose a skills directory as an MCP server with **MCP Prompts** (slash-callable) + **MCP Tools** (programmatic). This dual exposure is becoming a small convention.

**Skill = filesystem artifact, frontmatter-indexed, loaded on demand by name.** Competing framings (skill = pre-bundled tool set, skill = workflow graph) are now wrappers around this model, not alternatives. Cogni should adopt this, not invent.

### The 1-URL UX is standard for docs/knowledge MCPs

| Service | Single URL → tools exposed |
|---|---|
| **Mintlify** | `npx mcp add <subdomain>` → `search_docs(library, version?, query)` |
| **Cloudflare AutoRAG** | `https://autorag.mcp.cloudflare.com/mcp` → `list_rags`, `search`, `ai_search` |
| **Inkeep** | per-KB URL → `search-<product>-docs`, `ask-question-about-<product>` |
| **Composio** | `https://backend.composio.dev/v3/mcp/<server-id>?user_id=<id>` + `x-api-key` |
| **mcp.run** | session URL via `MCP_RUN_SESSION_ID` |
| **Smithery** | per-server URL, managed OAuth proxy or API key |

Cogni's REST `/api/v1/knowledge` is already very close to what Mintlify/Inkeep expose. The gap is the MCP server wrapping that does tool registration + the search ergonomics (currently no full-text or semantic search — domain/sourceType filters only).

### Auth is in flux but bearer + plan-for-CIMD is safe today

MCP spec direction (Nov 2025 → 2026): OAuth 2.1 + PKCE mandatory for public remote servers; **Client ID Metadata Documents (CIMD) is replacing Dynamic Client Registration** as the default (DCR had impersonation issues). In practice today, internal/team servers ship **bearer in `Authorization` header** (often via `mcp-remote --header`). Cogni already has bearer (`cogni_ag_sk_v1_*`), per-principal logging, per-env keys (`COGNI_API_KEY_{TEST,PREVIEW,PROD}`) — drop straight in. Plan CIMD migration when MCP clients catch up. Note the patched RCE in `mcp-remote` (CVSS 9.6 in 2025) — pin carefully.

### Skill activation in OpenClaw vs. Anthropic — same idea, different injection point

- **OpenClaw**: full skill content concatenated into system prompt before every request → eats context window unconditionally.
- **Anthropic**: only frontmatter in system prompt; body loaded **on demand** when Claude judges the skill relevant.

Adopting Anthropic's progressive disclosure is a context-efficiency win Cogni's own agents get for free if we standardize on the format.

### Skills do not need to live in dolt to be served from one URL

Worth naming explicitly because the user's prompt frames "bring skills into dolt knowledge" as the goal. The mechanism the industry uses is:

> skill = git-tracked filesystem artifact in a known directory → MCP server enumerates it on startup → exposes as Prompts + Tools.

Putting skills *into a database table* gains: cross-node indexing, runtime mutation, contribution flow reuse, vector search across both knowledge and skills. It costs: loses git history/PR review on the skill itself, complicates local dev (agent can't `cat` the skill file), and breaks compatibility with Claude Code / Cursor / VS Code which read from filesystem.

The cleanest framing: **skills stay in git filesystem; dolt indexes them**. The MCP server reads SKILL.md frontmatter from filesystem at boot, registers a hybrid search tool that queries dolt knowledge + skills index together, and exposes each skill body via a per-skill Prompt and a `get_skill(name)` tool. Skills authored *out-of-band* by agents (a real future case) can be drafted as `knowledge_contributions` with `entry_type: skill` and promoted to filesystem on merge — that gives us the contribution flow without losing git as the source of truth.

## Findings — Options

### Option A: Operator-hosted MCP server, skills stay in filesystem, dolt indexes them

- **What**: Add an MCP server route at `https://cognidao.org/mcp` (or per-node `https://<node>.cognidao.org/mcp`) that exposes (1) `search_knowledge(query, domain?, entry_type?)` over dolt, (2) `read_knowledge(id)`, (3) `list_skills(scope?)` reading SKILL.md frontmatter from a configured skills root, (4) `get_skill(name)` returning the body and any referenced asset paths, (5) `search_skills(query)` over a built index. Each skill is also registered as an MCP **Prompt** so it can be slash-invoked. Bearer auth, same `cogni_ag_sk_v1_*` keys agents already have. Single config line:
  ```
  { "mcpServers": { "cogni": { "url": "https://cognidao.org/mcp", "headers": { "Authorization": "Bearer ${COGNI_API_KEY}" } } } }
  ```
- **Pros**: Reuses existing auth + REST surface; skills keep git history and PR review; matches Anthropic / Cursor / VS Code "skills are filesystem" model so Cogni skills are portable into any agent harness; cheapest path to a 1-URL UX; agent that already has the bearer needs zero new credentials.
- **Cons**: Skills index needs to rebuild on file change (or on deploy); no runtime authoring of skills by agents (they author via PR, which is arguably correct); per-node vs. operator-central is a real choice — see Option C.
- **OSS tools**: `@modelcontextprotocol/sdk` server, `FastMCP` (TypeScript port `fastmcp` / Python `gofastmcp`), `mcp-handler` (Vercel adapter for Next.js route handlers — fits operator app exactly), `skill-to-mcp` (Python — port the loader), `back1ply/agent-skill-loader` (reference for Prompts+Tools dual exposure).
- **Fit**: Drops into `nodes/operator/app/src/app/mcp/route.ts` as a Next.js handler. Knowledge tools wrap `container.knowledgeStorePort`. Skills loader reads from `.claude/skills/` + `.openclaw/skills/` at boot.

### Option B: Skills migrate into dolt as `entry_type: skill` and are served from there

- **What**: Add `skill` to the knowledge `entry_type` set; each skill becomes a `knowledge` row (body in `content`, frontmatter in `tags`). MCP server queries dolt for everything. Filesystem `.claude/skills/` becomes generated artifact (or deprecated entirely).
- **Pros**: One storage substrate; gets cross-node skill sharing, vector search, confidence scoring, citation DAG, contribution flow for free; agents can author skills at runtime via `POST /knowledge/contributions` (already exists).
- **Cons**: Loses git history + PR review on the skill content itself (contribution lifecycle ≠ PR review); breaks Claude Code / Cursor / VS Code which read from filesystem unless we generate the tree as a CI artifact (operationally painful — agents would author a skill in dolt and not see it until next deploy); contribution lifecycle is heavy for "fix a typo in a SKILL.md"; effectively a rewrite of how the team authors skills today.
- **OSS tools**: Same MCP stack as Option A.
- **Fit**: High invasiveness. Requires a migration of all existing skills, plus a generator for the filesystem tree to keep Claude Code working.

### Option C: Per-node MCP servers vs. operator-central MCP

- **Per-node**: each node deploys its own MCP server at `https://<node>.cognidao.org/mcp`, exposing only that node's skills + knowledge. Maps to current per-node knowledge hub architecture; respects per-node scope; agent connects to one or many. Matches the "node = decentralized SME for its niche" framing in `knowledge-syntropy-expert`.
- **Operator-central**: one server at `https://cognidao.org/mcp`, includes a `node` filter parameter, federates across all nodes. Simpler onboarding (truly 1 URL); easier for cross-node search; weakens per-node sovereignty.
- **Hybrid**: operator-central as the discovery + federated-search front door, with `get_skill(node, name)` and per-node URLs available for agents that want to scope tightly.

### Option D: Skip our own MCP, register skills on Smithery / mcp.run

- **What**: Publish our skills as MCP servers on a public registry.
- **Pros**: Zero infra; lots of agents already know how to install from Smithery.
- **Cons**: Externalizes auth (Cogni knowledge is private per-tenant), skills become divorced from our work-item + provenance system, dependency on external uptime, no path for the contribution flow. Doesn't address the knowledge side at all.
- **Fit**: Wrong shape for Cogni. Worth flagging only because it's the user-facing competition.

## Recommendation

**Option A + Option C hybrid.** Build the operator-central MCP server at `https://cognidao.org/mcp` as the primary 1-URL onboarding surface. Keep skills as git-tracked filesystem artifacts under `.claude/skills/`; deprecate `.openclaw/skills/` as a separate tree and have OpenClaw read from the same root (one canonical skills directory per repo, regardless of harness). Adopt Anthropic Agent Skills frontmatter as the canonical shape; the parts we already have map cleanly.

Wire the MCP server as a Next.js route in the operator app using `@modelcontextprotocol/sdk` + `mcp-handler`. Tools:

1. `list_skills(scope?)` — frontmatter only (L1 progressive disclosure)
2. `get_skill(name)` — body + asset paths (L2)
3. `search_skills(query)` — over a small index built at boot
4. `search_knowledge(query, domain?, entry_type?, node?)` — wraps `KnowledgeStorePort`
5. `read_knowledge(id)`
6. Each skill additionally registered as an MCP **Prompt** so `/skill-name` works in clients that support it.

Auth = existing bearer (`Authorization: Bearer cogni_ag_sk_v1_*`). Use the work-item + project context to inform `search_knowledge` ranking later. Defer skills-into-dolt (Option B) until we have a concrete agent-authored-skill use case; until then "agent contributes knowledge that ages into a skill via human review" is the right boundary.

Reject Option D outright.

**Trade-offs accepted:**

- Skills stay in two filesystem trees temporarily during transition (then converge on one).
- No runtime skill authoring by agents in v0 — they author via PR, which preserves review.
- Per-node MCP servers are deferred to v1; operator-central with a `node` parameter is good enough until cross-node load or per-node sovereignty becomes a real constraint.
- We will likely add semantic search (pgvector on knowledge rows) later — the MCP tool surface is designed to support that swap without breaking clients.

## Open Questions

- **Skill scope at search time**: should `list_skills` default to "all" or to "skills relevant to the active work item / node"? Probably the latter — agent claims a work item, server knows the node, returns skills scoped to that node + cross-cutting operator skills.
- **MCP transport**: stdio (local) vs. streamable-HTTP (remote) — for our use case streamable-HTTP is correct (we are explicitly serving remote agents), but worth confirming `@modelcontextprotocol/sdk` HTTP transport stability in late-2025 client landscape.
- **OpenClaw harness change**: does OpenClaw natively support remote MCP today, or do we need an `mcp-remote` shim? If shim, pin the version (CVSS 9.6 RCE patched in 2025).
- **Skill index storage**: in-memory rebuilt at boot (simple, ~50 skills × few KB each) vs. dolt-indexed (sharable across replicas)? Start in-memory.
- **CIMD migration timing**: when do enough major MCP clients implement CIMD to make it worth migrating away from bearer-in-header?
- **Knowledge search quality**: current `/api/v1/knowledge` is domain/sourceType filter — not text search. Do we add Postgres FTS first, or pgvector first? Probably FTS first (cheaper, no embeddings pipeline), pgvector second.
- **Skill versioning**: Anthropic Skills API takes `version`. Our skills are git-versioned but the harness has no concept of pinning a skill version. Defer until agents start drifting.
- **What lives in `.well-known/agent.json` vs. MCP**: the former is the discovery doc external agents read first; should it advertise the MCP URL? Yes — natural fit.

## Proposed Layout

> Directional, not binding. Captured as prose, not pre-decomposed work items (per project memory on no preemptive decomposition).

### Project

A small `proj.*` would warrant this — call it "Cogni MCP Surface v0". Phases:

1. **Phase 0 — Spec the contract.** One spec under `docs/spec/` covering: MCP server URL + transport, tool list + schemas, Prompt registration convention, auth (bearer reuse), per-node vs. operator-central scoping, skill discovery rules, progressive disclosure invariants.
2. **Phase 1 — Operator MCP server, knowledge-only tools.** Next.js route, `search_knowledge` + `read_knowledge`, bearer auth, smoke-tested against `cogni_ag_sk_v1_*`. Validates infra + auth before adding the skills loader.
3. **Phase 2 — Skills loader.** Read `.claude/skills/<name>/SKILL.md`, expose `list_skills` / `get_skill` / `search_skills`, register each as a Prompt. Index in-memory at boot.
4. **Phase 3 — Consolidate skills tree.** OpenClaw harness change to read `.claude/skills/` (rename to `.cogni/skills/` or keep as-is), retire `.openclaw/skills/`. Single canonical tree.
5. **Phase 4 — Discovery hook.** `.well-known/agent.json` advertises MCP URL. Update `/contribute-to-cogni` skill to instruct agents to add the MCP URL to their client config as the first onboarding step.
6. **Phase 5 (deferred) — Search quality.** Postgres FTS on `knowledge.content` + `knowledge.title`; pgvector follows.
7. **Phase 6 (deferred) — Agent-authored skills via dolt contribution flow.** Only build when a real use case appears.

### Specs needed

- New: `docs/spec/mcp-surface.md` — the MCP contract (tools, auth, scoping, progressive disclosure invariants).
- Updated: `docs/spec/architecture.md` — add MCP as a first-class boundary alongside REST.
- Updated: `nodes/operator/app/src/app/.well-known/agent.json` schema doc — add `mcpUrl` field.
- Reference: `docs/research/mcp-production-deployment-patterns.md` — already covers auth direction; cite from the new spec.

### Likely PR-sized tasks (rough sequence, not yet filed)

1. Spec the MCP surface (Phase 0). One PR, one spec doc.
2. Operator MCP route + `search_knowledge` + `read_knowledge` tools, bearer auth (Phase 1).
3. Skills loader + `list_skills` / `get_skill` / `search_skills` + Prompt registration (Phase 2).
4. OpenClaw harness reads canonical skills dir; deprecate `.openclaw/skills/` (Phase 3).
5. `.well-known/agent.json` advertises `mcpUrl`; `/contribute-to-cogni` onboarding update (Phase 4).

Tasks 1–3 are the critical path to a working 1-URL UX. Tasks 4–5 are the polish that makes it the canonical onboarding surface.

### How this fits the existing architecture

- **Hexagonal layering preserved.** MCP server is a new inbound port living alongside the REST inbound port. Tools call existing `KnowledgeStorePort` adapters; skills loader is a new inbound surface but its data source (filesystem) is trivial.
- **No new auth substrate.** Reuses `cogni_ag_sk_v1_*` bearer tokens already issued to agents — same principal_id, same audit trail.
- **Knowledge hub stays canonical.** Dolt is still the source of truth for knowledge; MCP just adds a second read surface that speaks the agent-native protocol.
- **Skills stay git-canonical.** Contribution flow remains "PR-with-review" for skill changes; agents who want to *propose* a skill use the same knowledge contribution flow they use today.
- **Per-node sovereignty respected** via the `node` parameter; per-node MCP endpoints remain a v1 option without breaking v0 clients.
