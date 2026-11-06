---
id: supabase-evaluation
type: research
title: Supabase Evaluation — Engineering Due Diligence
status: draft
trust: draft
summary: Full codebase inventory vs. Supabase capability map. Decision record for adopting only Supabase OSS building blocks (WAL-G, pgBouncer) — not the full platform.
read_when: Considering Supabase adoption, evaluating database ops primitives, or assessing architecture overlap with managed platforms.
owner: derekg1729
created: 2026-02-06
tags: [evaluation, database, infrastructure, supabase]
---

# Supabase Evaluation: Engineering Due Diligence

> **Date:** 2026-02-06
> **Scope:** Full codebase inventory vs. Supabase capability map
> **Status:** Decision-ready analysis (no recommendation until all facts stated)

---

## Context

This document evaluates whether to adopt Supabase (hosted or self-hosted) for our infrastructure. It inventories the current architecture, discovers invariants, maps Supabase capabilities against our implementations, and produces a decision-ready analysis.

## Goal

Document the engineering due diligence for Supabase adoption, establishing which primitives to adopt (WAL-G, pgBouncer) and which to keep custom (auth, RLS, API, observability, sandbox).

## Non-Goals

- Implementing any Supabase adoption (see [Database Ops Project](../../work/projects/proj.database-ops.md))
- Replacing SIWE auth, RLS policies, or API routes
- Self-hosting the full Supabase platform

## Core Invariants

1. **SUPABASE_OSS_ONLY**: Adopt only Supabase OSS building blocks (WAL-G, pgBouncer) — not the full Supabase self-hosted platform. The application, RLS model, provisioner, and DSN contract remain unchanged.

2. **SIWE_AUTH_NON_NEGOTIABLE**: Never replace SIWE auth with Supabase Auth. Wallet-first identity is a core differentiator.

3. **RLS_NO_REWRITE**: Keep our SET LOCAL `app.current_user_id` RLS pattern. Do not rewrite to Supabase's `auth.uid()` pattern.

4. **CONTRACTS_OVER_POSTGREST**: Keep Zod contract API routes. Do not adopt PostgREST — it cannot replicate billing hooks, observability, and contract validation.

## Design

### Current Architecture Inventory

### 1.1 Top-Level Architecture Map

```
                        Internet
                          │
                  ┌───────┴───────┐
                  │  Caddy (edge) │  ← TLS termination, always-on
                  │  :80 :443     │     project: cogni-edge
                  └───────┬───────┘
                          │ cogni-edge network (external)
      ┌───────────────────┤
      │                   │
 ┌────┴────┐      ┌──────┴──────┐
 │   app   │      │   litellm   │
 │  :3000  │      │   :4000     │
 │ Next.js │      │  LLM proxy  │
 └────┬────┘      └──────┬──────┘
      │                  │
      │    internal network (isolated)
 ┌────┴────────────┬─────┴────────┬──────────────┐
 │                 │              │              │
┌┴──────┐  ┌──────┴─────┐ ┌─────┴────┐  ┌──────┴──────┐
│postgres│  │  temporal  │ │  alloy   │  │ scheduler-  │
│ :5432  │  │   :7233    │ │  :12345  │  │   worker    │
│ PG 15  │  │ workflows  │ │ logs+met │  │  temporal   │
└────────┘  └──────┬─────┘ └──────────┘  └─────────────┘
                   │
            ┌──────┴──────┐
            │  temporal-  │
            │  postgres   │
            │   :5432     │
            └─────────────┘
```

### 1.2 Component Inventory

| Service               | Role                            | State it owns                  | Exposes to                           | External deps                         | Secrets required                                                                 | Persistence            |
| --------------------- | ------------------------------- | ------------------------------ | ------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------- |
| **caddy**             | TLS termination + reverse proxy | TLS certs                      | Internet (:80,:443) → app:3000       | DOMAIN                                | caddy_data volume                                                                |
| **app** (Next.js)     | Business logic, API, UI         | Session JWTs (cookie)          | Caddy reverse proxy                  | postgres, litellm, temporal, langfuse | AUTH_SECRET, LITELLM_MASTER_KEY, DATABASE_URL, DATABASE_SERVICE_URL, EVM_RPC_URL | None (stateless)       |
| **postgres**          | Primary data store              | All user/billing/schedule data | app, litellm, temporal, db-provision | None                                  | POSTGRES_ROOT_USER/PASSWORD                                                      | postgres_data volume   |
| **litellm**           | LLM proxy + cost tracking       | Spend logs (in PG)             | app, sandbox                         | OpenRouter API                        | OPENROUTER_API_KEY, LITELLM_MASTER_KEY                                           | LiteLLM DB in postgres |
| **temporal**          | Workflow orchestration          | Workflow state                 | scheduler-worker, app                | temporal-postgres                     | TEMPORAL_DB_USER/PASSWORD                                                        | temporal_postgres_data |
| **temporal-postgres** | Temporal state store            | Temporal internal state        | temporal only                        | None                                  | TEMPORAL_DB_USER/PASSWORD                                                        | temporal_postgres_data |
| **scheduler-worker**  | Temporal task executor          | None (reads/writes via app DB) | temporal task queue                  | app internal API, postgres            | DATABASE_SERVICE_URL, SCHEDULER_API_TOKEN                                        | None (stateless)       |
| **alloy**             | Log + metrics collection        | Buffer/cache                   | Docker socket, app:metrics           | Loki, Grafana Cloud                   | LOKI*\*, PROMETHEUS*\*, METRICS_TOKEN                                            | alloy_data volume      |
| **db-provision**      | DB role/schema bootstrap        | None (one-shot)                | postgres                             | None                                  | POSTGRES*ROOT*_, APP*DB*_                                                        | None                   |
| **db-migrate**        | Schema migrations               | None (one-shot)                | postgres                             | None                                  | DATABASE_URL                                                                     | None                   |
| **git-sync**          | Clone brain repo                | None                           | GitHub                               | None                                  | GIT_READ_TOKEN                                                                   | repo_data volume       |

