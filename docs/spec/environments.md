---
id: environments-spec
type: spec
title: Environment & Stack Deployment Modes
status: active
spec_state: draft
trust: draft
summary: Six deployment modes from app-only to full production stack, with env var loading patterns, port assignments, and infrastructure details.
read_when: Setting up local development, running tests, understanding deployment modes, or debugging env var loading.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [deployment]
---

# Environment & Stack Deployment Modes

## Context

The project supports 6 deployment modes (from app-only to full production stack) to serve different development, testing, and deployment needs. Each mode has specific infrastructure, environment variable loading patterns, and port assignments.

## Goal

Provide clear, well-defined deployment modes so developers can choose the right environment for their task — from fast UI-only iteration to full CI-parity testing to production deployment.

## Non-Goals

- Multi-machine deployment orchestration (single-machine Docker Compose only)
- Cloud-native orchestration (Kubernetes, ECS — deployment is bare-metal SSH)

## Core Invariants

1. **APP_ENV_ADAPTER_SWITCH**: `APP_ENV=production` activates real adapters (external API calls); `APP_ENV=test` activates fake adapters (deterministic, no external calls). This is the single switch that controls adapter selection.

2. **TEST_ENV_OVERRIDE_PATTERN**: Test modes load env as `dotenv -e .env.test -e .env.local` — `.env.test` loads first and overrides `.env.local` values, ensuring test values take precedence.

3. **CONTAINER_INTERNAL_HOST**: All containerized services communicate via Docker internal hostnames (`postgres:5432`), not `localhost`. Host-mode tests connect via mapped ports (`localhost:55432`).

4. **PRODUCTION_NO_DEBUG_PORTS**: Full production Docker Stack exposes no debug ports — all services are internal-only behind Caddy HTTPS.

## Design

### When to Use Each Mode

| Mode                  | Purpose                                                 | Command                  |
| --------------------- | ------------------------------------------------------- | ------------------------ |
| **App Only**          | Pure UI development, component work, no backend needed  | `pnpm dev`               |
| **Host Stack Dev**    | Daily development with real external services           | `pnpm dev:stack`         |
| **Host Stack Test**   | Development testing with fake adapters, predictable     | `pnpm dev:stack:test`    |
| **Docker Dev Stack**  | Simulate real production-like local deployment          | `pnpm docker:dev:stack`  |
| **Docker Test Stack** | CI/CD testing with fake adapters, production simulation | `pnpm docker:test:stack` |
| **Docker Stack**      | Full production deployment, hardened compose            | `pnpm docker:stack`      |

### Environment Variable System

**Base Configuration:** `.env.local`

- Database DSNs: `DATABASE_URL`, `DATABASE_SERVICE_URL` (explicit, distinct users per [database-rls.md](./database-rls.md))
- App settings: `APP_ENV=production`, `LITELLM_MASTER_KEY`, etc.
- Provisioning vars (for `provision.sh` only): `APP_DB_USER`, `APP_DB_PASSWORD`, `APP_DB_SERVICE_PASSWORD`, `APP_DB_NAME`

**Test Overrides:** `.env.test`

- `APP_ENV=test` (enables fake adapters)
- `DATABASE_URL`, `DATABASE_SERVICE_URL` pointing to test database
- `POSTGRES_DB=cogni_template_stack_test` (for tooling scripts only)

**Loading Pattern:** `dotenv -e .env.test -e .env.local`

- `.env.test` loads first and overrides `.env.local` values
- Test values like `APP_ENV=test` take precedence over base `APP_ENV=production`

### Mode Details

#### 1. App Only (`pnpm dev`)

**Purpose:** Fast UI development with no infrastructure dependencies

**Infrastructure:** Next.js dev server only. No database, no external services. Routes that require database/services will error.

**Environment:** Minimal — may not load full environment.
**Use Case:** Pure UI/frontend development, component work, styling changes.

#### 2. Host Stack Development (`pnpm dev:stack`)

**Purpose:** Fast local development workflow

**Infrastructure:**

- Next.js runs directly on host (no containers)
- PostgreSQL container on `localhost:5432`
- LiteLLM container on `localhost:4000`

**Environment:** Uses `.env.local` only — `APP_ENV=production` (real adapters), `POSTGRES_DB=cogni_template_dev`, `DB_HOST=localhost`.

#### 3. Host Stack Test (`pnpm dev:stack:test` + `pnpm test:stack:dev`)

**Purpose:** Stack testing with real app server but fake adapters

**Infrastructure:**

- Next.js runs directly on host in test mode
- PostgreSQL container on `localhost:5432`
- LiteLLM container on `localhost:4000`

**Environment:** `.env.local` + `.env.test` override — `APP_ENV=test` (fake adapters), `POSTGRES_DB=cogni_template_stack_test`, `DB_HOST=localhost`, `TEST_BASE_URL=http://localhost:3000/`.

**Commands:**

```bash
pnpm dev:stack:test           # Start test app server
pnpm dev:stack:test:setup     # Create test database + migrations
pnpm test:stack:dev           # Run stack tests against host app
```

#### 4. Docker Dev Stack (`pnpm docker:dev:stack`)

