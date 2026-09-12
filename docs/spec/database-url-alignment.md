---
id: database-url-alignment-spec
type: spec
title: Database URL Alignment — DSN Single Source of Truth
status: active
spec_state: draft
trust: draft
summary: Database configuration contract — runtime containers receive only DATABASE_URL and DATABASE_SERVICE_URL, with provisioning credentials strictly isolated.
read_when: Working with database connection strings, provisioning, deployment secrets, or container env configuration.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [infra, deployment]
---

# Database URL Alignment — DSN Single Source of Truth

## Context

> [!CRITICAL]
> **Phased Reality:** Runtime containers are DSN-only today. Provisioning is transitioning to DSN-only. Until the provisioner is rewritten, provisioning uses component vars (`APP_DB_*`, `POSTGRES_ROOT_*`), but these must **never** reach runtime containers.

Database configuration has historically used a mix of component variables (`APP_DB_HOST`, `APP_DB_PORT`, etc.) and full DSN strings. This creates drift risk and security surface. The target state is 3 DSNs as the only database secrets.

**End State Contract (target):** Three DSNs are the only database secrets:

| Secret                 | Purpose                          | Consumed By                                     |
| ---------------------- | -------------------------------- | ----------------------------------------------- |
| `DATABASE_ROOT_URL`    | Admin/superuser for provisioning | `db-provision` only                             |
| `DATABASE_URL`         | App user (RLS enforced)          | `app`, `migrate`, `compute-workload-controller` |
| `DATABASE_SERVICE_URL` | Service user (BYPASSRLS)         | `app`, `scheduler-worker`                       |

## Goal

Establish a clear security boundary between provisioning and runtime database credentials, ensuring runtime containers never receive admin/root credentials and all database configuration converges to DSN-only.

## Non-Goals

- IaC-managed role creation (Terraform/OpenTofu — deferred as optional future improvement)
- Runtime DSN rotation without restart (standard restart-based rotation is sufficient)

## Core Invariants

1. **AUTHORITATIVE_INPUTS_PER_PHASE**: Provisioning uses `POSTGRES_ROOT_*`, `APP_DB_*`, `COGNI_NODE_DBS`, and `LITELLM_DB_NAME` — all required, no defaults. Runtime uses only `DATABASE_URL` and `DATABASE_SERVICE_URL`.

2. **RUNTIME_DSN_ONLY**: Runtime containers (`app`, `scheduler-worker`, `migrate`) receive **only** `DATABASE_URL` and/or `DATABASE_SERVICE_URL`. They never receive `DATABASE_ROOT_URL`, `APP_DB_*` component vars, or `POSTGRES_ROOT_*` credentials. **Enforcement:** CI validation fails if runtime container env blocks contain forbidden vars.

3. **ROLE_ISOLATION**: `DATABASE_URL.username` ≠ `DATABASE_SERVICE_URL.username`. Denylist: `{postgres, root, admin, superuser}`. **Enforcement:** `validate-dsns.sh` in CI; runtime startup invariant check.

4. **NO_HARDCODED_HOSTS_IN_CODE**: Provisioner and CI scripts must not assume `postgres:5432` or any specific host/port. Host and port are parsed from DSNs at runtime (using `URL` class or equivalent) or injected via environment in provisioning lane. **Enforcement:** Code review; no literal `postgres` or `5432` in scripts except in example `.env` files.

5. **PROVISIONING_TRUST_BOUNDARY**: Provisioning credentials (`DATABASE_ROOT_URL` or `POSTGRES_ROOT_*`) must never cross into runtime containers. This is a hard security boundary.

## Design

### Provisioning Lane vs Runtime Lane