### 1.3 Data Store Summary

| Store           | Technology                               | Tables/Objects                                       | Backup Status           | Pooling                                  | TLS                                       |
| --------------- | ---------------------------------------- | ---------------------------------------------------- | ----------------------- | ---------------------------------------- | ----------------------------------------- |
| **App DB**      | Postgres 15                              | 13 tables (users, billing, scheduling, ai telemetry) | **NONE** (critical gap) | Application-level (postgres npm, max 10) | Required for non-localhost (Zod enforced) |
| **LiteLLM DB**  | Postgres 15 (same instance, separate DB) | LiteLLM internal (spend_logs, etc.)                  | **NONE**                | LiteLLM internal                         | Same as app                               |
| **Temporal DB** | Postgres 15 (separate instance)          | Temporal internal                                    | **NONE**                | Temporal internal                        | No                                        |

---

### Invariant Discovery

### 2.1 Identity & Actor Invariants

| Invariant         | Status                       | Where enforced                                                                                              | Evidence                                                                                                                                                                      |
| ----------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ACTOR_PRESENT** | Partial                      | src/proxy.ts rejects unauthenticated /api/v1/\*; wrapRouteHandlerWithLogging has auth: { mode: "required" } | Every protected route resolves SessionUser { id, walletAddress } via getSessionUser(). Actor types (user/agent/service) designed in RBAC_SPEC.md but only "user" implemented. |
| **AUTH_BOUNDARY** | Yes                          | src/proxy.ts (Next.js proxy), src/auth.ts (NextAuth + SIWE)                                                 | Dedicated auth module. SIWE signature verification + JWT. Single boundary at /api/v1/\* matcher.                                                                              |
| **MFA/SSO**       | No MFA. SIWE only.           | src/auth.ts line 54-163                                                                                     | Single auth provider: SIWE (Sign-In with Ethereum) via NextAuth Credentials. No email/password, no OAuth, no MFA. Wallet signature = sole auth factor.                        |
| **SESSION/TOKEN** | JWT, 30-day, HttpOnly cookie | src/auth.ts lines 47-51; src/proxy.ts for validation                                                        | JWT created on SIWE verify, stored in HttpOnly cookie, validated by getToken() at proxy. No rotation. No revocation mechanism (30-day expiry only).                           |

### 2.2 Data & Database Invariants

| Invariant                 | Status               | Where enforced                                                                                | Evidence                                                                                                                                                                    |
| ------------------------- | -------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DSN_ONLY_RUNTIME**      | Yes                  | src/shared/env/server.ts requires DATABASE_URL + DATABASE_SERVICE_URL as explicit DSNs        | buildDatabaseUrl() is tooling-only (drizzle.config.ts). Runtime reads DSN directly.                                                                                         |
| **ROLE_SEPARATION**       | Yes                  | src/shared/env/invariants.ts assertEnvInvariants()                                            | Three roles: postgres (root, provisioning-only), app_user (RLS enforced), app_service (BYPASSRLS). Boot rejects same-user DSNs or superuser names.                          |
| **RLS_ENFORCED**          | Yes (P0 complete)    | src/adapters/server/db/migrations/0004_enable_rls.sql; packages/db-client/src/tenant-scope.ts | 10 tables with tenant_isolation policy. SET LOCAL app.current_user_id per transaction. Missing context = zero rows (fail-closed).                                           |
| **PROVISION_CONVERGENCE** | Create-or-skip (gap) | infra/compose/postgres-init/provision.sh                                                      | Currently creates roles if missing, does NOT ALTER ROLE ... PASSWORD for existing ones. P1 item in proj.database-ops.                                                       |
| **BACKUPS_EXIST**         | **NO**               | N/A                                                                                           | proj.database-ops line 2: "No backup exists today. A single docker volume rm or disk failure results in total data loss." WAL-G planned (P0 in that spec), not implemented. |

