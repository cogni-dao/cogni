---
id: cogni-brain-spec
type: spec
title: Cogni-Brain Design
status: active
trust: draft
summary: Read-only repo-aware AI brain for answering questions about code/docs with citation requirements
read_when: Implementing repo browsing tools, citation guards, or code analysis features
owner: derekg1729
created: 2026-02-05
verified: 2026-02-05
tags: []
---

# Cogni-Brain Design

> [!CRITICAL]
> Brain answers questions about code/docs by retrieving from a read-only `/repo` worktree and citing exact locations. No claims without citations.

## Core Invariants

1. **REPO_READ_ONLY**: Read-only access to repository files. No writes, no execution.

2. **NO_CLAIMS_WITHOUT_CITES**: Responses mentioning code/files must include citations (`path:L10-L20@sha`). Guard rejects uncited claims.

3. **REPO_ROOT_ONLY**: Tools access only files under the configured repo root (`COGNI_REPO_PATH`, required in all environments). Reject absolute paths, `..` segments, AND symlink-resolved paths outside repo root via realpath checks. Allow regular files only.

4. **SHA_STAMPED**: Every tool result includes current HEAD sha7 from `git rev-parse HEAD` OR env `COGNI_REPO_SHA`. Tool returns 7-char prefix.

5. **NO_EXEC_IN_BRAIN**: Repo tools may only spawn fixed binaries (`rg`, `git rev-parse`) with fixed flags. No generic shell execution.

6. **HARD_BOUNDS**: search limit≤50 hits, snippet≤20 lines, open max≤200 lines, max 256KB/file.

7. **RG_BINARY_NOT_NPM**: Use `rg` binary with `--json` output. Avoids Next.js bundling issues with native deps.

---

## Implementation Checklist

### P0: MVP — Repo-Aware Brain

**Step 1: In-process repo access**

- [x] Add `COGNI_REPO_PATH` (required) / `COGNI_REPO_SHA` (optional) env vars to `src/shared/env/server.ts`
- [x] Create `RepoCapability` factory in `src/bootstrap/capabilities/repo.ts` (test/real/stub)
- [x] Create `FakeRepoAdapter` in `src/adapters/test/repo/` for deterministic test doubles
- [x] Wire `RepoCapability` into DI container (`src/bootstrap/container.ts`)
- [x] Wire real implementations in `src/bootstrap/ai/tool-bindings.ts`

**Step 2: Two tools**

- [x] Create `RepoCapability` interface in `packages/ai-tools/src/capabilities/repo.ts`
- [x] Create `RipgrepAdapter` in `src/adapters/server/repo/ripgrep.adapter.ts` (shells to `rg --json`)
- [x] Create `core__repo_search` tool: query → `[{ path, lineStart, lineEnd, snippet, sha }]`
- [x] Create `core__repo_open` tool: path + lines → `{ path, sha, content }`
- [x] Add both tools to `TOOL_CATALOG`
- [x] Integration tests: search returns bounded results with sha7
- [x] Integration tests: open rejects `..` paths and symlink escapes outside root
- [x] Integration tests: sha7 from `git rev-parse` OR `COGNI_REPO_SHA` fallback

**Step 3: Citation guard**

- [x] Create `citation.guard.ts` in `src/shared/ai/guards/`
- [ ] Wire guard into chat handler: if response mentions repo but lacks citations → force retrieval retry → if still none → "Insufficient cited evidence"
- [ ] Test: uncited repo claims rejected

**Step 4: Deployment wiring**

- [x] Install `ripgrep` + `git` in Dockerfile runner stage (`Dockerfile`)
- [x] Add `git-sync` service (bootstrap profile, `--one-time`, `--link=current`) to runtime compose (`infra/compose/runtime/docker-compose.yml`)
- [x] Add `repo_data` shared volume: rw in git-sync, ro in app at `/repo`
- [x] Set `COGNI_REPO_PATH=/repo/current` in app service environment (runtime + dev compose)
- [x] Wire `COGNI_REPO_URL` + `COGNI_REPO_REF` (pinned SHA) through deploy script `.env` + SSH env line (`scripts/ci/deploy.sh`)
- [x] Run git-sync bootstrap step before db-provision in remote deploy script
- [x] Add `COGNI_REPO_URL` + `COGNI_REPO_REF` to CI workflows (`staging-preview.yml`, `deploy-production.yml`)
- [x] Smoke test: app boots with `COGNI_REPO_PATH=/repo/current`, `repo.open(package.json)` returns sha

