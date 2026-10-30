---
id: proj.openclaw-capabilities
type: project
primary_charter:
title: OpenClaw Capabilities Integration
state: Dropped
priority: 1
estimate: 5
summary: Integrate OpenClaw's gateway protocol, agent runtime, git relay, and multi-agent capabilities into Cogni's graph execution pipeline
outcome: OpenClaw agents are fully operational via Cogni UI — gateway chat works end-to-end, billing is accurate, host-side git relay produces PRs, custom agents are configurable, and the catalog is dynamic
assignees:
  - derekg1729
created: 2026-02-09
updated: 2026-10-27
labels: [openclaw, ai-agents, sandbox]
---

# OpenClaw Capabilities Integration

> **Dropped 2026-10-27**: confirmed not current. Several items this charter marks "Done" (`sandbox:openclaw` in the `SANDBOX_AGENTS` registry, `LazySandboxGraphProvider` gateway-client wiring, `openclaw-gateway-client.ts`) are not present on `origin/main` as of this date — only the base `sandbox:agent` provider exists. See [sandbox-git-relay-finding](https://cognidao.org/knowledge/sandbox-git-relay-finding) and [openclaw-docker-build-finding](https://cognidao.org/knowledge/openclaw-docker-build-finding) for the preserved research evidence. Links to deleted research docs below are not repaired.

> Relationship to [proj.sandboxed-agents](proj.sandboxed-agents.md): that project owns the **container sandbox layer** (Docker isolation, socket bridge, proxy plumbing, `SandboxRunnerPort`). This project owns everything **above** that layer: gateway protocol client, agent catalog wiring, UI integration, git relay, multi-agent routing, and OpenClaw-specific capabilities.

## Goal

Make OpenClaw a fully integrated, production-quality agent runtime within Cogni. Users select OpenClaw agents from the chat UI, messages flow through the gateway protocol, responses stream back with billing, and code-producing agents can create PRs via host-side git relay — all without OpenClaw's own UI or any credential leakage into containers.

## Roadmap

### Crawl (P0) — Gateway Chat E2E

**Goal:** OpenClaw agent is selectable in the Cogni UI and produces real chat responses with accurate billing. The gateway WS client correctly implements the full protocol lifecycle.

#### Gateway Client

The production WS client must implement the OpenClaw gateway protocol correctly. Reference implementation: `openclaw/src/gateway/client.ts` (upstream).

| Deliverable                                                                               | Status      | Est | Work Item |
| ----------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| Gateway client `runAgent()` generator — correct ACK → deltas → final res lifecycle        | In Progress | 3   | task.0008 |
| `extractTextFromResult()` — extract content from authoritative `result.payloads`          | In Progress | 1   | task.0008 |
| `configureSession()` — per-session outboundHeaders + model override via `sessions.patch`  | Done        | 1   | task.0010 |
| Stack test: gateway WS chat returns real content (not ACK JSON)                           | In Progress | 1   | task.0008 |
| Stack test: billing entries in proxy audit log after gateway call                         | In Progress | 1   | task.0008 |
| Stack test: LITELLM_MASTER_KEY not in gateway container env                               | Done        | 1   | —         |
| **Blocker:** OpenClaw v2026.2.4 agent returns empty payloads (content silently discarded) | In Progress | 1   | bug.0009  |

**Protocol state machine (from upstream `client.ts` `expectFinal` semantics):**

```
handshake: challenge → connect(auth) → hello-ok
agent call: req(agent) → ACK res(accepted) → chat delta events (0–N)
            → chat final signal (NOT terminal) → final "ok" res with result.payloads (terminal)
```

#### Gateway Service Operations

The gateway is a long-running service (externally-built image, compose-managed). It needs the same operational rigor as any other service: CI builds, model catalog, documentation, root scripts. This is a new pattern — **external image service** — not covered by the current `create-service.md` guide.

| Deliverable                                                                                                                                                                     | Status      | Est | Work Item |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| Production model catalog in `openclaw-gateway.json` — sync model list from LiteLLM config (currently only `test-model`)                                                         | Not Started | 1   | task.0018 |
| Root script `sandbox:openclaw:docker:build` for unified image (parity with `sandbox:docker:build`)                                                                              | Not Started | 0.5 | task.0031 |
| CI: pull `openclaw-outbound-headers:latest` from GHCR + start gateway profile in stack-test compose `up`                                                                        | Done        | 1   | —         |
| Gateway stack tests (`sandbox-openclaw.stack.test.ts`) pass in CI — gateway image pulled, profile started                                                                       | Done        | 1   | —         |
| Deploy: `deploy.sh` pulls gateway image from GHCR + starts `--profile sandbox-openclaw` on preview/prod VMs                                                                     | Done        | 1   | —         |
| Compose: Wire OpenClaw services + sandbox-internal network into production compose; post-deploy health gate                                                                     | Done        | 2   | bug.0016  |
| Parameterize gateway auth token — replace hardcoded `openclaw-internal-token` with generated secret per environment                                                             | Todo        | 1   | task.0019 |
| Update `services/sandbox-openclaw/AGENTS.md` — document gateway mode, compose services, config, proxy                                                                           | Not Started | 0.5 | (create)  |
| Update `services-architecture.md` Existing Services table — add `openclaw-gateway` (external image), `llm-proxy-openclaw` (nginx sidecar), `sandbox-openclaw` (ephemeral image) | Not Started | 0.5 | (create)  |
| Add "External Image Service" variant to `create-service.md` — lighter checklist for pre-built images (compose + config + healthcheck + CI, no package.json/tsconfig/src)        | Not Started | 1   | (create)  |
| Gateway agent workspace + SOUL.md — dedicated workspace with chat-appropriate AGENTS.md, upstream heartbeat prompt fix                                                          | Todo        | 2   | task.0023 |
| Memory search extraPaths + curated MEMORY.md/TOOLS.md + spec documentation for bootstrap file alignment                                                                         | Not Started | 2   | task.0034 |

**Key distinction**: `openclaw-gateway` uses `openclaw-outbound-headers:latest` (built in the OpenClaw repo, published to GHCR). We don't own that Dockerfile — we configure it via bind-mounted `openclaw-gateway.json` and deploy via compose. `cogni-sandbox-openclaw` (ephemeral) is the image we DO build from `services/sandbox-openclaw/Dockerfile`. Both need CI coverage.

#### Agent Catalog + UI Wiring

| Deliverable                                                                       | Status | Est | Work Item |
| --------------------------------------------------------------------------------- | ------ | --- | --------- |
| `sandbox:openclaw` in `SANDBOX_AGENTS` registry (gateway execution mode)          | Done   | 1   | —         |
| `sandbox:openclaw` in `SandboxAgentCatalogProvider` descriptors                   | Done   | 1   | —         |
| `sandbox:openclaw` selectable in ChatComposerExtras (hardcoded, temporary)        | Done   | 1   | —         |
| Proxy billing reader for gateway mode (`ProxyBillingReader.readEntries`)          | Done   | 1   | —         |
| Bootstrap wiring: `LazySandboxGraphProvider` with gateway client + billing reader | Done   | 1   | —         |

### Walk (P1) — Git Relay + Dynamic Catalog + Gateway Hardening

**Goal:** Code-producing agents create PRs via host-side git relay. UI discovers agents from API. Gateway client is production-grade.

**North star:** Credentials never enter the agent runtime; host owns push+PR forever.

#### Git Relay — MVP

Per [sandbox-git-write-permissions.md](../../docs/research/sandbox-git-write-permissions.md) Option A and [openclaw-sandbox-controls.md](../../docs/spec/openclaw-sandbox-controls.md) HOST_SIDE_GIT_RELAY.

The real requirement is per-run RW workspace + unique branch. Not blocked on "ephemeral-only" — use whichever execution path is easiest today. Multiple concurrent coder runs allowed (footgun accepted for now). Enforce: unique workspace per runId + unique branch per runId.

| Deliverable                                                                                                                                              | Status      | Est | Work Item |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| [ ] Unified devtools image: node:22 + OpenClaw + pnpm/git/socat + pnpm cache volume — single image for gateway + ephemeral                               | Todo        | 3   | task.0031 |
| [ ] Create per-run workspace dir on host (`git clone --depth=1` or `git worktree add`) — agent gets RW copy of repo on a fresh `sandbox/${runId}` branch | Not Started | 2   | task.0022 |
| [ ] Mount workspace RW into OpenClaw run — wire through `SandboxGraphProvider` (ephemeral or gateway path, whichever is simpler)                         | Not Started | 1   | task.0022 |
| [ ] Agent must `git add`/`git commit` locally (no credentials needed) — ensure AGENTS.md instructs the agent to commit before exit                       | Not Started | 1   | task.0022 |
| [ ] Host detects commits (`git log baseBranch..HEAD`), pushes branch, creates PR — use `gh` CLI for speed, `GITHUB_TOKEN` env on host only               | Not Started | 2   | task.0022 |
| [ ] Return PR URL in `GraphFinal.content`                                                                                                                | Not Started | 0.5 | task.0022 |
| [ ] Cleanup workspace after push completes — defer `rmSync` until push finishes (WORKSPACE_SURVIVES_FOR_PUSH)                                            | Not Started | 0.5 | task.0022 |

#### Git Relay — Robustness

| Deliverable                                                                                                                         | Status      | Est |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- |
| [ ] Max-parallel coder runs + simple queue — disk threshold refusal (refuse if `/tmp` or workspace root exceeds threshold)          | Not Started | 2   |
| [ ] Bare-mirror cache + `git worktree` to reduce disk/time per clone — avoids full `clone --depth=1` per run                        | Not Started | 2   |
| [ ] Standardize PR body file (`.cogni/pr.md`) — agent writes PR description, host reads it during `gh pr create`                    | Not Started | 1   |
| [ ] Stack tests for git relay (mock GH) — agent modifies file + commits → host detects → mock push; no-commit → skip; cleanup after | Not Started | 2   |

#### Dynamic Agent Catalog

Per [openclaw-sandbox-controls.md](../../docs/spec/openclaw-sandbox-controls.md) CATALOG_FROM_API:

| Deliverable                                                                            | Status      | Est | Work Item |
| -------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| Replace hardcoded `AVAILABLE_GRAPHS` in `ChatComposerExtras` with `useAgents()` hook   | Not Started | 1   | task.0018 |
| [ ] Deduplicate agent name/description — catalog should derive from execution registry | Not Started | 1   |           |

#### Streaming Status Events

| Deliverable                                                                                | Status | Est | Work Item |
| ------------------------------------------------------------------------------------------ | ------ | --- | --------- |
| Consume OpenClaw agent events (lifecycle, tool, compaction) — surface status in chat UI    | Done   | 2   | task.0074 |
| Stream reasoning tokens from OpenClaw → AI SDK reasoning parts → assistant-ui Reasoning UI | Todo   | 2   | task.0078 |

#### Gateway Client Hardening

Model after upstream `openclaw/src/gateway/client.ts` features:

| Deliverable                                                                                        | Status      | Est |
| -------------------------------------------------------------------------------------------------- | ----------- | --- |
| [ ] Persistent WS connection — connect once at bootstrap, reuse for all calls                      | Not Started | 2   |
| [ ] Generic `request<T>(method, params, { expectFinal })` replacing per-method bespoke WS handling | Not Started | 2   |
| [ ] `pending` map with `flushPendingErrors` on close (upstream lines 82, 362-367)                  | Not Started | 1   |
| [ ] Auto-reconnect with exponential backoff (upstream `scheduleReconnect`, lines 349-360)          | Not Started | 2   |
| [ ] Tick-based liveness detection (upstream `startTickWatch`, lines 369-386)                       | Not Started | 1   |

**Features from upstream we do NOT need:** device identity/keypair signing, TLS fingerprint pinning, device auth token store/rotate (all server-to-server token auth is sufficient).

### Run (P2+) — Credential Evolution, Warm Pool, Multi-Agent

**Goal:** Production-grade credential management, container warm pool for fast cold starts, full OpenClaw capability surface.

#### Credential Evolution + Advanced Git

Per [openclaw-sandbox-controls.md](../../docs/spec/openclaw-sandbox-controls.md) ENV_CREDENTIALS_FIRST:

| Deliverable                                                                                                                 | Status      | Est |
| --------------------------------------------------------------------------------------------------------------------------- | ----------- | --- |
| [ ] `ConnectionBroker` + GitHub App installation tokens — replace `GITHUB_TOKEN` PAT with short-lived, repo-scoped tokens   | Not Started | 3   |
| [ ] Multi-tenant: per billing account GitHub App installations                                                              | Not Started | 2   |
| [ ] Optional socket/MCP `git_push` tool for mid-run pushes — agent invokes tool via Unix socket bridge to host relay daemon | Not Started | 3   |
| [ ] Gateway per-session workspace — only if use cases emerge requiring real-time code editing in shared gateway             | Not Started | 3   |

#### Warm Pool (Container Cold-Start Elimination)

A pool of pre-warmed coding-agent containers ready to accept jobs, eliminating clone + container-start latency.

| Deliverable                                                                                                                        | Status      | Est |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- |
| [ ] Pool manager: assigns one job to one worker, unique workspace per job, no state bleed between jobs                             | Not Started | 3   |
| [ ] Workers rebound to per-job workspace — if OpenClaw supports workspace override, use it; else one-job-per-worker + symlink flip | Not Started | 2   |
| [ ] Periodic worker restart to prevent state accumulation                                                                          | Not Started | 1   |

Host still owns push+PR in warm pool mode — workers never need GitHub credentials.

#### Multi-Agent + Custom Agents

| Deliverable                                                                                          | Status      | Est | Work Item |
| ---------------------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| [ ] Subagent spawning: upstream header fix + config + flash/strong model tiers + delegation strategy | Todo        | 3   | task.0045 |
| [ ] OpenClaw multi-agent routing (`--agent` selection per-run via `agents.list` config)              | Not Started | 2   |           |
| [ ] Skills audit: identify sandbox-compatible skills, bundle curated set into image                  | Not Started | 2   |           |
| [ ] Dashboard-driven agent + skill creation (config changes via git commit)                          | Not Started | 3   |           |
| [ ] Persistent sessions: workspace volume across runs for DAO agents                                 | Not Started | 2   |           |
| [ ] Conversation continuity: inject prior messages as workspace context files                        | Not Started | 2   |           |

#### Observability

| Deliverable                                                                   | Status      | Est |
| ----------------------------------------------------------------------------- | ----------- | --- |
| [ ] Sandbox dashboard (`/sandbox` page): run history, per-run detail view     | Not Started | 3   |
| [ ] Prometheus counters: `sandbox_runs_total`, `sandbox_run_duration_seconds` | Not Started | 1   |

## Constraints

- **North star: credentials never enter the agent runtime; host owns push+PR forever** — this holds across all phases, including warm pool
- All credential-bearing operations on host, never in sandbox or gateway container (links to SECRETS_HOST_ONLY, HOST_SIDE_GIT_RELAY in specs)
- Git relay is execution-mode-agnostic — the requirement is per-run RW workspace + unique branch, not "must be ephemeral"
- Chat UI fetches agent list from API — no hardcoded arrays long-term (links to CATALOG_FROM_API)
- Dashboard and controls are Cogni-native Next.js — no OpenClaw Lit UI (links to COGNI_NATIVE_UI)
- Gateway client must not block on upstream OpenClaw package — our client implements the protocol directly, using upstream as reference only
- P1 uses `GITHUB_TOKEN` env var; `ConnectionBroker` deferred to P2

## Dependencies

- [x] Sandbox container infrastructure operational (proj.sandboxed-agents P0–P0.75)
- [x] OpenClaw gateway + proxy containers running (`docker compose` services)
- [x] Agent catalog API: `GET /api/v1/ai/agents` (existing)
- [x] Billing pipeline: proxy audit log → `ProxyBillingReader` → `usage_report` → `charge_receipts`
- [ ] `GITHUB_TOKEN` provisioning for P1 git relay
- [ ] `ConnectionBroker` for P2 credential evolution (proj.tenant-connections)

## As-Built Specs

- [openclaw-sandbox-controls.md](../../docs/spec/openclaw-sandbox-controls.md) — Invariants 20-25: git relay, dynamic catalog, credential strategy, anti-patterns
- [openclaw-sandbox-spec.md](../../docs/spec/openclaw-sandbox-spec.md) — Invariants 13-19: container image, LLM protocol, I/O protocol, billing
- [sandboxed-agents.md](../../docs/spec/sandboxed-agents.md) — Invariants 1-12: core sandbox architecture, socket bridge
- [streaming-status.md](../../docs/spec/streaming-status.md) — StatusEvent pipeline: OpenClaw agent events → AiEvent → transient data-status SSE chunks

## Design Notes

### Gateway Client: Build vs Reuse

**Upstream** (`openclaw/src/gateway/client.ts`, ~440 lines):

- Persistent connection with reconnect + backoff
- `request<T>(method, params, { expectFinal })` — generic req/res correlation
- `expectFinal` skips ACK (status=accepted), waits for real terminal response
- Tick-based liveness detection (2× tick interval → close + reconnect)
- Heavily coupled to OpenClaw internals: device identity signing, TLS fingerprint pinning, AJV validators

**Our client** (`src/adapters/server/sandbox/openclaw-gateway-client.ts`, ~500 lines):

- One WS per call (P0), should become persistent (P1)
- `runAgent()` AsyncGenerator yields typed events: accepted, text_delta, chat_final, chat_error
- Correct protocol lifecycle as of unstaged changes (ACK → deltas → chat final signal → final "ok" res)
- No device auth, no TLS pinning needed (server-to-server, localhost/docker-internal)

**Decision:** Build our own, modeled on upstream's `pending` map + `expectFinal` + reconnect patterns. Upstream is not consumable as a library (deeply coupled internals, not exported from package). P0 ships the generator pattern; P1 refactors to persistent connection.

### Sub-Projects

- [proj.messenger-channels](proj.messenger-channels.md) — Expose OpenClaw's channel plugin system (WhatsApp, Telegram, etc.) to tenants via proxy endpoints + management UI

### Research Artifacts

- [sandbox-git-write-permissions.md](../../docs/research/sandbox-git-write-permissions.md) — 5 approaches evaluated for sandbox git writes; host-side relay recommended
- [openclaw-gateway-header-injection.md](../../docs/research/openclaw-gateway-header-injection.md) — outboundHeaders investigation
- [openclaw-gateway-integration-handoff.md](../../docs/research/openclaw-gateway-integration-handoff.md) — protocol reverse-engineering, frame sequences
- [messenger-integration-openclaw-channels.md](../../docs/research/messenger-integration-openclaw-channels.md) — spike.0020: messenger channel integration research
- [openclaw-memory-workspace-alignment.md](../../docs/research/openclaw-memory-workspace-alignment.md) — memory backend, bootstrap files, extraPaths for repo doc indexing