### 2.3 Network & Secrets Invariants

| Invariant              | Status                                 | Where enforced                                                                                                            | Evidence                                                                                                                                                                                         |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SECRETS_ISOLATION**  | Yes (design), partial (implementation) | Sandbox: SECRETS_HOST_ONLY invariant in docs/spec/sandboxed-agents.md. App: Zod validation in src/shared/env/server.ts.   | Secrets from GitHub Secrets → CI → SSH → VM .env → docker-compose env. Never baked into images. Sandbox containers get no secrets. P0.5 unix socket proxy will inject auth headers on host side. |
| **ENV_SEPARATION**     | Yes                                    | 6 deployment modes in docs/spec/environments.md; APP_ENV=production\|test controls adapter wiring                         | Separate .env.local / .env.test. GitHub Environments for preview/production. Separate VMs per environment.                                                                                       |
| **NETWORK_BOUNDARIES** | Yes                                    | docker-compose.yml defines cogni-edge (external) and internal (isolated) networks. sandbox-internal (dev, internal: true) | Postgres not exposed in production. Temporal bound to 127.0.0.1. Sandbox network=none by default.                                                                                                |

### 2.4 Observability & Audit Invariants

| Invariant                 | Status                             | Where enforced                                                                                                         | Evidence                                                                                                                                                                             |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **AUDIT_EVENTS**          | Partial (logging, not append-only) | src/shared/observability/events/index.ts (79 named events); logEvent() enforces reqId                                  | Structured JSON logs via Pino → Alloy → Loki. Events include payment state transitions, auth attempts, billing commits. NOT append-only or tamper-evident. No dedicated audit table. |
| **TRACE_CORRELATION**     | Yes                                | src/bootstrap/otel.ts withRootSpan(); src/shared/observability/context/types.ts                                        | reqId (UUID) + traceId (OTel 32-hex) propagated through all adapters. Forwarded to LiteLLM metadata and Langfuse traces.                                                             |
| **LLM_USAGE_ATTRIBUTION** | Yes (dual system)                  | DB: src/ports/ai-telemetry.port.ts → ai_invocation_summaries table. API: src/ports/usage.port.ts → LiteLLM /spend/logs | invocationId for idempotency, litellmCallId for join to spend logs, billingAccountId for cost attribution. LiteLLM is authoritative for billing; DB is observational.                |

### 2.5 Agent/Sandbox Invariants

| Invariant          | Status                           | Where enforced                                                  | Evidence                                                                                                                                                   |
| ------------------ | -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SANDBOX_GATING** | Yes (design + P0 implementation) | src/ports/sandbox-runner.port.ts; docs/spec/sandboxed-agents.md | SandboxRunnerPort.runOnce() enforces network=none, resource limits, capability drop (CapDrop: ["ALL"]), no-new-privileges, PidsLimit(256), ReadonlyRootfs. |
| **WRITE_PATHS**    | Designed, not fully enforced     | docs/spec/sandboxed-agents.md WRITE_PATH_IS_BRANCH invariant    | P0.5+: push to branch only. PR creation requires explicit request. Currently P0.5 in progress.                                                             |
| **TOOL_POLICY**    | Designed, not implemented        | docs/spec/rbac.md ToolPolicy layer; docs/spec/tool-use.md       | DENY_BY_DEFAULT designed. OpenFGA check before tool execution designed. P0 checklist items all unchecked in RBAC_SPEC.md.                                  |

---

### Supabase Capability Map

### 3.1 What Supabase Provides (Verified)

| Supabase Primitive     | Description                                                                                                     | Self-Hosted?    | Hosted?       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | --------------- | ------------- |
| **Auth (GoTrue)**      | User management, email/password, OAuth providers, magic links, phone, MFA (TOTP), JWT sessions, admin UI        | Yes             | Yes           |
| **Database**           | Postgres with extensions (pgvector, pg_cron, etc.), auto-generated REST/GraphQL (PostgREST), migrations via CLI | Yes             | Yes (managed) |
| **Row-Level Security** | Built-in RLS with auth.uid() function, policy templates, dashboard editor                                       | Yes             | Yes           |
| **Storage**            | S3-compatible object storage, buckets, access policies, signed URLs, image transforms                           | Yes             | Yes           |
| **Realtime**           | Postgres changes over WebSockets (INSERT/UPDATE/DELETE), Presence, Broadcast                                    | Yes             | Yes           |
| **Edge Functions**     | Deno-based serverless functions, deployed via CLI                                                               | Yes (limited)   | Yes           |
| **PostgREST API**      | Auto-generated REST API from Postgres schema, filtering, pagination, embedding                                  | Yes             | Yes           |
| **Connection Pooling** | Supavisor (multi-tenant PgBouncer alternative), transaction/session modes                                       | Yes             | Yes           |
| **Backups**            | PITR (Point-in-Time Recovery) via WAL archiving, daily snapshots                                                | Partial (WAL-G) | Yes (managed) |
| **Dashboard**          | SQL editor, table viewer, auth management, storage browser, logs, API docs                                      | Yes (Studio)    | Yes           |
| **Branching**          | Preview environments per Git branch with isolated databases                                                     | No              | Yes (beta)    |
| **Logging**            | API request logs, Postgres logs, Auth logs in dashboard                                                         | Partial         | Yes           |