**Step 5: MVP Agent Graph uses brain**

- [x] Simple React agent that has the repo_search and repo_open tools (`packages/langgraph-graphs/src/graphs/brain/`)
- [ ] Agent bound by citation_guard (deferred — prompt-level enforcement only in v0)

#### Chores

- [ ] Observability instrumentation [observability.md](../../.claude/commands/observability.md)
- [x] Documentation updates (`/implement` docs pass)

### P1: Production Hardening

- [ ] Add git-fetch cron/webhook to keep `/repo` at HEAD
- [ ] Full git clone volume for history tools (`git log`, `git show`); P0 snapshot is depth=1, no history
- [ ] Add `core__repo_symbol` tool (tree-sitter index) if needed
- [ ] Structured docs index with trust_level metadata

### P2: Do NOT Build Yet

- [ ] MCP server wrapper
- [ ] Multi-repo support
- [ ] Semantic embeddings

---

## File Pointers (P0 Scope)

| File                                                    | Change                                      |
| ------------------------------------------------------- | ------------------------------------------- |
| `packages/ai-tools/src/capabilities/repo.ts`            | RepoCapability interface + citation helpers |
| `src/adapters/server/repo/ripgrep.adapter.ts`           | RipgrepAdapter impl (in-process rg + git)   |
| `src/adapters/test/repo/fake-repo.adapter.ts`           | FakeRepoAdapter for deterministic tests     |
| `src/bootstrap/capabilities/repo.ts`                    | RepoCapability factory (test/real/stub)     |
| `src/bootstrap/ai/tool-bindings.ts`                     | Wire repo tool implementations              |
| `src/bootstrap/container.ts`                            | Add repoCapability to DI container          |
| `src/shared/env/server.ts`                              | COGNI_REPO_PATH, COGNI_REPO_SHA env vars    |
| `packages/ai-tools/src/tools/repo-search.ts`            | core\_\_repo_search tool contract           |
| `packages/ai-tools/src/tools/repo-open.ts`              | core\_\_repo_open tool contract             |
| `packages/ai-tools/src/catalog.ts`                      | Add repo tools to TOOL_CATALOG              |
| `src/shared/ai/guards/citation.guard.ts`                | Citation enforcement (pure validation)      |
| `packages/langgraph-graphs/src/graphs/brain/graph.ts`   | Brain ReAct agent graph factory             |
| `packages/langgraph-graphs/src/graphs/brain/prompts.ts` | Brain system prompt                         |
| `packages/langgraph-graphs/src/graphs/brain/tools.ts`   | Brain tool IDs (repo_search, repo_open)     |
| `Dockerfile`                                            | Install ripgrep + git in runner stage       |
| `infra/compose/runtime/docker-compose.yml`              | git-sync service + repo_data volume         |
| `infra/compose/runtime/docker-compose.dev.yml`          | HTTPS git-sync clone (same path as prod)    |
| `scripts/ci/deploy.sh`                                  | COGNI_REPO_URL/BRANCH env + bootstrap step  |
| `.github/workflows/staging-preview.yml`                 | Pass repo URL + branch to deploy            |
| `.github/workflows/deploy-production.yml`               | Pass repo URL + branch to deploy            |

---

## Design Decisions

### 1. Tool Outputs

**core\_\_repo_search**

```typescript
interface RepoSearchHit {
  repoId: string; // "main" in MVP
  path: string; // relative to /repo/<repoId>
  lineStart: number;
  lineEnd: number;
  snippet: string; // max 20 lines
  sha: string; // HEAD sha (7 chars)
}
// Input: { query: string, glob?: string, limit?: number }
// Output: { hits: RepoSearchHit[] }
```

**core\_\_repo_open**

```typescript
interface RepoOpenResult {
  repoId: string; // "main" in MVP
  path: string;
  sha: string; // HEAD sha (7 chars)
  lineStart: number;
  lineEnd: number;
  content: string; // max 200 lines
}
// Input: { path: string, lineStart?: number, lineEnd?: number }
// Output: RepoOpenResult
```

**Citation helper**:

