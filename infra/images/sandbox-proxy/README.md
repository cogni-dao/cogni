# Sandbox LLM Proxy

Per [Sandboxed Agents](https://cognidao.org/knowledge/sandbox-agent-execution-architecture) P0.5: Nginx proxy that injects authentication and billing headers for sandbox LLM calls.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ SANDBOX (network=none)                                              │
│  Agent → localhost:8080 → socat → /llm-sock/llm.sock               │
└──────────────────────────────┼──────────────────────────────────────┘
                               │ unix socket (mounted from host)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ HOST: Nginx (this proxy)                                            │
│  - Listens on unix socket                                           │
│  - Strips client x-litellm-end-user-id header                       │
│  - Injects Authorization: Bearer ${LITELLM_MASTER_KEY}              │
│  - Injects x-litellm-end-user-id: ${RUN_ID}/${ATTEMPT}              │
│  - Forwards to localhost:4000 (LiteLLM)                             │
└─────────────────────────────────────────────────────────────────────┘
```

## Template Variables

| Variable             | Description        | Example                      |
| -------------------- | ------------------ | ---------------------------- |
| `SOCKET_PATH`        | Unix socket path   | `/tmp/llm-proxy-abc123.sock` |
| `LITELLM_MASTER_KEY` | LiteLLM API key    | `sk-...`                     |
| `RUN_ID`             | Sandbox run ID     | `run_abc123`                 |
| `ATTEMPT`            | Run attempt number | `0`                          |
| `LITELLM_HOST`       | LiteLLM host:port  | `localhost:4000`             |
| `ACCESS_LOG_PATH`    | Audit log path     | `/tmp/llm-proxy-abc123.log`  |

## Usage

The `LlmProxyManager` adapter handles:

1. Template substitution via `envsubst`
2. Spawning Nginx with the generated config
3. Lifecycle management (start/stop per run)
4. Collecting access logs after run completes

## Invariants Enforced

- **SECRETS_HOST_ONLY**: `LITELLM_MASTER_KEY` never enters sandbox
- **HOST_INJECTS_BILLING_HEADER**: Proxy sets `x-litellm-end-user-id`, client header stripped
- **APPEND_ONLY_AUDIT**: Access log written by host, not sandbox
