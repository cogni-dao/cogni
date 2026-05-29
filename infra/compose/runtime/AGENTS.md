# runtime · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Production runtime configuration directory copied to VM hosts for container orchestration and database initialization. Contains app + postgres + litellm + alloy + temporal + git-sync services, OpenClaw gateway services under the `sandbox-openclaw` profile, and Playwright MCP server under the `mcp-playwright` profile (dev-only). Edge (Caddy) is in separate `../edge/` project.

## Pointers

- [docker-compose.yml](docker-compose.yml): Production container stack (app, postgres, litellm, alloy, temporal, OpenClaw gateway profile)
- [docker-compose.dev.yml](docker-compose.dev.yml): Development container stack (includes local loki, grafana)
- [postgres-init/](postgres-init/): Postgres database initialization scripts
- [doltgres-init/](doltgres-init/): Doltgres knowledge-plane provisioning (roles, per-node `knowledge_*` databases)
- [configs/](configs/): Service configuration templates (litellm, alloy, temporal)
- [sandbox-proxy/](../../images/sandbox-proxy/): nginx gateway config template for OpenClaw LLM proxy (rsync'd by deploy.sh)
- [docker-daemon.json](docker-daemon.json): Docker daemon log limits (reference only, applied via bootstrap.yaml)
- [Edge stack](../edge/): TLS termination (Caddy) - separate compose project, never stopped during deploys

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** none
- **CLI (if any):** docker-compose commands
- **Env/Config keys:** `APP_IMAGE`, `MIGRATOR_IMAGE`, `APP_ENV`, `DEPLOY_ENVIRONMENT`, `COGNI_REPO_URL` (git-sync), `COGNI_REPO_REF` (git-sync, pinned SHA), `GIT_READ_USERNAME` (git-sync), `GIT_READ_TOKEN` (git-sync, Contents:Read PAT), `COGNI_REPO_PATH` (app, `/repo/current`), `COGNI_REPO_SHA` (app), `POSTGRES_ROOT_USER`, `POSTGRES_ROOT_PASSWORD`, `APP_DB_USER`, `APP_DB_PASSWORD`, `APP_DB_SERVICE_USER`, `APP_DB_SERVICE_PASSWORD`, `APP_DB_READONLY_USER`, `APP_DB_READONLY_PASSWORD`, `APP_DB_NAME`, `DATABASE_URL` (explicit DSN, app_user), `DATABASE_SERVICE_URL` (explicit DSN, app_service), `DB_BACKUP_INTERVAL_SECONDS`, `DB_BACKUP_RETENTION_DAYS`, `DB_BACKUP_OBSERVABILITY_GRACE_SECONDS`, `DOLTGRES_PASSWORD` / `DOLTGRES_READER_PASSWORD` / `DOLTGRES_WRITER_PASSWORD` (provisioning; derived deterministically from `POSTGRES_ROOT_PASSWORD` in deploy-infra.sh), `APP_BASE_URL`, `NEXTAUTH_URL`, `AUTH_SECRET`, `LITELLM_MASTER_KEY`, `OPENROUTER_API_KEY`, `LITELLM_DATABASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `LANGFUSE_TRACING_ENVIRONMENT` (derived from DEPLOY_ENVIRONMENT), `GRAFANA_CLOUD_LOKI_URL`, `GRAFANA_CLOUD_LOKI_USER`, `GRAFANA_CLOUD_LOKI_API_KEY`, `GRAFANA_PDC_SIGNING_TOKEN`, `GRAFANA_PDC_HOSTED_GRAFANA_ID`, `GRAFANA_PDC_CLUSTER`, `GRAFANA_PDC_NETWORK_ID`, `GRAFANA_PDC_NETWORK_UUID`, `METRICS_TOKEN` (app+alloy), `BILLING_INGEST_TOKEN` (app+litellm, callback auth), `INTERNAL_OPS_TOKEN` (app internal ops auth), `COGNI_NODE_ENDPOINTS` (litellm, per-node callback routing), `PROMETHEUS_REMOTE_WRITE_URL` (alloy), `PROMETHEUS_USERNAME` (alloy), `PROMETHEUS_PASSWORD` (alloy), `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `TEMPORAL_DB_USER`, `TEMPORAL_DB_PASSWORD`, `TEMPORAL_DB_HOST`, `TEMPORAL_DB_PORT`
- **Files considered API:** `docker-compose.yml`, `db-backup/*.sh`, `postgres-init/*.sh`, `configs/alloy-config.alloy`, `sandbox-proxy/nginx-gateway.conf.template`, `openclaw/openclaw-gateway.json`

## Responsibilities

- This directory **does**: Provide production runtime configuration copied to VM hosts for deployment (app, postgres, litellm, alloy, temporal). Includes LiteLLM networking + database wiring in dev stack.
- This directory **does not**: Handle TLS termination (see `../edge/`), build-time configuration, or development-only settings

## Usage

**SECURITY WARNING**: This directory is copied to production VMs. Never commit secrets.

```bash
# Production deployment (via deploy script, uses explicit project name)
docker compose --project-name cogni-runtime up -d --remove-orphans

# Database migration (via deploy script, uses db-migrate service)
docker compose --project-name cogni-runtime --profile bootstrap run --rm db-migrate

# View logs
docker compose --project-name cogni-runtime logs -f app
```

## Standards

- All secrets via environment variables (never hardcoded)
- Database initialization scripts must be idempotent
- Production-ready health checks required for all services

## Dependencies

- **Internal:** postgres-init scripts, service configs
- **External:** Docker, PostgreSQL, environment variables from deployment

## Change Protocol

- Update this file when **runtime configuration** changes
- Bump **Last reviewed** date
- Changes affect production deployment - coordinate with operations

## Notes

- **HIGHLY PROTECTED**: This directory is rsync'd to production VMs
- **Edge split**: TLS termination (Caddy) is in separate `../edge/` project to prevent ERR_CONNECTION_RESET during deploys
- **Shared network**: Runtime and edge share `cogni-edge` external network for service DNS resolution
- Database security uses two-user model (root + app credentials)
- Init scripts run only on first postgres container startup
- `NEXTAUTH_URL` env var provided with shell fallback to `APP_BASE_URL`; Auth.js uses `trustHost: true` (safe behind Caddy)
- Log collection: Alloy scrapes Docker containers (JSON stdout), tails k3s pod logs from `/var/log/pods`, and ships Kubernetes Events through `alloy-k8s-events`; applies strict label cardinality (app, env, service, stream/source plus low-cardinality event reason/type/kind); suppresses successful health-check/metrics-scrape log noise at pipeline level
- Alloy infra metrics: cAdvisor (container memory/CPU/OOM/network/disk) + node exporter (host memory/CPU/filesystem/network) → Grafana Cloud Mimir via strict 18-metric allowlist
- Alloy host mounts: `/proc:/host/proc:ro`, `/sys:/host/sys:ro`, `/:/host/root:ro` (required for node exporter)
- Alloy UI exposed at 127.0.0.1:12345 (internal only)
- `DEPLOY_ENVIRONMENT` must be set (local|candidate-a|preview|production) - used for env label, fail-closed validation
- `db-migrate` service runs via `--profile bootstrap`, receives only DB env vars (least-secret exposure)
- `db-backup` is a `--profile backup` one-shot service, scheduled on deployed VMs by the host `cogni-db-backup.timer`; it runs `pg_dump`/`pg_dumpall --globals-only` against app Postgres and Temporal Postgres every `DB_BACKUP_INTERVAL_SECONDS` (default 24h), waits briefly for Alloy log collection via `DB_BACKUP_OBSERVABILITY_GRACE_SECONDS` (default 90s), and dumps live in the persistent `db_backups` volume with `DB_BACKUP_RETENTION_DAYS` retention (default 14d)
- `MIGRATOR_IMAGE` required in production compose (no fallback), derived from APP_IMAGE with `-migrate` suffix
- `git-sync` runs as bootstrap profile service (prod) or regular service (dev), populates `repo_data` volume at `/repo/current` via atomic symlink
- App reads `COGNI_REPO_PATH=/repo/current` in all environments; `COGNI_REPO_REF` pins to deploy commit SHA
- `openclaw-gateway` mounts `repo_data:/repo:ro` + `cogni_workspace:/workspace` (named volume, pnpm hardlinks require same fs as pnpm_store) + `pnpm_store:/pnpm-store`
- Both dev and prod git-sync clone via HTTPS from `COGNI_REPO_URL` at `COGNI_REPO_REF` with `GIT_READ_TOKEN` auth (same path everywhere, no file:// shortcut)

**Local Dev (docker-compose.dev.yml):**

- Includes local Loki + Grafana + Caddy services (unified for simplicity)
- Alloy writes to local Loki (http://loki:3100)
- Grafana on http://localhost:3001 (anonymous admin access)
- No cloud credentials needed

**Preview/Production (docker-compose.yml):**

- Caddy runs in separate edge project (see `../edge/`)
- Alloy writes to Grafana Cloud Loki
- Environment variables: `DEPLOY_ENVIRONMENT`, `LOKI_WRITE_URL`, `LOKI_USERNAME`, `LOKI_PASSWORD`
- Metrics: App exposes `/api/metrics` (auth via `METRICS_TOKEN`); Alloy scrapes app + cAdvisor + node exporter and ships to Mimir (via `PROMETHEUS_*`)
- Verify in Alloy UI (http://127.0.0.1:12345) and Grafana Cloud

**OpenClaw Gateway Services (profile: sandbox-openclaw):**

- `llm-proxy-openclaw`: nginx auth-injecting proxy on `sandbox-internal` network, injects `LITELLM_MASTER_KEY`
- `openclaw-gateway`: long-running OpenClaw gateway on `sandbox-internal` + `internal`, port 127.0.0.1:3333→18789
- Both behind `sandbox-openclaw` profile — activated by deploy.sh `--profile sandbox-openclaw`
- Config: `sandbox-proxy/nginx-gateway.conf.template` (nginx), `openclaw/openclaw-gateway.json` (OpenClaw)
- Networks: `sandbox-internal` (internal: true) for isolation; `litellm` on both `internal` and `sandbox-internal`
- Post-deploy health gate: `healthcheck-openclaw.sh` fails deploy if either service crashes or times out

**Doltgres (knowledge plane):**

- `doltgres`: Postgres-wire-compatible Dolt server, host port 5435→5432, volume `doltgres_data`. Public-NIC traffic on 5435 is dropped by `DOCKER-USER` chain (see `infra/provision/cherry/harden-docker-public-ports.sh`); k3s pods on `10.42.0.0/16` reach it via the EndpointSlice node IP. Image pinned to `dolthub/doltgresql:0.56.3` (bug.5076 — `:latest` rolled an auth-file format change that broke the persistent volume). Entrypoint is wrapped by `doltgres-init/install-creds.sh` — when `DOLT_CREDS_JWK` + `DOLT_CREDS_KEYID` are set, installs the keypair at `/root/.dolt/creds/<keyid>.jwk` and merges `user.creds` into `config_global.json` before exec'ing the upstream entrypoint; no-op when unset.
- `doltgres-provision` (profile: bootstrap): creates roles + per-node `knowledge_<node>` databases via `doltgres-init/provision.sh`. Schema owned by drizzle-kit (k8s PreSync Job), not this script
- Doltgres 0.56 RBAC is non-functional — runtime `DOLTGRES_URL_*` in k8s secrets connects as `postgres` superuser. Writer role is provisioned but vestigial until upstream GRANT works
- Mirror env vars (operator only): `DOLT_CREDS_JWK`, `DOLT_CREDS_KEYID` (in all envs; harmless inert when no remote configured), `DOLTHUB_REMOTE_URL` (production only — the writer-presence gate). See [`docs/runbooks/dolthub-remote-bootstrap.md`](../../../docs/runbooks/dolthub-remote-bootstrap.md).
- See [knowledge data plane spec](../../../docs/spec/knowledge-data-plane.md)

**Temporal Services:**

- `temporal-postgres`: Dedicated Postgres for Temporal (not shared with app DB)
- `temporal`: Temporal server with auto-setup (handles schema migrations), pinned to v1.29.1
- `temporal-ui`: Web UI for debugging schedules (localhost:8233)
- Namespace auto-created via `DEFAULT_NAMESPACE=cogni-{APP_ENV}`
- Port forwarding: host port 7233 (gRPC) — public-NIC traffic dropped by `DOCKER-USER` (see `infra/provision/cherry/harden-docker-public-ports.sh`); k3s pods reach via node IP. UI on 127.0.0.1:8233.

**Playwright MCP (profile: mcp-playwright, dev-only):**

- `playwright-mcp`: Browser automation MCP server on `cogni-edge`, port 127.0.0.1:3003→3003
- Image: `mcr.microsoft.com/playwright/mcp`, Streamable HTTP on `/mcp`
- Env: `MCP_PLAYWRIGHT_URL` on app service (default: `http://playwright-mcp:3003/mcp`)
- Start: `pnpm dev:infra:mcp`
- Not in production compose — dev-only. See [MCP Control Plane Spec](../../../docs/spec/mcp-control-plane.md)
