---
id: proj.agent-dev-testing
type: project
primary_charter:
title: Agent Development Testing — Self-Validating Code Agents
state: Dropped
priority: 1
estimate: 5
summary: Give OpenClaw agents the ability to fully validate their own code changes — lint, type-check, unit tests, stack tests, and Playwright e2e — before submitting PRs
outcome: An OpenClaw coding agent can run `pnpm check`, launch test infrastructure, execute the full test suite (including browser e2e), and only submit a PR when all gates pass — the same validation loop a human developer runs
assignees:
  - derekg1729
created: 2026-02-11
updated: 2026-10-27
labels: [openclaw, testing, sandbox, ci]
---

# Agent Development Testing — Self-Validating Code Agents

> **Dropped 2026-10-27**: depends entirely on the OpenClaw `sandbox:coder` self-validation loop, which was never built (no `sandbox:coder` registry entry exists on main) and whose direction is not current. See [openclaw-docker-build-finding](https://cognidao.org/knowledge/openclaw-docker-build-finding) for the preserved research evidence. Links to deleted research docs below are not repaired.

> Relationship to other projects:
>
> - [proj.sandboxed-agents](proj.sandboxed-agents.md) — owns the **container sandbox layer** (Docker isolation, socket bridge, proxy, `SandboxRunnerPort`). This project consumes that layer.
> - [proj.openclaw-capabilities](proj.openclaw-capabilities.md) — owns **OpenClaw gateway protocol, catalog, git relay**. This project depends on P1 git relay for the "submit PR" step.
> - [proj.system-test-architecture](proj.system-test-architecture.md) — owns the **mock-LLM test stack** (`litellm.test.config.yaml` → `mock-openai-api`). This project runs those tests from inside the sandbox.
>
> This project owns: giving the agent the tools to **run our CI gates** inside its sandbox, and the orchestration to gate PR submission on passing results.

## Goal

A coding agent should never submit a PR it hasn't validated. Today, agents make code changes and push blindly — test failures surface only in CI, wasting review cycles. This project gives agents the same validation loop humans use: edit → check → test → fix → test → submit. The end state is an agent that runs `pnpm check:full` (or a scoped subset) inside its sandbox and only creates a PR when gates pass.

## Roadmap

### Crawl (P0) — Lint, Type-Check, Format in Sandbox

**Goal:** Agent can run `pnpm check` (lint + type + format) inside its sandbox before committing. Zero infrastructure dependencies — just Node.js + pnpm + the repo.

This is the cheapest, highest-leverage gate. Catches ~60% of common agent mistakes (import errors, type mismatches, lint violations) before they ever reach CI.

| Deliverable                                                                                                  | Status      | Est | Work Item |
| ------------------------------------------------------------------------------------------------------------ | ----------- | --- | --------- |
| `cogni-devtools` sandbox image: Node.js 22 + pnpm + git + common build tools                                 | Not Started | 2   | —         |
| OpenClaw agent variant `sandbox:coder` using devtools image with `workspaceAccess: "rw"`                     | Not Started | 1   | —         |
| Agent workspace setup: clone repo into `/workspace/project`, install deps (`pnpm install --frozen-lockfile`) | Not Started | 2   | —         |
| Agent AGENTS.md instructions: "run `pnpm check` before committing, fix all errors"                           | Not Started | 1   | —         |
| Verify: agent runs `pnpm check`, output captured in sandbox stdout                                           | Not Started | 1   | —         |
| Stack test: coder agent modifies file → runs check → passes or fails with structured output                  | Not Started | 2   | —         |

**How it works:**

- The devtools image is a new sandbox image (not the existing `cogni-sandbox-openclaw`). It has Node.js 22, pnpm, and build tools — everything needed to `pnpm install` and `pnpm check`.
- The agent workspace contains a full repo clone (via the git relay pre-run clone from proj.openclaw-capabilities P1). `pnpm install --frozen-lockfile` runs once via `setupCommand` or during workspace prep.
- OpenClaw's `exec` tool runs `pnpm check` inside the sandbox. No Docker socket needed — this is pure Node.js tooling.
- Network requirement: `network: "none"` is fine for `pnpm check` since all deps are pre-installed. However, `pnpm install` during workspace setup needs network. Two options: (a) install deps host-side before mounting workspace, or (b) use `network: "bridge"` during `setupCommand` only (OpenClaw runs `setupCommand` once at container creation, before switching to session commands).

### Walk (P1) — Unit Tests + Stack Tests via Docker Socket

**Goal:** Agent can launch infrastructure (postgres, litellm, mock-llm) and run the full test suite: `pnpm test` (unit/integration) and `pnpm test:stack:dev` (stack tests against live infra).

This is where Docker socket passthrough becomes necessary. The agent needs to `docker compose up` test infrastructure, wait for health checks, and run tests against it.

| Deliverable                                                                                          | Status      | Est | Work Item            |
| ---------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Docker socket passthrough for `sandbox:coder` agent profile (host socket bind-mount)                 | Not Started | 1   | (create at P1 start) |
| Docker CLI + compose plugin in devtools image                                                        | Not Started | 1   | (create at P1 start) |
| Agent can `docker compose up -d postgres litellm mock-llm` from sandbox                              | Not Started | 2   | (create at P1 start) |
| Wait-for-healthy script: poll service health endpoints before running tests                          | Not Started | 1   | (create at P1 start) |
| Agent runs `pnpm test` (unit + integration, no infra)                                                | Not Started | 1   | (create at P1 start) |
| Agent runs `pnpm test:stack:dev` against live compose services                                       | Not Started | 2   | (create at P1 start) |
| Test isolation: agent's compose project uses unique name (`cogni-test-${runId}`) to avoid collisions | Not Started | 1   | (create at P1 start) |
| Cleanup: compose down + volume prune after test run                                                  | Not Started | 1   | (create at P1 start) |
| Stack test: agent modifies code → runs test suite → all pass → commits                               | Not Started | 2   | (create at P1 start) |

**How it works:**

- The `sandbox:coder` agent gets Docker socket passthrough (`/var/run/docker.sock:/var/run/docker.sock`). This is a deliberate security relaxation, distinct from the `sandbox:openclaw` chat agent which stays `network=none`. See [research](../../docs/research/openclaw-sandbox-build-capability.md) for the full security trade-off analysis.
- The agent runs compose commands to stand up test infrastructure as sibling containers on the host Docker daemon. Compose project name includes `runId` to isolate concurrent runs.
- `pnpm test` runs Vitest unit/integration tests (no infra needed, just Node.js).
- `pnpm test:stack:dev` runs stack tests against the compose infra. Tests connect to postgres/litellm via Docker network.
- Path mapping: the workspace is mounted at `/workspace/project`. Compose bind-mounts that reference host paths need care — the agent must use the host path (available via `HOST_WORKSPACE_ROOT` env var) for any host-path mounts in compose, or avoid them entirely by using named volumes.

**Network topology:**

```
Host Docker daemon
├── openclaw-gateway (existing, sandbox-internal)
├── sandbox:coder container (bridge network, socket passthrough)
│   └── runs: docker compose -p cogni-test-${runId} up -d
├── cogni-test-${runId}-postgres-1 (bridge)
├── cogni-test-${runId}-litellm-1 (bridge)
├── cogni-test-${runId}-mock-llm-1 (bridge)
└── ... (all sibling containers)
```

### Run (P2+) — Full E2E with Playwright + Gated PR Submission

**Goal:** Agent runs the complete CI-parity gate (`pnpm check:full`) including Playwright browser tests, and PR submission is gated on all tests passing.

| Deliverable                                                                  | Status      | Est | Work Item            |
| ---------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Playwright + Chromium in devtools image                                      | Not Started | 2   | (create at P2 start) |
| Agent can build app image (`docker compose build app`) from sandbox          | Not Started | 2   | (create at P2 start) |
| Agent launches full Docker test stack (`pnpm docker:test:stack`)             | Not Started | 2   | (create at P2 start) |
| Agent runs `pnpm e2e` (full) and `pnpm e2e:smoke` (prod-safe subset)         | Not Started | 2   | (create at P2 start) |
| Gated PR submission: git relay push only when test exit code is 0            | Not Started | 2   | (create at P2 start) |
| Test-fix loop: agent retries up to N iterations (edit → check → test → fix)  | Not Started | 2   | (create at P2 start) |
| Observability: test results summary in `GraphFinal.content` alongside PR URL | Not Started | 1   | (create at P2 start) |
| Stack test: full check:full → all pass → PR submitted with test summary      | Not Started | 3   | (create at P2 start) |

**How it works:**

- **Playwright in sandbox**: Install Chromium in the devtools image (`npx playwright install chromium`, ~400MB). Agent runs `pnpm e2e` directly inside the sandbox container. This is simpler than OpenClaw's sandbox-browser sidecar for our use case (we need Playwright's test runner, not just a browser tool).