### 3.2 Supabase Auth vs. Our Auth

| Capability          | Supabase Auth                            | Our Implementation                                     | Gap                        |
| ------------------- | ---------------------------------------- | ------------------------------------------------------ | -------------------------- |
| **Email/Password**  | Built-in                                 | Not implemented                                        | Not needed (Web3 identity) |
| **OAuth Providers** | Google, GitHub, Apple, etc.              | Not implemented                                        | Not needed (Web3 identity) |
| **Wallet/SIWE**     | **Not built-in** (community plugin only) | **Full implementation** (src/auth.ts, SIWE + NextAuth) | Supabase lacks this        |
| **MFA**             | TOTP built-in                            | Not implemented                                        | Could use if needed        |
| **JWT Sessions**    | Built-in, rotatable                      | Built-in (NextAuth), no rotation                       | Comparable                 |
| **User Table**      | auth.users (managed)                     | public.users (custom, wallet_address PK)               | Different schemas          |
| **Admin UI**        | Dashboard                                | None                                                   | Supabase advantage         |
| **API Keys**        | anon/service_role keys                   | Roadmap (SECURITY_AUTH_SPEC.md)                        | Supabase has it now        |
| **RLS Integration** | auth.uid() function                      | current_setting('app.current_user_id')                 | Both work; ours is custom  |

### 3.3 Supabase Storage vs. Our Storage

| Capability           | Supabase Storage        | Our Implementation  | Gap                     |
| -------------------- | ----------------------- | ------------------- | ----------------------- |
| **File uploads**     | Built-in API + policies | **Not implemented** | We have no file storage |
| **Signed URLs**      | Built-in                | **Not implemented** | We have no file storage |
| **Image transforms** | Built-in                | N/A                 | We have no file storage |
| **S3-compatible**    | Yes (self-hosted MinIO) | N/A                 | We have no file storage |

### 3.4 Supabase Realtime vs. Our Realtime

| Capability            | Supabase Realtime    | Our Implementation                                   | Gap                            |
| --------------------- | -------------------- | ---------------------------------------------------- | ------------------------------ |
| **DB change streams** | Postgres → WebSocket | Not implemented                                      | Could be useful for dashboards |
| **Presence**          | Built-in             | Not implemented                                      | Not currently needed           |
| **Broadcast**         | Built-in             | Not implemented                                      | Not currently needed           |
| **SSE Streaming**     | Not a focus          | **Full implementation** (assistant-seam for AI chat) | Ours covers AI streaming well  |

### 3.5 Supabase DB Ops vs. Our DB Ops

| Capability             | Supabase (Hosted)       | Supabase (Self-Hosted) | Our Implementation                             |
| ---------------------- | ----------------------- | ---------------------- | ---------------------------------------------- |
| **Backups**            | PITR managed            | WAL-G (manual)         | **NONE** (critical gap)                        |
| **Connection pooling** | Supavisor built-in      | Supavisor/PgBouncer    | Application-level (max 10)                     |
| **SSL**                | Enforced                | Manual                 | Zod validation (non-localhost)                 |
| **Role separation**    | anon/service_role       | Manual                 | **3-role model** (root, app_user, app_service) |
| **RLS**                | Dashboard-managed       | SQL                    | **SQL** (10 tables, tested)                    |
| **Migrations**         | Supabase CLI            | Drizzle ORM            | **Drizzle** (4 migrations)                     |
| **Extensions**         | pgvector, pg_cron, etc. | Same                   | Standard PG 15                                 |

---

### Duplication + Gaps Analysis

### Table 2: Supabase Overlap Map