**Purpose:** Production-like deployment for integration testing

**Infrastructure:**

- All services containerized (app, postgres, litellm, openfga, caddy)
- Caddy provides HTTPS on `https://localhost/`
- PostgreSQL exposed on `localhost:55432` for debugging

**Environment:** Uses `.env.local` passed to Docker Compose — `APP_ENV=production` (real adapters), `DB_HOST=postgres` (inter-container communication).

**Commands:**

```bash
pnpm docker:dev:stack         # Build and start all containers
pnpm docker:dev:stack:fast    # Start containers without building
pnpm db:migrate               # Run migrations with drizzle-kit (.env.local)
```

#### 5. Docker Dev Stack Test (`pnpm docker:test:stack` + `pnpm test:stack:docker`)

**Purpose:** Full containerized testing — used in CI

**Infrastructure:**

- All services containerized in test mode
- Caddy provides HTTPS on `https://localhost/`
- PostgreSQL exposed on `localhost:55432` for test access

**Environment:** `dotenv -e .env.test -e .env.local` passed to Docker Compose — `APP_ENV=test` (fake adapters), `DB_HOST=postgres` (for containers), `localhost:55432` (for host tests).

**Commands:**

```bash
pnpm docker:test:stack          # Build and start containers in test mode
pnpm db:migrate:test            # Run migrations with drizzle-kit (.env.test)
pnpm test:stack:docker          # Run tests against containerized app
```

**Test Environment Overrides:**

```bash
# test:stack:docker sets these for the test runner:
DB_HOST=localhost DB_PORT=55432 TEST_BASE_URL=https://localhost/
```

#### 6. Docker Stack (`pnpm docker:stack`)

**Purpose:** Full production hardened deployment for preview and production environments

**Infrastructure:**

- All services containerized with hardened compose file
- Only accessible via Caddy HTTPS
- No debug ports exposed; shared infra ports are published only when k3s pods need VM access and are firewall-hardened
- Production security configuration

**Environment:** Automatically loads `.env.local` for local development, uses CI environment variables in production.

**Commands:**

```bash
pnpm docker:stack         # Build and start production simulation locally
pnpm docker:stack:fast    # Start containers without building
# Migrations: use db-migrate service via docker compose directly
```

**Use Cases:** Production deployments (CI/CD), preview deployments, black box e2e testing, local production simulation.

### Database URL Construction

All modes use `buildDatabaseUrl()` to construct URLs from pieces:

```typescript
// Host modes
postgresql://postgres:postgres@localhost:5432/cogni_template_stack_test

// Container modes (internal)
postgresql://postgres:postgres@postgres:5432/cogni_template_stack_test

// Host tests -> container postgres
postgresql://postgres:postgres@localhost:55432/cogni_template_stack_test
```

### Port Summary

| Service    | App Only         | Host Stack Dev    | Host Stack Test  | Docker Dev Stack    | Docker Test Stack   | Docker Stack           |
| ---------- | ---------------- | ----------------- | ---------------- | ------------------- | ------------------- | ---------------------- |
| App        | `localhost:3000` | `localhost:3000`  | `localhost:3000` | `https://localhost` | `https://localhost` | `https://localhost`    |
| PostgreSQL | None             | `localhost:55432` | `localhost:5432` | `localhost:55432`   | `localhost:55432`   | VM-internal pod bridge |
| LiteLLM    | None             | `localhost:4000`  | `localhost:4000` | Internal only       | Internal only       | VM-internal pod bridge |
| OpenFGA    | None             | None              | None             | `localhost:8080`    | `localhost:8080`    | VM-internal pod bridge |

Docker Dev Stack modes expose PostgreSQL on `55432` for debugging and test access. Full production Docker Stack publishes selected shared infra ports only for k3s pod access through VM DNS; public-NIC traffic is dropped by `infra/provision/cherry/harden-docker-public-ports.sh`. All containers communicate internally via service DNS such as `postgres:5432` and `openfga:8080`.

### File Pointers

| File                                           | Role                         |
| ---------------------------------------------- | ---------------------------- |
| `infra/compose/runtime/docker-compose.dev.yml` | Dev/test Docker Compose      |
| `infra/compose/runtime/docker-compose.yml`     | Production Docker Compose    |
| `.env.local.example`                           | Base env template            |
| `.env.test`                                    | Test overrides               |
| `src/shared/env/server.ts`                     | Env validation (Zod schemas) |

## Acceptance Checks

**Manual:**

1. `pnpm dev` starts Next.js without infrastructure dependencies
2. `pnpm dev:stack` starts host app + containerized postgres + litellm
3. `pnpm docker:test:stack` + `pnpm test:stack:docker` runs full CI-parity test suite
4. `pnpm docker:stack` exposes no debug ports (postgres not accessible on 55432)

## Open Questions

_(none)_

## Related

- [check:full CI-Parity Gate](./check-full.md) — CI-parity test orchestrator using these modes
- [Database URL Alignment](./database-url-alignment.md) — DSN single source of truth
- [CI/CD](./ci-cd.md) — Deployment pipeline using Docker Stack mode