```
┌─────────────────────────────────────────────────────────────────────┐
│ PROVISIONING LANE (db-provision container)                          │
│ ─────────────────────────────────────────                           │
│ Responsibilities:                                                   │
│   - CREATE/ALTER ROLE                                               │
│   - GRANT privileges                                                │
│   - ALTER DATABASE ... OWNER                                        │
│   - ALTER DEFAULT PRIVILEGES                                        │
│                                                                     │
│ Credentials (P0): POSTGRES_ROOT_*, APP_DB_*                         │
│ Credentials (P1+): DATABASE_ROOT_URL, DATABASE_URL,                 │
│                    DATABASE_SERVICE_URL                             │
│                                                                     │
│ Trust boundary: runs once at deploy, before app starts              │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ provisioning complete
┌─────────────────────────────────────────────────────────────────────┐
│ RUNTIME LANE (app, scheduler-worker, migrate, compute controller)   │
│ ─────────────────────────────────────────────                       │
│ Responsibilities:                                                   │
│   - Serve HTTP traffic                                              │
│   - Execute background jobs                                         │
│   - Run migrations (RLS-enforced)                                   │
│                                                                     │
│ Credentials: DATABASE_URL, DATABASE_SERVICE_URL only                │
│                                                                     │
│ Trust boundary: never has admin privileges                          │
└─────────────────────────────────────────────────────────────────────┘
```

### Per-Container Env Contract

| Container                     | Receives                                                           |
| ----------------------------- | ------------------------------------------------------------------ |
| `app`                         | `DATABASE_URL`, `DATABASE_SERVICE_URL`                             |
| `scheduler-worker`            | `DATABASE_SERVICE_URL`                                             |
| `migrate`                     | `DATABASE_URL`                                                     |
| `compute-workload-controller` | `DATABASE_URL` only                                                |
| `db-provision`                | `POSTGRES_ROOT_*`, `APP_DB_*`, `COGNI_NODE_DBS`, `LITELLM_DB_NAME` |

**Forbidden in runtime containers:** `APP_DB_*`, `POSTGRES_ROOT_*`, `COGNI_NODE_DBS`, `LITELLM_DB_NAME`

**Required by provisioning (no defaults):** `COGNI_NODE_DBS` (comma-separated node DB names), `LITELLM_DB_NAME`

### Implementation Status (P0)

P0 runtime isolation is complete:

- `validate-dsns.sh` created (distinct users, no superusers, non-empty, masks outputs)
- Validation script called from `deploy-production.yml` and `staging-preview.yml`
- Runtime env validated to NOT include `APP_DB_*` / `POSTGRES_ROOT_*` (enforced by `assertEnvInvariants()` + docker-compose verified)
- INFRASTRUCTURE_SETUP.md documents two config surfaces (runtime DSNs + provisioning inputs)

### File Pointers

| File                                      | Role                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `scripts/ci/validate-dsns.sh`             | CI DSN validation script                          |
| `.github/workflows/deploy-production.yml` | Calls DSN validator before deploy                 |
| `.github/workflows/staging-preview.yml`   | Calls DSN validator before deploy                 |
| `docs/runbooks/INFRASTRUCTURE_SETUP.md`   | Documents two config surfaces                     |
| `src/shared/env/invariants.ts`            | Runtime startup invariant check (role separation) |

## Acceptance Checks

**Automated:**

- CI `validate-dsns.sh` fails if `DATABASE_URL.username == DATABASE_SERVICE_URL.username`
- CI `validate-dsns.sh` fails if either DSN uses a denylisted superuser name
- Runtime `assertEnvInvariants()` fails if forbidden vars are present in runtime env

**Manual:**

1. Verify `db-provision` container has provisioning credentials but runtime containers do not
2. Verify `validate-dsns.sh` masks credential output in CI logs

## Open Questions

_(none — P1 DSN-only provisioning and P2 secret cleanup tracked in proj.cicd-services-gitops.md)_

## Related

- [Database RLS](./database-rls.md) — Tenant isolation, dual DB roles
- [Databases](./databases.md) — Two-user model, migration strategy
- [CI/CD](./ci-cd.md) — Deployment pipeline, secret management