```typescript
function makeRepoCitation(hit: RepoSearchHit | RepoOpenResult): string {
  return `repo:${hit.repoId}:${hit.path}#L${hit.lineStart}-L${hit.lineEnd}@${hit.sha.slice(0, 7)}`;
}
```

### 2. Citation Format

**Token format**: `repo:<repoId>:<relpath>#L<start>-L<end>@<sha7>`

**MVP**: Single repo accessed via `COGNI_REPO_PATH` (required, no default), uses `repo:main:<path>#L...`.

**Examples**:

- `repo:main:src/features/ai/services/billing.ts#L45-L67@abc1234`
- `repo:main:docs/spec/architecture.md#L10-L25@abc1234`

**Regex**: `\brepo:[a-z0-9_-]+:[^#\s]+#L\d+-L\d+@[0-9a-f]{7}\b`

**Why this format**:

- Single regex validation
- Tool outputs map 1:1 to token via `makeRepoCitation(hit)`
- `repo:` scheme prefix enables future expansion (doc:, web:, dolt:) without breaking v0
- `repoId` placeholder ready for multi-repo (don't implement until needed)

**UI display**: `<repoId>/<path>:<start>-<end> (sha7)` — pretty links, machine token in audit log.

### 3. Citation Guard Flow

**When required**: If assistant mentions code/files/repo behavior, require ≥1 `repo:` citation token.

**Validation**:

1. Path is relative; reject leading `/` or `..` segments
2. lineStart/lineEnd are integers; 1 ≤ start ≤ end
3. sha7 matches current repo HEAD sha prefix returned by tool
4. repoId is in allowed set for this run (MVP: `main` only)

**Fail-closed behavior**:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Citation Guard                                                      │
│ ──────────────                                                      │
│ 1. Scan response for repo claims (mentions files/code behavior)     │
│ 2. Scan for valid repo: tokens via regex                            │
│ 3. If repo claims but no valid citations:                           │
│    - Force one retrieval retry (repo.search/open)                   │
│    - If still missing → respond "Insufficient cited evidence"       │
│      and ask for a target path/module                               │
└─────────────────────────────────────────────────────────────────────┘
```

**Server-generated Sources**: Server builds Sources list from tool outputs. Guard accepts either LLM-emitted tokens OR server-generated Sources (prevents LLM omission issues).

### 4. Default Ignores

Excluded from search:

- `node_modules/`, `dist/`, `.next/`, `.git/`, `vendor/`
- Binary files
- Files > 256KB

Override only via server config, not user input.

---

## Repo Access Modes

> [!WARNING]
> `COGNI_REPO_URL`, `COGNI_REPO_REF`, and `GIT_READ_TOKEN` are only consumed by the **git-sync Docker container**. The Next.js app process never reads them — it only sees `COGNI_REPO_PATH` and `COGNI_REPO_SHA`.

There are two distinct repo access paths. Confusing them is a recurring source of "works locally, broken in prod" bugs.

### Host mode (`pnpm dev`)

```
App (host process) ──reads──> local checkout (COGNI_REPO_PATH=.)
                               └── .git exists → git rev-parse HEAD works
```

- **What's exercised**: `RipgrepAdapter` + `GitLsFilesAdapter` against local files
- **What's NOT exercised**: git-sync, HTTPS clone, token auth, `COGNI_REPO_SHA` override
- **SHA source**: `git rev-parse HEAD` on local `.git`
- Git-sync env vars (`COGNI_REPO_URL`, `GIT_READ_TOKEN`) are **ignored** — the host process never reads them

### Container mode (`docker:stack` / `docker:dev:stack` / CI / production)

```
git-sync container ──HTTPS clone──> GitHub (COGNI_REPO_URL + GIT_READ_TOKEN)
        │
        ▼
   repo_data volume (/repo/current)   ← worktree, .git is a file not a directory
        │
        ▼
App container ──reads──> /repo/current (COGNI_REPO_PATH=/repo/current)
                          └── .git is a file → git rev-parse HEAD fails
                          └── must use COGNI_REPO_SHA (set from COGNI_REPO_REF)
```

- **What's exercised**: Full production path — network clone, volume mount, SHA override
- **SHA source**: `COGNI_REPO_SHA` env var (passed from `COGNI_REPO_REF`)
- If git-sync fails, `service_completed_successfully` blocks app startup
- `repo_data` is a **named Docker volume** — it persists across `docker compose down`. Use `docker:nuke` (which runs `down -v`) to force a fresh clone

### Validation coverage

| Scenario         | Host mode       | Container mode           |
| ---------------- | --------------- | ------------------------ |
| File read/search | Yes             | Yes                      |
| SHA stamping     | `git rev-parse` | `COGNI_REPO_SHA`         |
| HTTPS clone      | **No**          | Yes                      |
| Token auth       | **No**          | Yes (if repo is private) |
| git-sync wiring  | **No**          | Yes                      |
| Volume mount     | **No**          | Yes                      |

**Implication**: To validate the production git-sync flow locally, you must use `docker:dev:stack` or `docker:stack`, not `pnpm dev`.

---

## Anti-Patterns

| Pattern                             | Problem                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| npm ripgrep package in Next.js      | Native dep bundling nightmares                                        |
| /repo mounted rw                    | Security risk, brain should be read-only                              |
| Citations "added later"             | Model makes uncited claims, loses trust                               |
| HTTP endpoints before tools         | Duplicate logic, security surface                                     |
| tree-sitter in v0                   | Scope creep, rg is sufficient for MVP                                 |
| Multi-repo before needed            | Design token for it, don't implement                                  |
| trust_level/canonical filters       | Wait until doc structure is enforced                                  |
| Separate brain container (P0)       | Dead architecture unless tools execute remotely                       |
| Testing git-sync via `pnpm dev`     | Host mode never exercises git-sync/HTTPS/token — use `docker:stack`   |
| `COGNI_REPO_PATH` with cwd fallback | Green CI / broken prod blind spot — field is required, no default     |
| Named volume without `down -v`      | `repo_data` persists stale clones across restarts — use `docker:nuke` |

---

## Future Schemes (v1+)

Reserved scheme prefixes for future expansion (DO NOT implement in v0):

| Scheme  | Format                               | When                                   |
| ------- | ------------------------------------ | -------------------------------------- |
| `doc:`  | `doc:<doc_id>#<heading_slug>@<sha7>` | Only after doc_id frontmatter enforced |
| `web:`  | `web:<host>/<path>@<date_or_hash>`   | Only when web tool exists              |
| `dolt:` | `dolt:<table>/<pk>@<commit7>`        | Only when Dolt is source of truth      |

---

## Known Issues

Review findings from code review on 2026-02-03. Ordered by severity.

| Status | Severity | Finding                                                            | Invariant          | Location                            |
| ------ | -------- | ------------------------------------------------------------------ | ------------------ | ----------------------------------- |
| [x]    | CRITICAL | Shell injection via `exec()` + string interpolation in `search()`  | NO_SHELL_EXEC      | `ripgrep.adapter.ts:search()`       |
| [x]    | CRITICAL | Shell execution in `getSha()`                                      | NO_SHELL_EXEC      | `ripgrep.adapter.ts:getSha()`       |
| [ ]    | HIGH     | `repoRoot` not realpath-resolved; breaks symlink containment check | REPO_ROOT_ONLY     | `ripgrep.adapter.ts` constructor    |
| [ ]    | HIGH     | No null byte rejection in paths                                    | REPO_ROOT_ONLY     | `ripgrep.adapter.ts:validatePath()` |
| [x]    | HIGH     | Exit code type mismatch (`"1"` vs `1`) causes spurious error logs  | Correctness        | `ripgrep.adapter.ts:search()`       |
| [ ]    | MEDIUM   | Context lines wasted (`-C 10` parsed but discarded)                | Performance        | `ripgrep.adapter.ts:search()`       |
| [ ]    | MEDIUM   | `--max-count` is per-file not total                                | HARD_BOUNDS (weak) | `ripgrep.adapter.ts:search()`       |
| [ ]    | MEDIUM   | Test adapter imported in production bundle                         | Layering (minor)   | `bootstrap/capabilities/repo.ts`    |
| [x]    | MEDIUM   | `shaOverride` not wired from bootstrap env (`COGNI_REPO_SHA`)      | SHA_STAMPED        | `bootstrap/capabilities/repo.ts`    |

---

**Last Updated**: 2026-02-04
**Status**: P0 MVP functional (brain graph + tools + deployment wiring complete; citation guard wiring deferred)
