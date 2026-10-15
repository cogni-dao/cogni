# postgres-init · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft
- **Last reviewed:** 2026-10-15

## Purpose

Scripts for initializing and provisioning PostgreSQL databases in Docker environments.

## Pointers

- [provision.sh](./provision.sh)
- [docker-compose.dev.yml](../docker-compose.dev.yml)

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** provision.sh; apply-control.sql; explicitly invoked install-cell-control.sql / install-cell-logical-probe.sql and immutable control-migrations for the declared administrative schema
- **CLI (if any):** Executed via `db-provision` service
- **Env/Config keys:** `DB_HOST`, `POSTGRES_ROOT_USER`, `POSTGRES_ROOT_PASSWORD`, `APP_DB_NAME`, `APP_DB_USER`, `APP_DB_PASSWORD`, `APP_DB_SERVICE_USER`, `APP_DB_SERVICE_PASSWORD`, `APP_DB_READONLY_USER`, `APP_DB_READONLY_PASSWORD`, `LITELLM_DB_NAME` (note: these are provisioning vars, not runtime app vars)
- **Files considered API:** `provision.sh`

## Responsibilities

- This directory **does**: Create databases (idempotent), create app role with login credentials, set database ownership, ensure isolation for LiteLLM DB.
- This directory **does not**: Manage schema (migrations), manage data (seeds), rotate passwords, grant table-level privileges, or run automatically on container start.

## Usage

Minimal local commands:

```bash
docker compose --profile bootstrap up db-provision
```

## Standards

1. **DATABASE_URL is canonical**: Every script must accept/use DATABASE_URL as the primary input; “build from pieces” is allowed only for local dev and must require DB_HOST explicitly (no implicit localhost).
2. **No initdb.d dependency**: Nothing in this directory is assumed to run automatically on container start; if initdb.d exists, it is explicitly local-only sugar for fresh volumes.
3. **Provisioning is explicit and one-shot**: The only supported execution model is a manually invoked job/service (e.g., compose profile bootstrap) that exits 0 on success; normal docker compose up must not provision.
4. **Idempotent + deterministic**: Re-running provisioning must be safe (no destructive drops by default) and apply changes in a fixed order; any destructive operation requires an explicit opt-in flag.
5. **App schema ownership stays with app migrations**: This directory creates DBs/roles/grants. The explicitly declared root-owned administrative `cogni_control` schema is generated from `packages/db-schema/infra-control.ts` through `infra/drizzle.control.config.ts`; its versioned SQL is applied atomically in administrative postgres so recovery intent and global role admission share one transaction.
6. **No secrets in logs**: Never print full DATABASE_URL or passwords; always redact.
7. **Safety rails for destructive tooling**: Any script that can drop/truncate must print a one-line target fingerprint (host:port db user) and refuse unless the target matches an allowlist or an explicit override is set.

## Dependencies

- **Internal:** none
- **External:** psql (PostgreSQL client)

## Change Protocol

- Update this file when **Exports**, **Routes**, or **Env/Config** change
- Bump **Last reviewed** date
- Update ESLint boundary rules if **Boundaries** changed

## Notes

- Provisioning scripts are designed to be run from a dedicated container (`db-provision`) to ensure consistent environment and tools.

- `DATABASE_RECOVERY_PROBE_PASSWORD` enables the separate per-node probe; `COGNI_SYSTEM_BILLING_ACCOUNT_ID` comes from the canonical node-shared identity generator. Probe passwords/URLs live outside public node banks. PUBLIC CONNECT/TEMP defaults are not a per-role deny boundary; the root-owned probe exposes only scalar own-node evidence and refuses effective data mutation or unrelated definer authority.
