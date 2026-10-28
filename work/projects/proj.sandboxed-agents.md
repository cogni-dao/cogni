---
id: proj.sandboxed-agents
type: project
primary_charter:
title: Sandboxed Agents — OpenClaw Integration, Git Relay & Dashboard
state: Dropped
priority: 1
estimate: 5
summary: Wire OpenClaw into sandbox agent catalog, build host-side git relay for code PRs, add sandbox dashboard and metrics
outcome: Sandbox agents (simple + OpenClaw) discoverable via API catalog, producing code PRs via host-side git relay, with observability dashboard
assignees: derekg1729
created: 2026-02-07
updated: 2026-10-27
labels: [sandbox, openclaw, ai-agents]
---

# Sandboxed Agents — OpenClaw Integration, Git Relay & Dashboard

> **Dropped 2026-10-27**: the sandboxed/OpenClaw coding-agent direction (gateway chat, git relay, warm pool, multi-agent) was confirmed not current and not pursued. The P0 base sandbox layer it depended on (network-isolated container, LLM proxy, billing) is real and live under `sandbox:agent` — its invariants are migrated to the hub as [sandbox-agent-execution-architecture](https://cognidao.org/knowledge/sandbox-agent-execution-architecture), [sandbox-billing-pipeline](https://cognidao.org/knowledge/sandbox-billing-pipeline), and [sandbox-proxy-threat-model](https://cognidao.org/knowledge/sandbox-proxy-threat-model). This charter's OpenClaw-specific roadmap below is historical; links to deleted research docs are not repaired.

> Source: docs/spec/openclaw-sandbox-controls.md (roadmap content extracted during docs migration)

## Goal

Wire the existing `sandbox:agent` and new `sandbox:openclaw` into the live agent catalog API, build a host-side git relay so sandbox agents can produce code PRs without holding credentials, and add observability through a sandbox dashboard and Prometheus metrics.

## Roadmap

### Crawl (P0) — Dynamic Agent Catalog + OpenClaw Wiring

**Goal:** Wire sandbox agents into the live catalog API so the chat UI discovers them dynamically.

| Deliverable                                                     | Status      | Est | Work Item |
| --------------------------------------------------------------- | ----------- | --- | --------- |
| Replace hardcoded `AVAILABLE_GRAPHS` with `useAgents()` hook    | Not Started | 2   | —         |
| Add `sandbox:openclaw` to `SANDBOX_AGENTS` registry             | Not Started | 2   | —         |
| Add `sandbox:openclaw` to `SANDBOX_AGENT_DESCRIPTORS`           | Not Started | 1   | —         |
| OpenClaw workspace setup function                               | Not Started | 2   | —         |
| Optional `image` field on `SandboxRunSpec` port type            | Not Started | 1   | —         |
| `SandboxRunnerAdapter.runOnce()` uses `spec.image ?? imageName` | Not Started | 1   | —         |

**Details:**

- Replace hardcoded `AVAILABLE_GRAPHS` in `ChatComposerExtras` with `GET /api/v1/ai/agents` fetch (hook: `useAgents()`). This replaces all 5 entries (4 langgraph + 1 sandbox) — see `CATALOG_STATIC_IN_P0` TODO already in source.
- OpenClaw workspace setup: writes `.openclaw/openclaw.json`, `.cogni/prompt.txt`, `AGENTS.md`, `SOUL.md`
- Image override: `SandboxRunSpec.image` overrides the adapter's constructor-level `imageName` default

**Chores:**

- [ ] Observability: add `agentVariant` field to sandbox log events (distinguishes `agent` vs `openclaw`)
- [ ] Documentation: update OPENCLAW_SANDBOX_SPEC.md status

**File Pointers (P0 Scope):**

| File                                                            | Change                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/features/ai/components/ChatComposerExtras.tsx`             | Replace `AVAILABLE_GRAPHS` with `useAgents()` hook (removes all 5 hardcoded entries) |
| `src/features/ai/hooks/useAgents.ts`                            | New: fetch `GET /api/v1/ai/agents`, return `GraphOption[]`                           |
| `src/adapters/server/sandbox/sandbox-graph.provider.ts`         | Add `sandbox:openclaw` to `SANDBOX_AGENTS` with image, argv, limits, workspace setup |
| `src/adapters/server/sandbox/sandbox-agent-catalog.provider.ts` | Add `sandbox:openclaw` descriptor                                                    |
| `src/ports/sandbox-runner.port.ts`                              | Add optional `image?: string` to `SandboxRunSpec`                                    |
| `src/adapters/server/sandbox/sandbox-runner.adapter.ts`         | Use `spec.image ?? this.imageName` in container creation                             |

### Walk (P1) — Host-Side Git Relay

**Goal:** Agent makes code changes and commits locally inside the sandbox. Host clones before, pushes after.

| Deliverable                                              | Status      | Est | Work Item            |
| -------------------------------------------------------- | ----------- | --- | -------------------- |
| Pre-run host clone into workspace                        | Not Started | 2   | (create at P1 start) |
| Post-run host reads git log/diff for changes             | Not Started | 1   | (create at P1 start) |
| Host pushes branch `sandbox/${runId}` using GITHUB_TOKEN | Not Started | 2   | (create at P1 start) |
| Host creates PR via GitHub API if requested              | Not Started | 2   | (create at P1 start) |
| Return PR URL in GraphFinal.content                      | Not Started | 1   | (create at P1 start) |
| Defer workspace cleanup until push completes             | Not Started | 1   | (create at P1 start) |

Git relay is provider-level logic wrapping `runOnce()` — it does NOT belong in `SandboxRunSpec` (the port handles container execution only).

### Run (P2) — Sandbox Dashboard + Metrics + Agentic Evolution

**Goal:** Observability and multi-agent capabilities.

| Deliverable                                                               | Status      | Est | Work Item            |
| ------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Prometheus counters: `sandbox_runs_total`, `sandbox_run_duration_seconds` | Not Started | 1   | (create at P2 start) |
| `/sandbox` page: run history table                                        | Not Started | 3   | (create at P2 start) |
| Per-run detail view: output, stderr, proxy log, Langfuse link             | Not Started | 2   | (create at P2 start) |
| Grafana dashboard via Alloy → Mimir pipeline                              | Not Started | 1   | (create at P2 start) |
| Dashboard-driven agent + skill creation                                   | Not Started | 3   | (create at P2 start) |
| OpenClaw multi-agent routing (--agent selection per-run)                  | Not Started | 2   | (create at P2 start) |
| Evaluate OpenClaw subagent spawning for parallel tasks                    | Not Started | 2   | (create at P2 start) |

**Conditions:** P1 git relay operational, agents producing PRs. Do NOT build dashboard preemptively.

**Agentic Evolution Notes:**

- Dashboard-driven agent creation: config changes require git commit + deployment propagation — this is not a hot-reload path
- OpenClaw natively supports multiple agent configs (`agents.list` in `openclaw.json`) and `--agent <id>` selection. Today we hardcode `--agent main`. Evolve to let the Cogni graph selector choose which OpenClaw personality to invoke per-run.
- Sub-agents share the `--timeout 540` / `maxRuntimeSec: 600` envelope — needs timeout budgeting.

### Roadmap — OpenClaw Container & E2E Integration Track

> Source: docs/OPENCLAW_SANDBOX_SPEC.md (roadmap content extracted during docs migration)

#### Pre-Crawl (P0): Get OpenClaw Running in Sandbox

**Goal**: Prove OpenClaw runs in `network=none` sandbox, calls LLM via socket proxy, and billing headers reach LiteLLM. No graph provider wiring, no agent catalog, no reconciliation — just the container lifecycle working end-to-end.

**Principles**: Use `openclaw:local` as-is (no slimming). Fix only what's broken. Follow repo invariants.

| Deliverable                                                                       | Status      | Notes                                                                      |
| --------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| `services/sandbox-openclaw/Dockerfile` (thin layer over `openclaw:local`)         | Done        | 4s build, reuses entrypoint.sh from sandbox-runtime                        |
| `entrypoint.sh` (socat bridge + bash -lc)                                         | Done        | Copied from `services/sandbox-runtime/`                                    |
| Validate `node /app/dist/index.js --version` → `2026.2.4`                         | Done        |                                                                            |
| Fix `nginx.conf.template`: `x-litellm-metadata` → `x-litellm-spend-logs-metadata` | Done        | Header rename for spend log correlation                                    |
| Fix all doc references for header rename                                          | Done        | SANDBOXED_AGENTS.md, EXTERNAL_EXECUTOR_BILLING.md, sandbox-proxy/AGENTS.md |
| LLM roundtrip: OpenClaw agent calls LiteLLM, gets response                        | Done        | nemotron-nano-30b, 22s, 2128 tokens                                        |
| JSON output parses: stdout valid JSON with `payloads` and `meta`                  | Done        | See `tests/_fixtures/sandbox/openclaw-expected-output.json`                |
| Verify metadata JSON includes `run_id`, `attempt`, `graph_id`                     | Not Started | Already present in `LlmProxyManager.generateConfig`                        |
| Smoke: network isolated (`curl` from container fails)                             | Not Started |                                                                            |
| Smoke: no secrets in container (env has no `LITELLM_MASTER_KEY`)                  | Not Started |                                                                            |
| Smoke: spend logs have `run_id` matching our `runId`                              | Not Started |                                                                            |

**P0 Dockerfile (thin layer, as-built):**

```dockerfile
FROM openclaw:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends socat \
  && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod 755 /usr/local/bin/sandbox-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]
