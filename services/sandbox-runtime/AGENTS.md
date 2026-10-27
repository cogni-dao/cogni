# services/sandbox-runtime · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Docker image definition for network-isolated sandbox containers. Provides minimal runtime with socat bridge for LLM access via unix socket proxy.

## Pointers

- [Sandbox Spec](https://cognidao.org/knowledge/sandbox-agent-execution-architecture)
- [Sandbox Adapter](../../apps/operator/src/adapters/server/sandbox/)
- [Proxy Config](../../infra/compose/)

## Boundaries

```json
{
  "layer": "services",
  "may_import": ["services"],
  "must_not_import": ["app", "features", "core", "ports", "adapters"]
}
```

## Public Surface

- **Exports:** Docker image `cogni-sandbox-runtime:latest`
- **CLI:** `pnpm sandbox:docker:build`
- **Env/Config keys (runtime):** `LLM_PROXY_SOCKET` (default `/llm-sock/llm.sock`), `LLM_PROXY_PORT` (default `8080`), `OPENAI_API_BASE`, `RUN_ID`, `COGNI_MODEL` (agent/run.mjs)
- **Files considered API:** Dockerfile, entrypoint.sh, agent/run.mjs

## Responsibilities

- This directory **does**: Define minimal container image; install socat, git, jq, curl; create non-root sandboxer user; start socat bridge when LLM proxy socket is present; fail fast if OPENAI_API_BASE set but socket missing; include `agent/run.mjs` minimal LLM agent (reads messages.json, calls OPENAI_API_BASE, outputs SandboxProgramContract envelope)
- This directory **does not**: Implement application logic; manage container lifecycle; handle networking; contain secrets

## Usage

```bash
# Build image
pnpm sandbox:docker:build

# Run isolated command (no LLM proxy)
docker run --rm --network=none \
  -v /tmp/workspace:/workspace:rw \
  cogni-sandbox-runtime:latest \
  'echo hello from sandbox'

# Run with LLM proxy (mounts socket volume)
docker run --rm --network=none --read-only \
  --tmpfs /run:rw,noexec,nosuid,size=8m \
  --mount type=volume,src=llm-socket-XXX,target=/llm-sock \
  -e OPENAI_API_BASE=http://localhost:8080 \
  cogni-sandbox-runtime:latest \
  'curl -sf http://localhost:8080/health'
```

## Standards

- Base image: node:22-slim
- Non-root execution: user `sandboxer` (uid 1001)
- Entrypoint: `entrypoint.sh` starts socat bridge, then execs command via `bash -lc`
- Minimal tooling: socat, git, jq, curl
- Socket mount at `/llm-sock` (NOT `/run/llm` — tmpfs at `/run` masks nested mounts)

## Dependencies

- **Internal:** none
- **External:** Docker, node:22-slim base image

## Change Protocol

- Update this file when **Dockerfile**, **entrypoint.sh**, or **base image** changes
- Bump **Last reviewed** date
- Rebuild image and run stack tests after changes

## Notes

- Image is built manually or via CI before running sandbox tests
- Container runs with `--network=none` enforced by adapter
- All capabilities dropped by adapter at runtime
- `entrypoint.sh` is the socat bridge orchestrator; it detects the socket and starts socat automatically