| Primitive              | Supabase provides?    | We duplicated? | What we built (where)                                                        | Recommended evaluation                                                                              | Migration difficulty |
| ---------------------- | --------------------- | -------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------- |
| **Auth**               | Yes (email/OAuth/MFA) | Partially      | SIWE + NextAuth (src/auth.ts, src/proxy.ts)                                  | **Keep ours** — Supabase doesn't support SIWE natively. Wallet-first auth is a core differentiator. | N/A (no swap)        |
| **User management**    | Yes (auth.users)      | Yes            | Custom users table (packages/db-schema/src/refs.ts)                          | **Keep ours** — wallet_address is primary identity, incompatible with Supabase auth.users           | N/A                  |
| **JWT sessions**       | Yes (GoTrue)          | Yes            | NextAuth JWT in HttpOnly cookies (src/auth.ts lines 47-51)                   | **Keep ours** — tightly coupled to SIWE flow                                                        | N/A                  |
| **RLS**                | Yes (auth.uid())      | Yes            | SET LOCAL app.current_user_id + 10 policies (migrations/0004_enable_rls.sql) | **Keep ours** — battle-tested with 6 integration tests, construction-time binding pattern           | N/A                  |
| **PostgREST API**      | Yes                   | No             | Custom Next.js API routes (18 routes, Zod contracts)                         | **Don't adopt** — we need contract validation, billing hooks, and auth proxy                        | N/A                  |
| **Storage**            | Yes                   | No             | **Not implemented**                                                          | **Evaluate for adoption** — if file uploads needed                                                  | Low                  |
| **Realtime**           | Yes (WebSocket)       | No (SSE only)  | assistant-stream for AI chat SSE                                             | **Evaluate if needed** — dashboard live updates could benefit                                       | Low-Med              |
| **Edge Functions**     | Yes (Deno)            | No             | All logic in Next.js routes                                                  | **Don't adopt** — our architecture is monolith-first, not serverless                                | N/A                  |
| **Connection pooling** | Yes (Supavisor)       | Partial        | Application-level (postgres npm, max 10)                                     | **Adopt pgBouncer** (simpler than Supavisor, already planned P2)                                    | Low                  |
| **Backups**            | Yes (PITR)            | **NO**         | **Not implemented** (critical gap)                                           | **Adopt WAL-G** or **use Supabase hosted** for managed PITR                                         | Low-Med              |
| **Dashboard**          | Yes (Studio)          | No             | None                                                                         | **Nice-to-have** — pgAdmin/DBeaver sufficient for now                                               | Low                  |
| **Migrations**         | Yes (CLI)             | Yes            | Drizzle ORM + drizzle-kit (4 migrations, 2-image strategy)                   | **Keep Drizzle** — tightly integrated with schema types                                             | N/A                  |
| **API gateway**        | Yes (Kong-based)      | Yes            | Caddy + Next.js proxy (src/proxy.ts)                                         | **Keep ours** — Caddy is simpler and already deployed                                               | N/A                  |
| **Observability**      | Yes (dashboard logs)  | Yes            | Pino → Alloy → Loki + Prometheus + Langfuse + OTel                           | **Keep ours** — significantly more comprehensive than Supabase logging                              | N/A                  |

### What We Duplicated That Supabase Provides

