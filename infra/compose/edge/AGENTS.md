# edge · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Always-on TLS termination layer (Caddy). Isolated from app deployments to prevent ERR_CONNECTION_RESET during deploys. Started once at bootstrap, rarely touched.

## Pointers

- [docker-compose.yml](docker-compose.yml): Edge stack (Caddy only)
- [configs/Caddyfile.tmpl](configs/Caddyfile.tmpl): **generated** by `scripts/ci/render-caddyfile.sh` from `infra/catalog/*.yaml` (task.5078) — edit the catalog + `pnpm gen:caddyfile`, never by hand; CI `render-caddyfile.test.sh` gates drift
- [Runtime stack](../runtime/): App + postgres + litellm + alloy (mutable, updated each deploy)

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
- **Routes (if any):** `/api/v1/public/*` (rate limited, X-Real-IP header)
- **CLI (if any):** `docker compose --project-name cogni-edge -f docker-compose.yml`
- **Env/Config keys:** `DOMAIN`, `OPERATOR_UPSTREAM`, and one `<SLUG>_DOMAIN` per non-primary `type: node` (written to `.env` by `deploy-infra.sh` / `provision-env-vm.sh`; Caddy reads them via `env_file`)
- **Files considered API:** `docker-compose.yml`, `configs/Caddyfile.tmpl` (generated — see Pointers)

## Ports (optional)

- **Uses ports:** 80 (HTTP), 443 (HTTPS)
- **Implements ports:** none
- **Contracts (required if implementing):** none

## Responsibilities

- This directory **does**: TLS termination, HTTP→HTTPS redirect, reverse proxy to app:3000
- This directory **does not**: Handle app logic, database, observability, or any mutable services

## Usage

**INVARIANTS:**

- **Never** run `docker compose down` on edge during app deploys
- Only restart edge on Caddyfile changes or cert issues
- Edge and runtime share `cogni-edge` external network

```bash
# Start edge (idempotent - safe to run multiple times)
docker network create cogni-edge 2>/dev/null || true
docker compose --project-name cogni-edge up -d

# Check status
docker compose --project-name cogni-edge ps

# Reload Caddy config (no restart needed)
docker compose --project-name cogni-edge exec caddy caddy reload --config /etc/caddy/Caddyfile

# View logs
docker compose --project-name cogni-edge logs -f caddy
```

## Standards

- External network `cogni-edge` must exist before compose up
- Caddy volumes (`caddy_data`, `caddy_config`) persist TLS certs - never prune
- No `container_name` - let Compose namespace containers per project

## Dependencies

- **Internal:** Shared `cogni-edge` network with runtime stack
- **External:** Docker, DNS pointing to VM

## Change Protocol

- Update this file when **edge configuration** changes
- Bump **Last reviewed** date
- Changes here rarely needed - edge is immutable infrastructure

## Notes

- Edge split from runtime to eliminate ERR_CONNECTION_RESET during deploys
- Caddy auto-obtains TLS certs via ACME (Let's Encrypt)
- App must be on `cogni-edge` network for Caddy to reverse_proxy to it
- Deploy script handles checksum-gated Caddy reload on Caddyfile changes