- **Full stack launch**: The agent builds the app image (if code changed) via `docker compose build app`, then runs the full test stack. Requires Docker socket (from P1) plus ~4GB RAM for 10+ containers.

- **Gated PR submission**: The `SandboxGraphProvider` wraps the git relay with a gate: only push when the agent's test run exits 0. If tests fail, the agent gets a chance to fix and retry (up to 3 iterations per the AGENTS.md instructions). This is the "self-healing" loop.

- **Test-fix loop (agent AGENTS.md):**
  1. Make code changes
  2. Run `pnpm check` → fix lint/type errors → repeat until clean
  3. Run `pnpm test` → fix test failures → repeat until green
  4. Run `pnpm e2e:smoke` → fix e2e failures → repeat until green
  5. `git add -A && git commit` only when all gates pass
  6. Max 3 fix-test iterations before stopping with a diagnostic report

## Constraints

- Agent test runs must not interfere with host development — unique compose project names, separate DB names, no shared ports
- Docker socket passthrough is only for the `sandbox:coder` profile — never for untrusted or public agents
- `LITELLM_MASTER_KEY` and `GITHUB_TOKEN` stay on the host — agent's compose stack uses test-mode env vars, PR submission is host-side
- Devtools image is internal-only (never published to public registry)
- P0 works without Docker socket; P1+ requires it
- Agent test infrastructure is ephemeral — compose down + volume prune after every run
- Full `check:full` will be slow (~5-10 min). Container timeout must accommodate: P0=600s, P1=900s, P2=1200s