```

Reuses existing `services/sandbox-runtime/entrypoint.sh` (socat bridge + `bash -lc "$@"`). No multi-stage build, no file pruning, no user creation (adapter sets `User` at container create time).

**Cold Boot Verification (2026-02-07):**

- Config loaded correctly (`provider: "cogni"`, `model: "gemini-2.5-flash"`)
- No setup/onboarding phase (`skipBootstrap: true` works)
- State written to `OPENCLAW_STATE_DIR` (sessions, transcripts) — not to readonly rootfs
- Valid JSON envelope on stdout (`payloads`, `meta`, `agentMeta`)
- Timed out reaching LLM at localhost:8080 (expected — no proxy in this test)
- Missing workspace files (AGENTS.md, SOUL.md) handled gracefully (noted as missing, no crash)

**Environment & Config — Path Resolution Mechanisms:**

OpenClaw has three path-resolution mechanisms that can leak secrets or break on readonly rootfs. All three must be controlled:

1. **Config file** (`OPENCLAW_CONFIG_PATH`): Points to the exact `.json` file. Set to `/workspace/.openclaw/openclaw.json` (on writable workspace mount).
2. **State directory** (`OPENCLAW_STATE_DIR`): Where sessions, transcripts, caches go. Set to `/workspace/.openclaw-state` (writable). Prevents fallback to `$HOME/.openclaw` which would fail on readonly rootfs.
3. **Dotenv loading** (`loadDotEnv()`): Loads `.env` from CWD + `$OPENCLAW_STATE_DIR/.env`. Prevent by ensuring no `.env` file exists in `/workspace/` or `/workspace/.openclaw-state/`.
4. **Shell env fallback** (`OPENCLAW_LOAD_SHELL_ENV`): Off by default. Explicitly set to `0` as defense-in-depth.
5. **HOME**: Set to `/workspace` so any `$HOME` writes go to writable mount, not readonly rootfs.

> **Source**: `src/config/paths.ts:49-74` (state dir), `src/config/paths.ts:95-104` (config path), `src/infra/dotenv.ts:6-20` (dotenv). Verified against OpenClaw v2026.2.4.

**P0 Scope Constraints:**

- No dynamic model-catalog sync from LiteLLM config
- No multi-stage "minimal file set" pruning of the 4GB image
- No perfect billing reconciliation — just prove spend logs contain `run_id` + `call_id`
- No `SandboxGraphProvider` / agent catalog / bootstrap wiring (that's P0.75)

**File Pointers (P0):**

| File                                                        | Status  |
| ----------------------------------------------------------- | ------- |
| `services/sandbox-openclaw/Dockerfile`                      | Done    |
| `services/sandbox-openclaw/entrypoint.sh`                   | Done    |
| `platform/infra/services/sandbox-proxy/nginx.conf.template` | Fixed   |
| `tests/_fixtures/sandbox/openclaw-config.json`              | Done    |
| `tests/_fixtures/sandbox/openclaw-expected-output.json`     | Done    |
| `scripts/diag-openclaw-sandbox.mjs`                         | WIP     |
| `tests/stack/sandbox/sandbox-openclaw.stack.test.ts`        | Pending |

#### Pre-Crawl (P0.75): Graph Execution Wiring (E2E)

**Trigger**: P0 proves OpenClaw runs in sandbox. Now wire it into the graph execution pipeline so users can select it in the chat UI.

**SandboxGraphProvider:**

- [ ] Create `src/adapters/server/sandbox/sandbox-graph.provider.ts`:
  - `providerId: "sandbox"`
  - `canHandle(graphId)`: matches `sandbox:*`
  - `runGraph(req)`: write openclaw.json + prompt → call `runOnce()` → parse JSON → emit AiEvents
- [ ] Write workspace files (.openclaw/openclaw.json, .cogni/prompt.txt)
- [ ] Parse OpenClaw JSON output → `text_delta` AiEvents → `GraphFinal`
- [ ] Handle agent errors (meta.error, non-zero exit, invalid JSON)

**Agent Catalog:**

- [ ] Create `src/adapters/server/sandbox/sandbox-agent-catalog.provider.ts`:
  - `listAgents()`: returns `sandbox:agent` entry
  - Gated by `SANDBOX_ENABLED` env flag

**Bootstrap Wiring:**

- [ ] Wire `SandboxGraphProvider` in `graph-executor.factory.ts`
- [ ] Wire `SandboxAgentCatalogProvider` in `agent-discovery.ts`
- [ ] Add `SANDBOX_ENABLED` feature flag, gate both registrations
- [ ] Wire `SandboxRunnerAdapter` + config into provider constructor

**Billing Reconciliation:**

- [ ] Query LiteLLM `/spend/logs?end_user=${billingAccountId}`, filter by `metadata.run_id`
- [ ] Sum token usage across all LLM calls in the run
- [ ] Emit `usage_report` AiEvent → `charge_receipt`

**Tests (P0.75 Merge Gates):**

- [ ] **E2E chat flow**: `POST /api/v1/ai/chat` with `graphName: "sandbox:agent"` → SSE response
- [ ] **Agent catalog**: `GET /api/v1/ai/agents` includes `sandbox:agent` when `SANDBOX_ENABLED=true`
- [ ] **Billing verified**: `charge_receipts` has entry matching `runId`
- [ ] **Graceful failure**: Agent error → structured `GraphFinal.error`

**File Pointers (P0.75):**

| File                                                            | Status  |
| --------------------------------------------------------------- | ------- |
| `src/adapters/server/sandbox/sandbox-graph.provider.ts`         | Pending |
| `src/adapters/server/sandbox/sandbox-agent-catalog.provider.ts` | Pending |
| `src/bootstrap/graph-executor.factory.ts`                       | Update  |
| `src/bootstrap/agent-discovery.ts`                              | Update  |
| `tests/stack/sandbox/sandbox-openclaw-e2e.stack.test.ts`        | Pending |

#### Future: Custom Agents, Conversation Continuity, Optimization (P1+/P2+)

**Creating Custom Agents (P1+):**

For DAO-specific agents or specialized roles, extend the `agents.list` in the generated config:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        default: true,
        workspace: "/workspace",
      },
      {
        id: "code-reviewer",
        workspace: "/workspace",
        model: { primary: "cogni/claude-sonnet-4.5" },
        tools: {
          deny: ["exec"], // read-only: no bash
        },
      },
    ],
  },
}
```