1. **Auth/sessions** — but ours is SIWE-native (Supabase would need custom hooks)
2. **RLS** — but ours uses SET LOCAL pattern (Supabase uses auth.uid())
3. **API routes** — but ours have Zod contracts, billing hooks, observability (PostgREST can't do this)

### What We're Missing That Supabase Provides

1. **Backups/PITR** — **CRITICAL**: No backup exists today
2. **Object storage** — No file upload capability
3. **Connection pooling** — Application-level only, no pgBouncer/Supavisor
4. **Realtime subscriptions** — No DB change streaming (only SSE for AI)
5. **Admin dashboard** — No SQL editor or data browser
6. **MFA** — No second factor (wallet signature is sole auth)

### What Neither Side Provides

1. **Append-only audit ledger** — For high-risk actions with tamper evidence
2. **Agent sandbox gating** — Capability security model (our design, partially built)
3. **PR-only write paths** — Provenance chain for agent changes
4. **Usage/billing ledger tied to runId** — Our dual-system attribution
5. **OpenFGA authorization** — Fine-grained RBAC/ReBAC (our design, not built)
6. **Temporal workflows** — Scheduled execution with grants
7. **LLM proxy with cost attribution** — LiteLLM with billing metadata injection
8. **Crypto payment rails** — USDC payment intents, on-chain verification

---

### Integration Options

### Option A: Minimal Change — Supabase for Primitives Only

**Philosophy:** Keep all existing code. Adopt Supabase OSS building blocks (WAL-G, pgBouncer/Supavisor) as standalone services. No Supabase platform dependency.

**What changes:**

| Change                                                      | Effort | Risk                                        |
| ----------------------------------------------------------- | ------ | ------------------------------------------- |
| Add WAL-G sidecar container for backup                      | Low    | Low — sidecar, no app changes               |
| Add pgBouncer service for connection pooling                | Low    | Low — DSN host change only                  |
| Adopt Supabase Storage (self-hosted) if file uploads needed | Med    | Low — new service, no existing code changes |

**What stays custom:**

- Auth (SIWE + NextAuth) — non-negotiable
- RLS (SET LOCAL pattern) — proven, tested
- API routes (Zod contracts + billing hooks) — core business logic
- Observability (Pino + Alloy + Loki + Langfuse) — more comprehensive
- Sandbox/agent execution — unique to our architecture
- Temporal workflows — unique to our architecture
- LiteLLM proxy — unique to our architecture
- Crypto payments — unique to our architecture

**Entry points (in order):**

1. WAL-G backup sidecar (already specced in proj.database-ops P0)
2. pgBouncer service (already specced in proj.database-ops P2)
3. Credential convergence in provision.sh (already specced as P1)

**This is what proj.database-ops already recommends** (line 10): "We adopt only Supabase OSS building blocks (WAL-G, optionally Supavisor/pgBouncer) — not the full Supabase self-hosted platform."

### Option B: Deeper Adoption — Supabase Hosted as DB Backend

**Philosophy:** Move Postgres to Supabase hosted. Get managed backups, pooling, dashboard, extensions. Keep all application code.

**What changes:**

| Change                                        | Effort | Risk                                     |
| --------------------------------------------- | ------ | ---------------------------------------- |
| Migrate Postgres to Supabase hosted           | Med    | Med — DSN change, verify RLS compat      |
| Remove postgres container from docker-compose | Low    | Low — config change                      |
| Remove db-provision service                   | Med    | Med — Supabase manages roles differently |
| Adopt Supabase connection pooling             | Low    | Low — built-in                           |
| Get managed backups/PITR                      | Free   | Low — automatic                          |

**What stays custom (same as Option A):**

- Auth, API routes, observability, sandbox, Temporal, LiteLLM, crypto payments

**Migration path:**

1. Create Supabase project, get connection string
2. Verify our RLS policies work with Supabase Postgres (they should — standard PG RLS)
3. Run Drizzle migrations against Supabase DB
4. Update DATABASE_URL and DATABASE_SERVICE_URL in GitHub Secrets
5. Verify assertEnvInvariants() passes with Supabase role names
6. Remove postgres + db-provision from docker-compose
7. Update LiteLLM to point to Supabase DB (or keep separate)

**Complications:**

- Our provision.sh creates custom roles (app_user, app_service). Supabase hosted may restrict role creation. Need to verify.
- Our SET LOCAL app.current_user_id pattern is standard PG but Supabase defaults to auth.uid(). Both can coexist.
- LiteLLM needs its own database. Supabase charges per-project, so this adds cost or requires the same instance.
- Temporal needs its own Postgres. Would remain self-hosted.

### Option C: Full Supabase Platform (NOT Recommended)

**What it would require:**

- Rewrite auth to use Supabase Auth (GoTrue) — lose SIWE native support
- Rewrite all API routes to use PostgREST — lose Zod contracts, billing hooks, observability
- Rewrite RLS to use auth.uid() — lose SET LOCAL pattern with tested policies
- Abandon LiteLLM proxy — lose cost attribution architecture
- Abandon Temporal — lose scheduled execution with grants

**Why this is destructive:**

- Our auth is SIWE-native; Supabase Auth is email/OAuth-native. Forcing SIWE through Supabase Auth custom hooks adds complexity without benefit.
- Our API routes have billing integration, observability, and Zod contracts that PostgREST cannot replicate.
- Our RLS is battle-tested with 6 integration tests, construction-time binding, and branded type safety. Rewriting to auth.uid() would be a lateral move with regression risk.

---

### Risk Register

### Table 3: Risk Register

| #   | Risk                                                                   | Likelihood          | Impact          | Current mitigation          | Proposed mitigation                                               |
| --- | ---------------------------------------------------------------------- | ------------------- | --------------- | --------------------------- | ----------------------------------------------------------------- |
| R1  | **Total data loss** (no backups, single volume)                        | Medium              | **Critical**    | None                        | Implement WAL-G (Option A, P0 priority)                           |
| R2  | **Stale credentials after volume reuse** (provision.sh create-or-skip) | Medium              | High            | Manual reprovision          | Credential convergence (proj.database-ops P1)                     |
| R3  | **Connection exhaustion** (no pooler, app-level max 10)                | Low (current scale) | High (at scale) | Application pool cap        | Add pgBouncer (proj.database-ops P2)                              |
| R4  | **Supabase vendor lock-in** (if hosted adopted)                        | Low                 | Medium          | N/A                         | Use standard PG features only; avoid Supabase-specific extensions |
| R5  | **Auth migration risk** (if swapping to Supabase Auth)                 | High                | High            | Keep current auth           | Do not swap — SIWE is non-negotiable                              |
| R6  | **RLS regression** (if rewriting policies)                             | Medium              | High            | 6 integration tests         | Do not rewrite — existing policies proven                         |
| R7  | **Schema drift** (if Supabase manages migrations)                      | Medium              | Medium          | Drizzle + strict mode       | Keep Drizzle as migration tool even with Supabase DB              |
| R8  | **Cost increase** (Supabase hosted pricing)                            | Low                 | Low-Med         | Self-hosted Postgres (free) | Evaluate Supabase Pro pricing vs. self-hosted ops cost            |
| R9  | **No session revocation** (JWT 30-day, no blocklist)                   | Low                 | Medium          | Cookie expiry               | Future: add token blocklist or shorten TTL                        |
| R10 | **Audit trail not tamper-evident** (Pino logs, not append-only)        | Medium              | Medium          | Structured logging to Loki  | Future: dedicated audit table with immutable inserts              |
| R11 | **Single-VM deployment** (no HA)                                       | Medium              | High            | Manual recovery             | Future: multi-region or managed DB                                |

---

## Key Decisions

### Table 1: Current Primitives Inventory

| Primitive             | Current implementation                  | Where                                                           | Maturity (0-3) | Tests/evidence                                  | Known issues                                      |
| --------------------- | --------------------------------------- | --------------------------------------------------------------- | -------------- | ----------------------------------------------- | ------------------------------------------------- |
| **Auth**              | SIWE + NextAuth.js JWT                  | src/auth.ts, src/proxy.ts                                       | 2              | Stack tests (auth-flow, api-auth-guard)         | No session revocation, no MFA, 2-step UX          |
| **MFA/SSO**           | None                                    | N/A                                                             | 0              | N/A                                             | Not planned (wallet sig = sole factor)            |
| **Storage**           | None (no file uploads)                  | N/A                                                             | 0              | N/A                                             | Not needed for current MVP                        |
| **Realtime**          | SSE via assistant-stream (AI chat only) | src/app/api/v1/ai/chat/route.ts                                 | 2              | Stack tests                                     | No DB change subscriptions                        |
| **Edge/Functions**    | None (Node.js only)                     | N/A                                                             | 0              | N/A                                             | Not needed                                        |
| **API gateway**       | Caddy + Next.js proxy                   | infra/compose/, src/proxy.ts                                    | 3              | CI/CD deploy validation                         | No distributed rate limiting                      |
| **Postgres ops**      | Drizzle migrations, 3-role model, RLS   | drizzle.config.ts, provision.sh, migrations/0004_enable_rls.sql | 2              | 6 RLS integration tests, contract tests         | **No backups**, no pooler, no credential rotation |
| **Audit events**      | Structured JSON logging (79 events)     | src/shared/observability/events/                                | 2              | Event registry enforced at compile time         | Not append-only, not tamper-evident               |
| **Tracing / LLM obs** | OTel + Pino + Langfuse + Prometheus     | src/bootstrap/otel.ts, src/shared/observability/                | 2              | Metrics endpoint tested                         | No OTel exporter, no Grafana dashboards           |
| **Sandbox / agent**   | Docker-based sandbox (P0 + P0.5a done)  | src/adapters/server/sandbox/, services/sandbox-runtime/         | 1              | Network isolation, workspace I/O, timeout tests | P0.5 unix socket proxy not built; P1+ deferred    |

### What We Built That Supabase Would Replace

Almost nothing cleanly. Our implementations are tightly integrated with domain-specific concerns:

1. **Auth** — Supabase Auth doesn't support SIWE. Our auth is non-replaceable.
2. **RLS** — Our SET LOCAL pattern works differently from Supabase's auth.uid(). Both are valid PG RLS; ours is already tested and wired.
3. **API routes** — PostgREST cannot replace routes with billing hooks, Zod contracts, and observability.

### What We Built That Supabase Does Not Replace (Must Keep)

| Component                                                         | Why Supabase can't replace it              |
| ----------------------------------------------------------------- | ------------------------------------------ |
| SIWE auth + wallet-first identity                                 | Supabase Auth is email/OAuth-native        |
| LiteLLM proxy + cost attribution                                  | No Supabase equivalent                     |
| Temporal workflows + scheduler-worker                             | No Supabase equivalent                     |
| Crypto payment rails (USDC)                                       | No Supabase equivalent                     |
| Sandbox execution with network isolation                          | No Supabase equivalent                     |
| OpenFGA authorization design (planned)                            | No Supabase equivalent                     |
| Hexagonal architecture with Zod contracts                         | Architectural pattern, not infrastructure  |
| Observability stack (Pino + Alloy + Loki + Langfuse + Prometheus) | Supabase logging is far less comprehensive |

### What We Should Stop Building / Recommended Phased Plan

> Phased plan and "stop building" tables are tracked in the [Database Ops Project](../../work/projects/proj.database-ops.md).

### Bottom Line

**The codebase already made this decision.** Per [proj.database-ops](../../work/projects/proj.database-ops.md):

> "We adopt **only** Supabase OSS building blocks (WAL-G, optionally Supavisor/pgBouncer) — not the full Supabase self-hosted platform. The application, RLS model, provisioner, and DSN contract are unchanged."

> "**What We Explicitly Do NOT Do**: Self-host full Supabase stack. We don't need their auth, storage, realtime, or API gateway. We already have Postgres + RLS + explicit DSNs + provisioner."

This evaluation confirms that assessment is correct. The overlap between Supabase and our codebase is almost entirely at the Postgres operations layer (backups, pooling, credentials). Our application-layer primitives (auth, RLS, API, observability, sandbox, workflows, payments) are domain-specific and cannot be replaced by Supabase without regression.

**The only open question is hosted vs. self-hosted Postgres** — and that's a cost/ops tradeoff, not an architecture decision. Our code works with any standard Postgres 15+ instance.

---

## Appendix: File Citation Index

| Claim                       | File                                                                                    | Lines/Excerpt                                         |
| --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| SIWE auth implementation    | src/auth.ts                                                                             | Lines 54-163: Credentials provider with siwe.verify() |
| JWT 30-day sessions         | src/auth.ts                                                                             | Line 50: maxAge: 30 _ 24 _ 60 \* 60                   |
| Proxy auth boundary         | src/proxy.ts                                                                            | Lines 21-57: getToken() validation on /api/v1/\*      |
| RLS policies (10 tables)    | src/adapters/server/db/migrations/0004_enable_rls.sql                                   | 11,171 bytes of ALTER TABLE + CREATE POLICY           |
| Tenant scoping              | packages/db-client/src/tenant-scope.ts                                                  | withTenantScope() wraps Drizzle tx + SET LOCAL        |
| Role separation enforcement | src/shared/env/invariants.ts                                                            | assertEnvInvariants() rejects same-user DSNs          |
| No backups                  | work/projects/proj.database-ops.md                                                      | "No backup exists today" (Crawl P0)                   |
| WAL-G plan                  | work/projects/proj.database-ops.md                                                      | Crawl P0: backups with WAL-G                          |
| pgBouncer plan              | work/projects/proj.database-ops.md                                                      | Run P2: connection pooler                             |
| Supabase OSS only decision  | work/projects/proj.database-ops.md                                                      | Goal: "adopt only Supabase OSS building blocks"       |
| 79 event names              | src/shared/observability/events/index.ts                                                | EVENT_NAMES const registry                            |
| Prometheus metrics          | src/shared/observability/server/metrics.ts                                              | 8 metrics defined (166 lines)                         |
| OTel tracing                | src/bootstrap/otel.ts                                                                   | withRootSpan() + withChildSpan()                      |
| Sandbox network isolation   | src/adapters/server/sandbox/sandbox-runner.adapter.ts                                   | NetworkMode: 'none', CapDrop: ["ALL"]                 |
| Docker compose services     | infra/compose/runtime/docker-compose.yml                                                | 12 services, 352 lines                                |
| 3-layer deployment          | hub guide cicd-e2e-required-sequence (was runbooks/DEPLOYMENT_ARCHITECTURE.md, deleted) | Base (OpenTofu) → Edge (Caddy) → Runtime (compose)    |
| 6 deployment modes          | docs/spec/environments.md                                                               | App-only through full Docker stack                    |
| Drizzle migrations          | drizzle.config.ts + src/adapters/server/db/migrations/                                  | 4 migration files                                     |
| Application pool config     | packages/db-client/src/build-client.ts                                                  | max: 10, idle_timeout: 20                             |
| Temporal worker             | services/scheduler-worker/src/main.ts                                                   | 94 lines, graceful shutdown                           |
| LiteLLM config              | infra/compose/configs/litellm.config.yaml                                               | 204 lines, 20+ models                                 |
| AI telemetry port           | src/ports/ai-telemetry.port.ts                                                          | RecordInvocationParams with correlation IDs           |
| Usage port (LiteLLM API)    | src/ports/usage.port.ts                                                                 | ActivityUsagePort with spend logs/charts              |
| RBAC design (not built)     | docs/spec/rbac.md                                                                       | OpenFGA, dual-check, actor/subject model              |
| Sandbox spec                | docs/spec/sandboxed-agents.md                                                           | P0 complete, P0.5a complete, P0.5 complete            |

## Acceptance Checks

**Manual:**

1. Confirm proj.database-ops aligns with this evaluation's recommendations
2. Confirm no Supabase Auth, PostgREST, or Realtime dependencies exist in the codebase

## Open Questions

_(None — decision is finalized: adopt only Supabase OSS building blocks)_

## Related

- [Database Ops Project](../../work/projects/proj.database-ops.md) — implementation roadmap (WAL-G, credential convergence, pgBouncer)
- [Databases Spec](./databases.md) — migration architecture, two-image strategy
- [Database RLS](./database-rls.md) — RLS policies, P1 credential rotation
- [Database URL Alignment](./database-url-alignment.md) — DSN-only end state