## Dependencies

- [ ] proj.openclaw-capabilities P1 git relay operational (for PR submission gating)
- [ ] proj.system-test-architecture mock-LLM wiring (for deterministic stack test results)
- [x] proj.sandboxed-agents `SandboxRunnerAdapter` supports `image` override per-agent
- [x] OpenClaw sandbox supports Docker socket passthrough (`docker.binds` config)
- [x] OpenClaw sandbox supports `network: "bridge"` override
- [x] OpenClaw sandbox supports `setupCommand` for one-time initialization
- [x] `pnpm check` works headlessly (no TTY required)

## As-Built Specs

- (none yet — specs created when code merges)

## Design Notes

### Image Strategy

Start with a single `cogni-devtools` image containing everything (Node.js + pnpm + git + Docker CLI + compose + Playwright + Chromium). Split into layered images only if build time or size becomes a problem. One image is simpler to maintain and test.

Estimated sizes: base Node.js (~500MB) + pnpm deps (~1GB) + Docker CLI (~100MB) + Playwright/Chromium (~400MB) = ~2GB total.

### pnpm Store Caching

`pnpm install --frozen-lockfile` downloads ~1GB of packages. Re-downloading per run is wasteful.

Recommendation: Named Docker volume (`cogni-pnpm-store`) mounted at the pnpm store path. Persists across runs, shared across concurrent runs (safe — pnpm store is content-addressed). Works everywhere without host-path dependency.

### Test Isolation for Concurrent Runs

Multiple agents may run tests concurrently. Each must have isolated infrastructure:

- Compose project name: `cogni-test-${runId}` → unique container/network names
- Database name: `cogni_test_${runId_short}` → unique per run
- Port allocation: Let Docker assign random host ports (no `-p` flags), agent connects via Docker network
- Cleanup: `docker compose -p cogni-test-${runId} down -v` after test run

### Timeout Budget

| Phase | Operations                                                     | Budget     |
| ----- | -------------------------------------------------------------- | ---------- |
| P0    | `pnpm check`                                                   | ~60-90s    |
| P1    | compose up + health wait + `pnpm test` + `pnpm test:stack:dev` | ~5-8 min   |
| P2    | compose build + full stack up + `pnpm e2e` + fix loop (3x)     | ~10-20 min |

### Relationship to OpenClaw's Native Sandbox

This project uses OpenClaw's sandboxing in a **fundamentally different mode** than the existing `sandbox:openclaw` chat agent:

|                   | `sandbox:openclaw` (existing) | `sandbox:coder` (this project)     |
| ----------------- | ----------------------------- | ---------------------------------- |
| Purpose           | Chat, code generation         | Self-validating code changes       |
| Network           | `none`                        | `bridge` (needs Docker, npm)       |
| Docker socket     | No                            | Yes (sibling container management) |
| Security          | Maximum isolation             | Relaxed (trusted agent only)       |
| Container timeout | 600s                          | 600s (P0) → 1200s (P2)             |
| Image             | `cogni-sandbox-openclaw`      | `cogni-devtools`                   |

These are separate agent profiles in the `SANDBOX_AGENTS` registry. The security relaxation for `sandbox:coder` is deliberate and scoped — it does not affect the chat agent's isolation.

### Research Artifacts

- [openclaw-sandbox-build-capability.md](../../docs/research/openclaw-sandbox-build-capability.md) — Docker socket passthrough feasibility, DinD analysis (rejected), path mapping concerns, security trade-offs