Invoke with `--agent code-reviewer` instead of `--agent main`.

**Conversation Continuity P1+ (Workspace-Injected Context):**

For multi-turn conversations, the `SandboxGraphProvider` can inject prior messages into workspace files:

```
/workspace/.cogni/
├── prompt.txt            # current user message
└── conversation.md       # prior messages (system prompt injection)
```

And reference it in `AGENTS.md`:

```markdown
Read /workspace/.cogni/conversation.md for prior context before responding.
```

**Conversation Continuity P2+ (Persistent Sessions):**

For DAO agents with persistent workspace (ONE_WORKSPACE_PER_DAO pattern), mount the workspace volume across runs so OpenClaw's session transcripts, memory files, and `MEMORY.md` persist.

**Streaming Passthrough (P1+, OQ-4):**

OpenClaw internally streams LLM responses (SSE). In `--json` mode, it buffers the entire response and outputs the final envelope. For future streaming support, would likely require running OpenClaw without `--json` and parsing stdout incrementally.

**OpenClaw Version Pinning (P1, OQ-6):**

The `openclaw:local` tag is mutable. Options: pin to a specific OpenClaw git SHA in the Dockerfile, tag our image with the OpenClaw version, or use a content-addressed image reference. Resolution: Use `LABEL openclaw.version=${GIT_SHA}` in the Dockerfile. Pin `openclaw:local` builds to specific commits.

**Multi-Stage Docker Build Optimization (OQ-1):**

What is the minimal file set to copy from `openclaw:local` for embedded agent mode? Specifically: is `ui/dist/` needed for `--local` mode? Is `skills/` lazy-loaded? Are `docs/reference/templates/` needed when `skipBootstrap: true`? What `node_modules` can be pruned? Resolution: Build and test iteratively — `openclaw agent --local --agent main --message "hello" --json`.

**Model Catalog Sync Strategy:**

Should the model catalog be generated at build time (baked into image) or dynamically at each run? Dynamic is more flexible but adds startup latency. Build-time means rebuilding on model changes. Recommendation: generate at run time in `SandboxGraphProvider`, since LiteLLM config may change without image rebuilds.

**Token Budget (P1+):**

Should we add a `max_tokens_per_run` budget? This would require either: (a) rate limiting in the proxy (not supported in nginx, would need OpenResty), or (b) a token-counting wrapper. Deferred per SANDBOX_SCALING.md.

**Skills Audit:**

OpenClaw skills (in `skills/` directory) provide domain-specific behavior. Skills requiring network access (web search, APIs) are non-functional in the sandbox. Skills that work with local files (coding patterns, documentation) work fine. Need to audit which skills are sandbox-compatible and decide whether to bundle a curated set into the `cogni-sandbox-openclaw` image or strip all skills. Skills add to image size and system prompt length.

### Roadmap — Sandbox Proxy Scaling Track

> Source: docs/spec/sandbox-scaling.md (roadmap content extracted during docs migration)

#### Shared Proxy (P1+): Single Long-Lived OpenResty

**Trigger**: When container overhead becomes measurable (>~20 concurrent sandbox runs) OR when dynamic per-request behavior is needed (rate limiting, tool routing).

Single `openresty:alpine` container serving all concurrent sandbox runs. Attribution via host-minted signed run tokens verified per-request in Lua.

| Property             | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Attribution trust    | HMAC-SHA256 signed token verified per-request                   |
| Container overhead   | One proxy, ~10 MB total                                         |
| Concurrency ceiling  | Thousands of concurrent runs                                    |
| Audit isolation      | Must parse/filter shared log by runId                           |
| Secret scoping       | Single proxy holds `LITELLM_MASTER_KEY` + `PROXY_SHARED_SECRET` |
| Failure blast radius | Proxy crash kills ALL concurrent runs                           |

#### Signed Run Token Scheme (P1+)

> **DO NOT BUILD YET.** This is P1+ reference material for when the shared proxy pattern is needed (trigger: >~20 concurrent runs). Per-run proxy with static config is correct until then.

For the shared proxy pattern, a minimal HMAC-SHA256 token (no JWT — avoids unnecessary complexity for internal host-to-proxy trust).

**Token Format:**

```
X-Run-Token: {runId}|{attempt}|{expiry}.{base64(HMAC-SHA256(data, PROXY_SHARED_SECRET))}
```

**Host Side (Node.js):**

```typescript
import { createHmac } from "crypto";

function mintRunToken(runId: string, attempt: number, secret: string): string {
  const expiry = Math.floor(Date.now() / 1000) + 86400; // 24h
  const data = `${runId}|${attempt}|${expiry}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}
```

**Proxy Side (OpenResty Lua):**

```lua
-- access_by_lua_block
local hmac = require "resty.hmac"

local token = ngx.req.get_headers()["X-Run-Token"]
if not token then return ngx.exit(401) end

local data_part, sig_part = token:match("^(.+)%.(.+)$")
if not data_part then return ngx.exit(401) end

local parts = {}
for p in data_part:gmatch("[^|]+") do parts[#parts+1] = p end
-- parts = { runId, attempt, expiry }

if tonumber(parts[3]) < ngx.time() then return ngx.exit(401) end

local h = hmac:new(SHARED_SECRET, hmac.ALGOS.SHA256)
local expected = ngx.encode_base64url(h:final(data_part))
if expected ~= sig_part then return ngx.exit(401) end

ngx.req.set_header("x-litellm-end-user-id", parts[1] .. "/" .. parts[2])
ngx.req.set_header("Authorization", "Bearer " .. LITELLM_KEY)
```

**Dependencies**: [`lua-resty-hmac`](https://github.com/jkeys089/lua-resty-hmac) (15 KB, pure Lua, available via OPM).

#### Migration Plan

| Step                 | When                      | Change                                                                    | Diff Size                                         |
| -------------------- | ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| 1. Ship P0.5         | Now                       | Current `nginx:alpine` per-run proxy                                      | Already built                                     |
| 2. Swap image        | When first Lua needed     | Change `nginx:alpine` to `openresty/openresty:alpine` in LlmProxyManager  | 1 line                                            |
| 3. Add rate limiting | When abuse risk increases | Add `access_by_lua_block` with `lua-resty-limit-req`                      | ~20 lines Lua                                     |
| 4. Shared proxy      | When concurrency > ~20    | Replace per-run containers with single long-lived OpenResty + HMAC tokens | New `SharedLlmProxyManager` adapter               |
| 5. CogniGateway      | P1 tool execution         | Node.js gateway: `/v1/*` passthrough + `/tool/exec` endpoint              | New service, replaces proxy for tool-enabled runs |

Each step is independently shippable. Steps 2-3 are backward-compatible with per-run model.

## Constraints

- HOST_SIDE_GIT_RELAY: All credential-bearing git ops on host, never in sandbox
- CATALOG_FROM_API: Chat UI fetches agent list from API, no hardcoded arrays
- ENV_CREDENTIALS_FIRST: P1 uses GITHUB_TOKEN env var, P2 upgrades to GitHub App installation auth
- WORKSPACE_SURVIVES_FOR_PUSH: Workspace cleanup deferred until after host-side push
- COGNI_NATIVE_UI: Dashboard is Next.js, NOT OpenClaw's Lit-based Control UI
- AGENT_VARIANTS_IN_REGISTRY: One SandboxGraphProvider, multiple agent types via registry entries

## Dependencies

- [x] SandboxGraphProvider + SandboxRunnerAdapter (existing)
- [x] Agent catalog API: `GET /api/v1/ai/agents` (existing)
- [x] OpenClaw container image (existing: `openclaw:local`)
- [ ] GITHUB_TOKEN provisioning for P1 git relay

## As-Built Specs

- [Sandboxed Agents](../../docs/spec/sandboxed-agents.md) — Invariants 1-12, core architecture, socket bridge, design decisions, anti-patterns
- [OpenClaw Sandbox Controls](../../docs/spec/openclaw-sandbox-controls.md) — Invariants 20-25, design decisions, anti-patterns
- [OpenClaw Sandbox Spec](../../docs/spec/openclaw-sandbox-spec.md) — Invariants 13-19, container image, LLM protocol, I/O protocol, billing
- [Sandbox Scaling](../../docs/spec/sandbox-scaling.md) — Proxy comparison, per-run architecture, threat model

### Roadmap — Sandbox Core Phases Track

> Source: docs/SANDBOXED_AGENTS.md (roadmap content extracted during docs migration)

#### Phase Overview

| Phase     | Network Mode | LLM Access                | Description                                                  |
| --------- | ------------ | ------------------------- | ------------------------------------------------------------ |
| **P0**    | none         | N/A                       | Spike: prove network isolation + workspace I/O               |
| **P0.5a** | internal     | Direct (unauthenticated)  | Spike: prove LiteLLM reachable via internal network          |
| **P0.5**  | none         | unix socket → OSS proxy   | Proxy plumbing: socket bridge, nginx container, socat.       |
| **P0.75** | none         | socket proxy (proven E2E) | Agent runs via graph execution, chat UI, billing verified.   |
| **P1**    | none         | socket + tool gateway     | Add tool execution gateway for external integrations.        |
| **P1.5**  | none         | socket + tools + Clawdbot | Clawdbot runtime + authenticated tools via ConnectionBroker. |

> **Key Insight**: P0.5a proved internal-network connectivity works, but P0.5 uses `network=none` + unix socket for stronger isolation. The socket bridge makes networking unnecessary.

#### P0: Sandbox Spike (COMPLETE)

Prove network isolation, workspace I/O, and one-shot container lifecycle. No LLM integration, no gateway, no Temporal.

**Infrastructure:**

- [x] Create `services/sandbox-runtime/Dockerfile`:
  - Base: `node:22-slim`
  - Install: curl, git, jq, bash
  - User: non-root `sandboxer`
  - Entrypoint: `bash -c` for one-shot command execution

**Ports (`src/ports/`):**

- [x] Create `src/ports/sandbox-runner.port.ts`:
  ```typescript
  interface SandboxRunnerPort {
    runOnce(spec: SandboxRunSpec): Promise<SandboxRunResult>;
  }
  interface SandboxRunSpec {
    runId: string;
    workspacePath: string;
    argv: string[]; // Command parts, joined and passed to entrypoint.sh
    limits: { maxRuntimeSec: number; maxMemoryMb: number };
    networkMode?: { mode: "none" } | { mode: "internal"; networkName: string };
    llmProxy?: { enabled: boolean; attempt: number }; // P0.5+
  }
  interface SandboxRunResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    errorCode?: "timeout" | "oom_killed" | "internal" | "container_failed";
  }
  ```
- [x] Export from `src/ports/index.ts`

**Adapters (`src/adapters/server/sandbox/`):**

- [x] Create `sandbox-runner.adapter.ts`:
  - Implements `SandboxRunnerPort`
  - Uses dockerode for container lifecycle
  - `docker create` with `NetworkMode: 'none'`, memory limits, capability drop
  - Volume mount: `${workspacePath}:/workspace:rw`
  - Timeout handling with container kill
  - Log collection (demuxed stdout/stderr)
  - Cleanup in `finally` block (no orphan containers)
- [x] Create `index.ts` barrel export
- [x] Export `SandboxRunnerAdapter` from `src/adapters/server/index.ts`

**Tests (P0 Merge Gates):**

- [x] **Network isolation**: `curl` from sandbox fails (network=none enforced)
- [x] **Workspace read/write**: Container can read/write `/workspace`, host sees changes
- [x] **Stdout/stderr separation**: Logs captured correctly
- [x] **Exit code propagation**: Non-zero exit codes returned
- [x] **Timeout handling**: Long-running commands killed, returns `errorCode: 'timeout'`
- [x] **No orphan containers**: Cleanup verified in afterEach hook

**File Pointers (P0):**

| File                                                    | Status   |
| ------------------------------------------------------- | -------- |
| `services/sandbox-runtime/Dockerfile`                   | Complete |
| `src/ports/sandbox-runner.port.ts`                      | Complete |
| `src/ports/index.ts`                                    | Updated  |
| `src/adapters/server/sandbox/sandbox-runner.adapter.ts` | Complete |
| `src/adapters/server/sandbox/index.ts`                  | Complete |
| `src/adapters/server/index.ts`                          | Updated  |
| `tests/component/sandbox/network-isolation.int.test.ts` | Complete |

#### P0.5a: LiteLLM Reachability Spike (COMPLETE)

Prove sandbox container can reach LiteLLM via internal Docker network while remaining isolated from the public internet.

> **Known Gap**: P0.5a proves network connectivity (health endpoint) but NOT actual LLM completions. Per SECRETS_HOST_ONLY invariant, we cannot pass `LITELLM_MASTER_KEY` to the container. P0.5 CogniGateway will solve this by proxying authenticated requests from host.

**Infrastructure:**

- [x] Add `sandbox-internal` network to `docker-compose.dev.yml`:
  - `internal: true` — Prevents internet egress via external gateway
  - Attach `litellm` service to this network
- [x] Extend `SandboxRunSpec` with `networkMode` option:
  - `mode: 'none'` (default) — Complete isolation (P0 baseline)
  - `mode: 'internal'` + `networkName` — Attach to named internal network
- [x] Change `SandboxRunSpec.command` to `argv: string[]` for explicit invocation
- [x] Fix TIMEOUT_RACE_LEAK: clearTimeout when waitPromise wins
- [x] Fix LOG_COLLECTION_INCORRECT: handle stream with demuxStream
- [x] Fix NETWORK_FLAGS_CONFLICT: use only NetworkMode, remove NetworkDisabled
- [x] Add SECURITY_HARDENING: no-new-privileges, PidsLimit, ReadonlyRootfs with Tmpfs
- [x] Add OUTPUT_BOUNDS: truncate logs at configurable max bytes (default 2MB)
- [ ] Align `sandbox-runtime` CI image with SERVICES_ARCHITECTURE.md (fingerprint tagging, GHA cache, GHCR publish)

**Tests (P0.5a Merge Gates):**

- [x] **LiteLLM reachable**: Container gets HTTP 200 from `http://litellm:4000/health/liveliness`
- [x] **No default route**: `ip route show default` returns empty (definitive isolation proof)
- [x] **DNS blocked**: `getent hosts example.com` fails
- [x] **IP blocked**: `curl http://1.1.1.1` fails
- [x] **No Docker socket**: `/var/run/docker.sock` not mounted
- [x] **LiteLLM DNS resolves**: `getent hosts litellm` succeeds (internal DNS works)

**File Pointers (P0.5a):**

| File                                                     | Status   |
| -------------------------------------------------------- | -------- |
| `platform/infra/services/runtime/docker-compose.dev.yml` | Updated  |
| `src/ports/sandbox-runner.port.ts`                       | Updated  |
| `src/adapters/server/sandbox/sandbox-runner.adapter.ts`  | Updated  |
| `tests/stack/sandbox/sandbox-litellm.stack.test.ts`      | Complete |

#### P0.5: Agent in Sandbox with LLM via Unix Socket (MOSTLY COMPLETE)

**Goal**: OpenClaw/Clawdbot runs inside sandbox (`network=none`) and can call LiteLLM without secrets in sandbox, with run-scoped billing attribution.

**Infrastructure:**

- [x] Create `platform/infra/services/sandbox-proxy/nginx.conf.template`:
  - Listen on unix socket in shared `/llm-sock/` directory
  - Inject `Authorization: Bearer ${LITELLM_MASTER_KEY}` (from template substitution)
  - Inject `x-litellm-end-user-id: ${billingAccountId}` + `x-litellm-spend-logs-metadata` (overwrites client-sent)
  - Forward to `http://litellm:4000` (Docker DNS on sandbox-internal)
  - Access log: timestamp, runId, model, status (no request body/secrets)
- [x] Update `services/sandbox-runtime/Dockerfile`:
  - Add `socat` for socket-to-localhost bridging
  - Add entrypoint wrapper that starts socat before main command
- [x] Create `services/sandbox-runtime/entrypoint.sh`:
  - Start `socat TCP-LISTEN:8080,fork,bind=127.0.0.1 UNIX-CONNECT:/llm-sock/llm.sock &`
  - Exec the main agent command
  - Note: P0.5 uses entrypoint for socat; argv passed as Cmd to entrypoint

**Adapters (`src/adapters/server/sandbox/`):**

- [x] Extend `SandboxRunnerAdapter.runOnce()`:
  - Before container start: start nginx:alpine proxy container via LlmProxyManager
  - Mount socket volume into sandbox at `/llm-sock:rw` (not config dir)
  - Set env: `OPENAI_API_BASE=http://localhost:8080`, `RUN_ID=${runId}`
  - After container exits: stop proxy container, audit log persists in conf/
- [x] Create `src/adapters/server/sandbox/llm-proxy-manager.ts`:
  - `start(runId, attempt)`: create nginx:alpine container on sandbox-internal, return Docker volume name
  - `stop(runId)`: copy access log, stop/remove container and volume
  - `cleanup(runId)`: delete host config directory (caller decides when)
  - Config bind-mounted into proxy with 0o600 perms (never in socket volume)

**Bootstrap (`src/bootstrap/`):**

- [ ] Wire `SandboxRunnerPort` in `container.ts`
- [ ] Add `SANDBOX_ENABLED` feature flag (default false)
- [ ] Add `allowSandbox` field to `ExecutionGrant` schema

**Tests (P0.5 Merge Gates):**

- [x] **Socket bridge works**: Sandbox can reach proxy `/health` endpoint via localhost:8080
- [x] **Proxy forwards**: Requests reach LiteLLM (connection established, even if backend unreachable)
- [x] **Network isolation**: Sandbox without llmProxy cannot reach localhost:8080 or external IPs
- [x] **No secrets in sandbox**: Container env contains no `LITELLM_MASTER_KEY` or `OPENAI_API_KEY`
- [x] **OPENAI_API_BASE set**: Container env has `OPENAI_API_BASE=http://localhost:8080`
- [x] **Header stripping**: Proxy accepts requests with spoofed headers (doesn't break)
- [ ] **LLM completion succeeds**: `/v1/chat/completions` returns valid response (requires internet)
- [ ] **Attribution injection**: LiteLLM receives `x-litellm-end-user-id: ${billingAccountId}` + `x-litellm-spend-logs-metadata` with `run_id` (verify via spend logs)

**File Pointers (P0.5):**

| File                                                        | Status   |
| ----------------------------------------------------------- | -------- |
| `platform/infra/services/sandbox-proxy/nginx.conf.template` | Complete |
| `platform/infra/services/sandbox-proxy/README.md`           | Complete |
| `services/sandbox-runtime/Dockerfile`                       | Complete |
| `services/sandbox-runtime/entrypoint.sh`                    | Complete |
| `src/adapters/server/sandbox/llm-proxy-manager.ts`          | Complete |
| `src/adapters/server/sandbox/sandbox-runner.adapter.ts`     | Complete |
| `src/ports/sandbox-runner.port.ts`                          | Complete |
| `tests/stack/sandbox/sandbox-llm-completion.stack.test.ts`  | Complete |

#### P0.75: Sandbox Agent via Graph Execution (E2E) (MOSTLY COMPLETE)

**Goal**: User selects sandbox agent in chat UI → message flows through `AggregatingGraphExecutor` → agent runs in sandboxed container with LLM access → response streams back → billing tracked via LiteLLM.

**Trigger**: P0.5 proxy plumbing works. Now prove it's usable: a real agent running in sandbox, invoked through the standard chat pipeline, with verifiable billing.

> **No tool calling.** Agent has LLM access only. Workspace file I/O is local to the container. This phase proves the execution loop; P1 adds tools.

**Agent I/O Protocol (P0.75 — simple, non-streaming):**

- **Input**: Provider writes `GraphRunRequest.messages` as JSON to `/workspace/.cogni/messages.json`
- **Output**: Agent prints assistant response to **stdout** (plain text). Provider wraps as `text_delta`.
- **Model**: Provider passes `model` via env var `COGNI_MODEL` (agent uses it in API call)
- **Non-streaming**: P0.75 runs agent to completion, then emits entire response. Streaming deferred.

**Adapters (`src/adapters/server/sandbox/`):**

- [x] Create `sandbox-graph.provider.ts` implementing `GraphProvider`:
  - `providerId: "sandbox"`
  - `canHandle(graphId)`: matches `sandbox:*` prefix
  - `runGraph(req)`: create tmp workspace (symlink-safe) → write messages.json → call `SandboxRunnerAdapter.runOnce()` → parse stdout → emit AiEvents → return `GraphFinal`
  - Passes `caller.userId` → proxy → `x-litellm-customer-id` header
  - Socket dir mounted `:ro` in sandbox (proxy has `:rw`)
- [x] Create `sandbox-agent-catalog.provider.ts` implementing `AgentCatalogProvider`:
  - `listAgents()`: returns `[{ agentId: "sandbox:agent", graphId: "sandbox:agent", name: "Sandbox Agent", description: "LLM agent in isolated container" }]`
  - Gated by `LITELLM_MASTER_KEY` presence (not separate `SANDBOX_ENABLED` flag)

**Bootstrap (`src/bootstrap/`):**

- [x] Register `SandboxGraphProvider` in `graph-executor.factory.ts` providers array
- [x] Register `SandboxAgentCatalogProvider` in `agent-discovery.ts` providers array
- [x] Gate both registrations on `LITELLM_MASTER_KEY` presence
- [x] Wire `SandboxRunnerAdapter` + `litellmMasterKey` into provider constructor

**Agent Runtime (`services/sandbox-runtime/`):**

- [x] Create minimal agent script (`services/sandbox-runtime/agent/run.mjs`):
  - Read `/workspace/.cogni/messages.json`
  - Call `${OPENAI_API_BASE}/v1/chat/completions` with messages + `COGNI_MODEL`
  - Output `SandboxProgramContract` JSON envelope to stdout (matches OpenClaw `--json`)
  - Exit 0 on success, non-zero on error (envelope always present for structured parsing)
- [x] Define `SandboxProgramContract` as port-level type in `sandbox-runner.port.ts`
- [x] Update `Dockerfile` to include agent script at `/agent/run.mjs`
- [x] Default `argv` in provider: `["node", "/agent/run.mjs"]`

**Billing (Inline via Trusted Proxy):**

- [x] Proxy injects billing headers: `x-litellm-end-user-id: ${billingAccountId}` + `x-litellm-spend-logs-metadata` (run correlation + Langfuse)
- [x] Nginx audit log captures `$upstream_http_x_litellm_call_id` for per-call tracing
- [x] Provider emits `usage_report` AiEvent so `RunEventRelay` commits charge_receipt
- [ ] Capture `x-litellm-call-id` from proxy response inline for `usageUnitId` (per proj.graph-execution Crawl P0)
- [ ] Set `executorType: "sandbox"` in UsageFact (per `UsageFactStrictSchema`)
- [ ] Verify `charge_receipts` table has entry with `source_reference = ${runId}/0/${litellmCallId}`

**Tests (P0.75 Merge Gates):**

- [ ] **E2E chat flow**: `POST /api/v1/ai/chat` with `graphName: "sandbox:agent"` → SSE response with assistant text
- [ ] **Agent catalog**: `GET /api/v1/ai/agents` includes `sandbox:agent` when `SANDBOX_ENABLED=true`
- [ ] **Billing verified**: After sandbox run, `charge_receipts` table has entry matching `runId`
- [ ] **LiteLLM spend match**: `x-litellm-end-user-id` in spend logs matches `billingAccountId`, `metadata.run_id` matches `runId`
- [ ] **No secrets in response**: Sandbox stdout does not contain `LITELLM_MASTER_KEY`
- [ ] **Graceful failure**: Agent error (bad model, timeout) returns structured error via `GraphFinal.error`

**File Pointers (P0.75):**

| File                                                            | Status   |
| --------------------------------------------------------------- | -------- |
| `src/adapters/server/sandbox/sandbox-graph.provider.ts`         | Complete |
| `src/adapters/server/sandbox/sandbox-agent-catalog.provider.ts` | Complete |
| `src/bootstrap/graph-executor.factory.ts`                       | Complete |
| `src/bootstrap/agent-discovery.ts`                              | Complete |
| `src/ports/sandbox-runner.port.ts` (`SandboxProgramContract`)   | Complete |
| `services/sandbox-runtime/agent/run.mjs`                        | Complete |
| `services/sandbox-runtime/Dockerfile`                           | Complete |
| `tests/stack/sandbox/sandbox-e2e.stack.test.ts`                 | Pending  |

**Validation (2026-02-07):**

E2E smoke test confirmed full pipeline operational:

```
curl POST /api/v1/ai/chat
  { graphName: "sandbox:agent", model: "nemotron-nano-30b", messages: [...] }

→ AggregatingGraphExecutor routes to SandboxGraphProvider
→ Provider writes /workspace/.cogni/messages.json
→ SandboxRunnerAdapter creates Docker container (network=none, LLM proxy enabled)
→ entrypoint.sh starts socat bridge (localhost:8080 → /llm-sock/llm.sock)
→ run.mjs reads messages, calls LiteLLM via proxy, outputs SandboxProgramContract envelope
→ Provider parses envelope, emits text_delta + usage_report AiEvents
→ SSE stream delivers response: "Hello, dear friend, welcome back!"
→ GraphFinal: { ok: true, finishReason: "stop" }
```

Verified: agent catalog discovery (`GET /api/v1/ai/agents` lists `sandbox:agent`),
free model passthrough (no credits required), billing headers injected by proxy.

#### P1: Tool Execution Gateway (PLANNED)

> **Scaling**: See sandbox-scaling spec for proxy selection, per-run vs shared proxy tradeoffs, signed token scheme, and threat model.

**Trigger**: Agent needs to call external tools (file system, git, metrics, etc.) beyond just LLM.

**Scope**: Add tool execution to the existing LLM proxy, creating full CogniGateway.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ SANDBOX (network=none)                                              │
│ ──────────────────────                                              │
│  Agent Runtime                                                      │
│    ├─ LLM: http://localhost:8080/v1/* (from P0.5)                   │
│    └─ Tools: cogni-tool exec <tool> '<args-json>'                   │
│                                                                     │
│  socat (localhost:8080 ↔ /run/cogni-gateway.sock)                  │
└────────────────────────┼────────────────────────────────────────────┘
                         │ unix socket
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ HOST: CogniGateway (Node.js, replaces OSS proxy)                    │
│ ─────────────────────────────────────────────────                   │
│  /v1/* → LiteLLM proxy (same as P0.5)                               │
│  /tool/exec → toolRunner.exec() + policy + audit                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Design Choice**: P1 replaces the OSS proxy with a Node.js CogniGateway that handles both LLM routing and tool execution. This is when we commit to bespoke gateway code.

**Infrastructure:**

- [ ] Create `services/sandbox-runtime/cogni-tool/` CLI:
  - Reads gateway URL from `COGNI_GATEWAY_URL` env (default: `http://localhost:8080`)
  - Commands: `cogni-tool exec <tool> '<args-json>'`
  - Protocol: HTTP POST to `/tool/exec`
- [ ] Update Dockerfile to include `cogni-tool` binary

**Adapters (`src/adapters/server/sandbox/`):**

- [ ] Create `cogni-gateway.server.ts` (replaces llm-proxy-manager):
  - Listen on unix socket
  - `/v1/*` → proxy to LiteLLM with header injection (migrate from Envoy)
  - `/tool/exec` → validate runId, check allowlist, call toolRunner
  - Audit log all requests (no prompt content)
- [ ] Tool allowlist (P1 scope):
  - `core__get_current_time` — pure computation
  - `core__metrics_query` — read-only metrics
  - No authenticated tools yet (deferred to P1.5)

**Tests (P1 Merge Gates):**

- [ ] LLM routing still works (regression from P0.5)
- [ ] Tool execution via `cogni-tool exec` succeeds
- [ ] runId mismatch → rejected
- [ ] Tool not in allowlist → `policy_denied`
- [ ] All tool calls appear in host audit log

#### P1.5: Authenticated Tools + Clawdbot Integration (PLANNED)

**Trigger**: Agent needs to call authenticated external services (GitHub, Slack, etc.).

**Scope**: Integrate ConnectionBroker for credential resolution; add Clawdbot-specific configuration.

- [ ] Extend CogniGateway tool allowlist with authenticated tools
- [ ] Integrate ConnectionBroker for credential resolution (host-side)
- [ ] Clawdbot-specific config: `baseUrl: http://localhost:8080`, sandbox mode
- [ ] Implement `GitHubRepoAdapter` for `RepoPort` via ConnectionBroker
- [ ] Persistent workspace option for long-running DAO agents
- [ ] Stop using LITELLM_MASTER_KEY, find better proxy keys

#### P2: Full Agent Autonomy (DO NOT BUILD YET)

- [ ] Multi-turn agent sessions with persistent workspace
- [ ] `.cogni/index.json` repo memory
- [ ] Sandbox warm pools
- [ ] Condition: P0.5 and P1 must be boring first

#### Merge Gates Summary

| Phase | Gate                    | Test                                                       |
| ----- | ----------------------- | ---------------------------------------------------------- |
| P0    | Network isolation       | `curl` from sandbox → fails                                |
| P0    | Workspace I/O           | Read/write `/workspace` from container + host              |
| P0    | Timeout handling        | Long command killed, `errorCode: 'timeout'`                |
| P0    | No orphans              | No containers left after test                              |
| P0.5a | LiteLLM reachable       | HTTP 200 from `http://litellm:4000/health` (internal net)  |
| P0.5a | No default route        | `ip route show default` returns empty                      |
| P0.5a | External DNS blocked    | `getent hosts example.com` fails                           |
| P0.5a | External IP blocked     | `curl http://1.1.1.1` fails                                |
| P0.5a | No Docker socket        | `/var/run/docker.sock` not present                         |
| P0.5a | Internal DNS works      | `getent hosts litellm` succeeds                            |
| P0.5  | Socket bridge works     | Sandbox reaches proxy `/health` via localhost:8080         |
| P0.5  | Proxy forwards          | Requests reach LiteLLM (connection test)                   |
| P0.5  | Network isolation       | Sandbox w/o proxy can't reach localhost:8080 or external   |
| P0.5  | No secrets in sandbox   | Container env has no `LITELLM_MASTER_KEY`/`OPENAI_API_KEY` |
| P0.5  | OPENAI_API_BASE set     | Container env points to `localhost:8080`                   |
| P0.5  | Header stripping        | Proxy handles spoofed headers without breaking             |
| P0.75 | E2E chat flow           | `POST /api/v1/ai/chat` with `sandbox:agent` → SSE response |
| P0.75 | Agent in catalog        | `GET /api/v1/ai/agents` includes `sandbox:agent`           |
| P0.75 | Billing verified        | `charge_receipts` has entry matching sandbox `runId`       |
| P0.75 | LiteLLM spend match     | `end_user` in spend logs matches `${runId}/0`              |
| P0.75 | Graceful failure        | Agent error → structured `GraphFinal.error`                |
| P1    | Tool exec works         | `cogni-tool exec <tool>` succeeds                          |
| P1    | Tool allowlist enforced | Disallowed tool → `policy_denied`                          |
| P1    | runId mismatch rejected | Wrong runId in request → rejected                          |

## Design Notes

- **Credential Strategy (Phased):** P1 uses `GITHUB_TOKEN` env var on host. P2 upgrades to GitHub App installation auth via `TENANT_CONNECTIONS_SPEC.md` `ConnectionBroker` for multi-tenant per-repo scoped tokens.
- **Never** pass `GITHUB_TOKEN` into the sandbox container. The host-side relay is the only consumer.
