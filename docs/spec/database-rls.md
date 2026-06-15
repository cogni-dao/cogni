---
id: database-rls-spec
type: spec
title: Database Row-Level Security
status: active
spec_state: draft
trust: draft
summary: PostgreSQL RLS tenant isolation keyed on app.current_user_id with SET LOCAL per-transaction, dual DB roles, and adapter-level wiring.
read_when: Working with database queries, tenant isolation, RLS policies, or the dual DB client architecture.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [infra, auth]
---

# Database Row-Level Security

## Context

> [!CRITICAL]
> Every user-scoped table enforces tenant isolation via PostgreSQL RLS keyed on `current_setting('app.current_user_id')`. The application sets this per-transaction with `SET LOCAL`. Missing setting = deny all.

Multi-tenant data isolation is enforced at the database layer using PostgreSQL Row-Level Security policies. This ensures that even if application code has a bug, one user's data cannot leak to another — the database itself prevents cross-tenant access.

## Goal

Enforce tenant isolation at the PostgreSQL level via RLS policies, so that every user-scoped query is automatically filtered to the authenticated user's data, with no possibility of cross-tenant access from the standard application role.

## Non-Goals

- Column-level encryption (P2 evaluation of `pgcrypto` deferred)
- Denormalized `owner_user_id` on transitive tables (P2 optimization deferred)
- Application-layer authorization (handled by RBAC/OpenFGA — see [rbac.md](./rbac.md))

## Core Invariants

1. **RLS_ON_USER_TABLES**: The `users` table and all tables with a direct or transitive FK to `users.id` MUST have RLS enabled and forced (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY; ALTER TABLE ... FORCE ROW LEVEL SECURITY`). Standalone telemetry/idempotency tables are exempt.

2. **SET_LOCAL_PER_TRANSACTION**: Every application database call runs inside an explicit `BEGIN`/`COMMIT` transaction. The first statement is `SET LOCAL app.current_user_id = $1` where `$1` is the authenticated user ID from the session JWT. Without an explicit transaction, PostgreSQL autocommit wraps each statement in its own implicit transaction — so `SET LOCAL` would apply only to itself and be lost before the next query. This is the safety net: forgetting the wrapper means queries run with no `app.current_user_id` set, and RLS returns zero rows.

3. **SERVICE_BYPASS_CONTAINED**: A dedicated `app_service` PostgreSQL role (used by scheduler workers and internal services) has `BYPASSRLS`. The standard `app_user` role does not. Two roles, same database, different RLS enforcement. The service role **must** use a separate password (`APP_DB_SERVICE_PASSWORD`) that is never present in the web runtime environment — if `app_user` credentials leak, the attacker cannot escalate to the BYPASSRLS role.

4. **LEAST_PRIVILEGE_APP_ROLE**: The `app_user` role has `SELECT, INSERT, UPDATE, DELETE` on application tables only. No `DROP`, `TRUNCATE`, `CREATE`, `ALTER`. Migrations currently run as `app_user` (DB owner, via drizzle-kit + `DATABASE_URL`). On PG 15+, `REVOKE CREATE ON SCHEMA public` is best-practice signaling only — `app_user` inherits `CREATE` via `pg_database_owner` as DB owner.

5. **SSL_REQUIRED_NON_LOCAL**: Any `DATABASE_URL` not pointing to `localhost` or `127.0.0.1` must include `sslmode=require` (or stricter). Enforced by Zod refine at boot.

6. **RLS_COVERAGE**: Every `public` base table with a direct foreign key to `users` is tenant-scoped and MUST have RLS enabled. A table that is read exclusively by the BYPASSRLS service role and has no app-role read path satisfies this with **deny-all** — `ENABLE + FORCE ROW LEVEL SECURITY` and **no policy** — which fails closed if an app-role query is ever pointed at it. A policy is therefore not required by this invariant; RLS being enabled is. Enforced by a catalog-derived preflight in `tests/component/setup/testcontainers-postgres.global.ts` that flags any table with an `f`-type constraint referencing `users` and `relrowsecurity = false` (combined with the `RLS_ON_USER_TABLES` FORCE check: FK→users ⇒ ENABLE ⇒ FORCE). FK-based, not a column-name match, so external identifiers like `ingestion_receipts.platform_user_id` are correctly ignored. This invariant exists because the gate historically checked only ENABLE→FORCE — never coverage — so user-FK tables added after `0004_enable_rls.sql` (genesis: `0010_shallow_paibok.sql`, which created `activity_curation`/`epoch_allocations`, later renamed to `epoch_selection`/`epoch_user_projections`, with no RLS) drifted in silently. Known limit: the gate catches only direct FKs to `users`; transitive tenancy (FK to `billing_accounts`, not `users`) is covered by the hand-written subquery policies above.

## Design

### Policy Design

#### Self-Only Policy (users table)

The `users` table contains PII (email, wallet address). Self-only read/write:

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY self_isolation ON users
  USING (id = current_setting('app.current_user_id', true))
  WITH CHECK (id = current_setting('app.current_user_id', true));
```

**Auth bootstrap edge case:** The SIWE login flow (`src/auth.ts`) queries `users` by `wallet_address` _before_ the user ID is known, and inserts new users on first login. These operations run before `app.current_user_id` can be set. The auth adapter must use the `app_service` role (or a `SECURITY DEFINER` lookup function) for the SIWE credential verification callback. All post-login queries use `app_user` with `SET LOCAL`.

#### Tables with Direct User FK

These tables have `owner_user_id` or `user_id` columns:

```sql
-- billing_accounts: ownerUserId → users.id
ALTER TABLE billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_accounts
  USING (owner_user_id = current_setting('app.current_user_id', true))
  WITH CHECK (owner_user_id = current_setting('app.current_user_id', true));

-- execution_grants: userId → users.id
CREATE POLICY tenant_isolation ON execution_grants
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- schedules: ownerUserId → users.id
CREATE POLICY tenant_isolation ON schedules
  USING (owner_user_id = current_setting('app.current_user_id', true))
  WITH CHECK (owner_user_id = current_setting('app.current_user_id', true));
```

#### Tables with Transitive User FK (via billing_accounts)

These tables have `billing_account_id` FK. Policy uses subquery:

```sql
-- virtual_keys, credit_ledger, charge_receipts, payment_attempts
CREATE POLICY tenant_isolation ON virtual_keys
  USING (billing_account_id IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ))
  WITH CHECK (billing_account_id IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));
-- Same pattern for credit_ledger, charge_receipts, payment_attempts
```

#### Tables with Deep Transitive FK (via payment_attempts)

```sql
-- payment_events: attemptId → payment_attempts → billing_accounts
CREATE POLICY tenant_isolation ON payment_events
  USING (attempt_id IN (
    SELECT id FROM payment_attempts
    WHERE billing_account_id IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
  ))
  WITH CHECK (attempt_id IN (
    SELECT id FROM payment_attempts
    WHERE billing_account_id IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
  ));

-- graph_runs: scheduleId → schedules → users
CREATE POLICY tenant_isolation ON graph_runs
  USING (schedule_id IN (
    SELECT id FROM schedules
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ))
  WITH CHECK (schedule_id IN (
    SELECT id FROM schedules
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));
```

#### Tables Exempt from RLS

| Table                     | Reason                                |
| ------------------------- | ------------------------------------- |
| `ai_invocation_summaries` | No user FK; pure telemetry; no PII    |
| `execution_requests`      | No user FK; idempotency layer; no PII |

#### Service-Only Tables (deny-all RLS, no policy)

These tables are written and read **exclusively by the BYPASSRLS service role** — no app-role read path exists. They satisfy `RLS_COVERAGE` with `ENABLE + FORCE` and **no policy** (deny-all): an app-role query returns zero rows (fail-closed) rather than leaking across tenants. Add an owner-scoped policy only if/when an app-role read path is introduced.

| Table                       | User FK         | Service-role owner                      |
| --------------------------- | --------------- | --------------------------------------- |
| `epoch_selection`           | `user_id`       | `DrizzleAttributionAdapter` (worker)    |
| `epoch_user_projections`    | `user_id`       | `DrizzleAttributionAdapter` (worker)    |
| `node_access_requests`      | `agent_user_id` | nodes access-request routes (serviceDb) |
| `provider_funding_attempts` | (none)          | `OpenRouterFundingAdapter` (serviceDb)  |
| `work_item_sessions`        | (none)          | `DrizzleWorkItemSessionAdapter`         |

### Design Decisions

#### 1. `current_setting` with `true` (Missing-OK)

`current_setting('app.current_user_id', true)` returns `NULL` when the setting is unset. Since no row has `owner_user_id = NULL`, unset context returns zero rows — silent deny, not an error. This is intentional: a forgotten `SET LOCAL` fails safe.

#### 2. Why Subquery Policies (Not Denormalization)

Adding `owner_user_id` to every transitive table would simplify policies to direct column checks. We defer this because:

- Current table count is small (9 tables)
- Subquery policies are correct and readable
- Denormalization adds write-time consistency burden
- P2 evaluates this if query plans show sequential scans

#### 3. Two Application Roles

| Role          | RLS      | Use                                 |
| ------------- | -------- | ----------------------------------- |
| `app_user`    | Enforced | Web app requests (Next.js runtime)  |
| `app_service` | Bypassed | Scheduler worker, internal services |

Both roles have identical DML grants. Only RLS behavior differs. This avoids "god mode" in the application while allowing cross-tenant operations in trusted internal services.

#### 4. Alignment with USAGE_HISTORY.md

`USAGE_HISTORY.md` uses `app.current_account_id` for the `run_artifacts` table. This spec uses `app.current_user_id` because the tenant boundary is `users.id`, not `billing_accounts.id`. When `run_artifacts` is implemented, it should use `app.current_user_id` for consistency (its `account_id` column maps to `billing_accounts.id`, which is 1:1 with `users.id` via the UNIQUE constraint).

**Decision:** Standardize on `app.current_user_id` as the single RLS session variable. Update `USAGE_HISTORY.md` to align when that feature is implemented.

#### 5. Dual DB Client with Sub-Path Isolation

`packages/db-client` uses sub-path exports to separate safe and dangerous factories:

- **Root (`@cogni/db-client`):** `createAppDbClient(url)`, `withTenantScope`, `setTenantContext`, `Database` type. Branded ID types (`UserId`, `ActorId`, `toUserId`, `userActor`) live in `@cogni/ids`.
- **Sub-path (`@cogni/db-client/service`):** `createServiceDbClient(url)` (app_service, BYPASSRLS). NOT re-exported from root.
- **IDs (`@cogni/ids`):** `UserId`, `ActorId`, `toUserId`, `userActor`. Sub-path `@cogni/ids/system` exports `SYSTEM_ACTOR: ActorId` — NOT in root, enforcing import-boundary safety.

At the adapter layer, singletons are also split:

- `src/adapters/server/db/drizzle.client.ts` → `getAppDb()` (app-role, in barrel)
- `src/adapters/server/db/drizzle.service-client.ts` → `getServiceDb()` (service-role, NOT in barrel)

**Enforcement (four layers):**

1. **Adapter gate (enforced):** Depcruiser rule `no-service-db-adapter-import` restricts `drizzle.service-client.ts` imports to `src/auth.ts` and `src/bootstrap/container.ts` only. Proven working via arch probe and `pnpm arch:check`.
2. **Package gate (dormant):** Depcruiser rule `no-service-db-package-import` restricts `@cogni/db-client/service` to `drizzle.service-client.ts` only. Currently not enforceable because depcruiser cannot resolve pnpm workspace sub-path exports (imports silently vanish from the graph). Becomes enforceable if depcruiser adds workspace resolution support.
3. **Type gate (enforced):** `SYSTEM_ACTOR` is exported only from `@cogni/ids/system`. User-facing ports accept `UserId`; worker ports accept `ActorId`. Branded types prevent cross-boundary misuse at compile time.
4. **Environmental (defense-in-depth):** `DATABASE_SERVICE_URL` required in all environments (enforced by Zod schema in `server.ts`).

#### 6. `users.id` UUID Assumption

`@cogni/ids` validates raw strings against `UUID_RE` at brand construction time (`toUserId`). `tenant-scope.ts` accepts only branded `ActorId` and interpolates via `sql.raw()`. The `users.id` column is `text`, not `uuid` — so the schema allows non-UUID values. The UUID validation is a defense-in-depth measure against SQL injection (SET LOCAL cannot use `$1` parameterized placeholders). If user IDs ever deviate from UUID format, `toUserId` will reject them.

#### 7. Dev Parity: Real DB Role Separation

Local dev MUST provision and use two distinct DB roles:

- `DATABASE_URL` → `app_user` (RLS enforced)
- `DATABASE_SERVICE_URL` → `app_service` (BYPASSRLS)

**Requirements (all implemented):**

1. **Provisioning before app start**: `docker-compose` runs `db-provision` (via `--profile bootstrap`) which creates roles/grants/policies. The `pnpm docker:stack:setup` command runs this before the main stack.

2. **No DSN construction in runtime**: `src/shared/env/server.ts` requires both `DATABASE_URL` and `DATABASE_SERVICE_URL` as explicit env vars. The `buildDatabaseUrl` fallback path was removed from runtime; per-node drizzle configs (`nodes/<node>/drizzle.config.ts`, task.0324) also read `DATABASE_URL` directly and throw if unset. `buildDatabaseUrl` remains in `nodes/<node>/app/src/shared/db/db-url.ts` for test scripts only (`reset-db.ts`, `drop-test-db.ts`). `docker-compose.yml` passes DSNs through (`${DATABASE_URL}`, `${DATABASE_SERVICE_URL}`) instead of constructing them from parts.

3. **Example files show distinct users**: `.env.local.example` and `.env.test.example` now show literal DSNs with `app_user` and `app_service` (not shell variable interpolation of the same credentials).

4. **Startup invariants hard-fail**: `src/shared/env/invariants.ts` implements `assertEnvInvariants()` which rejects:
   - Same user in both DSNs (`DATABASE_URL.user == DATABASE_SERVICE_URL.user`)
   - Superuser names (`postgres`, `root`, `superuser`, `admin`)
   - Missing DSNs (also enforced by Zod schema)

### Implementation Status

P0 (RLS + Least-Privilege Roles) is complete:

- Database roles provisioned: `app_user` (DML-only, RLS enforced) + `app_service` (BYPASSRLS) + `ALTER DEFAULT PRIVILEGES` for future tables
- RLS policies enabled on `users` + all 9 user-scoped tables (10 total) via hand-written SQL migration
- `withTenantScope(userId, fn)` helper wrapping Drizzle transaction + `SET LOCAL` in `packages/db-client`
- Dual DB client: `createAppDbClient` (root export) + `createServiceDbClient` (`./service` sub-path only)
- Import boundary: depcruiser `no-service-db-adapter-import` rule + `SYSTEM_ACTOR` sub-path gating
- All adapter methods wired with `withTenantScope` / `setTenantContext` (see Adapter Wiring Tracker below)
- `userId` originates from session JWT (server-side), never from request body
- SIWE auth callback uses `serviceDb` for pre-auth wallet lookup
- SSL enforcement: Zod `.refine()` + `buildDatabaseUrl()` appends `?sslmode=require` for non-localhost

### Adapter Wiring Tracker

Methods that touch user-scoped tables and need `withTenantScope` / `setTenantContext` wiring. Exempt adapters (`DrizzleAiTelemetryAdapter`, `DrizzleExecutionRequestAdapter`) are omitted.

**Legend — userId availability:**

- **Direct**: method already receives `userId` / `callerUserId`
- **Via billingAccountId**: caller has it, `SET LOCAL` uses the owning userId
- **None**: method has only a resource ID; caller must supply userId or use service-role bypass

#### `UserDrizzleAccountService` (`src/adapters/server/accounts/drizzle.adapter.ts`)

> Renamed from `DrizzleAccountService`. UserId bound at construction; `actorId = userActor(userId)` derived once. Every method wraps in `withTenantScope(this.db, this.actorId, tx => …)`. `ServiceDrizzleAccountService` (serviceDb, BYPASSRLS) exposes only `getBillingAccountById` and `getOrCreateBillingAccountForUser`.

| Method                                                   | Tables                                                 | Txn? | userId source                     | Wired? |
| -------------------------------------------------------- | ------------------------------------------------------ | ---- | --------------------------------- | ------ |
| `getOrCreateBillingAccountForUser({ userId })`           | `billing_accounts`, `virtual_keys`                     | Yes  | Constructor (`userActor(userId)`) | [x]    |
| `getBillingAccountById(billingAccountId)`                | `billing_accounts`, `virtual_keys`                     | Yes  | Constructor (`userActor(userId)`) | [x]    |
| `getBalance(billingAccountId)`                           | `billing_accounts`                                     | Yes  | Constructor (`userActor(userId)`) | [x]    |
| `debitForUsage({ billingAccountId, … })`                 | `billing_accounts`, `credit_ledger`                    | Yes  | Constructor (`userActor(userId)`) | [x]    |
| `recordChargeReceipt(params)`                            | `charge_receipts`, `billing_accounts`, `credit_ledger` | Yes  | Constructor (`userActor(userId)`) | [x]    |
| `creditAccount({ billingAccountId, … })`                 | `billing_accounts`, `credit_ledger`                    | Yes  | Constructor (`userActor(userId)`) | [x]    |
| `listCreditLedgerEntries({ billingAccountId })`          | `credit_ledger`                                        | Yes  | Constructor (`userActor(userId)`) | [x]    |
| `findCreditLedgerEntryByReference({ billingAccountId })` | `credit_ledger`                                        | Yes  | Constructor (`userActor(userId)`) | [x]    |
| `listChargeReceipts({ billingAccountId, … })`            | `charge_receipts`                                      | Yes  | Constructor (`userActor(userId)`) | [x]    |

#### `UserDrizzlePaymentAttemptRepository` (`src/adapters/server/payments/drizzle-payment-attempt.adapter.ts`)

> UserId bound at construction; `actorId = userActor(userId)` derived once. Every method wraps in `withTenantScope(this.db, this.actorId, tx => …)`.

| Method                           | Tables                               | Txn? | userId source                     | Wired? |
| -------------------------------- | ------------------------------------ | ---- | --------------------------------- | ------ |
| `create(params)`                 | `payment_attempts`, `payment_events` | Yes  | Constructor (`userActor(userId)`) | [x]    |
| `findById(id, billingAccountId)` | `payment_attempts`                   | Yes  | Constructor (`userActor(userId)`) | [x]    |

#### `ServiceDrizzlePaymentAttemptRepository` (`src/adapters/server/payments/drizzle-payment-attempt.adapter.ts`)

> Uses serviceDb (BYPASSRLS). All mutators include `billingAccountId` in WHERE clause as defense-in-depth tenant anchor.

| Method                                               | Tables                               | Txn? | userId source            | Wired? |
| ---------------------------------------------------- | ------------------------------------ | ---- | ------------------------ | ------ |
| `findByTxHash(chainId, txHash)`                      | `payment_attempts`                   | No   | None (cross-user lookup) | [x]    |
| `updateStatus(id, billingAccountId, status)`         | `payment_attempts`, `payment_events` | Yes  | Via billingAccountId     | [x]    |
| `bindTxHash(id, billingAccountId, txHash, …)`        | `payment_attempts`, `payment_events` | Yes  | Via billingAccountId     | [x]    |
| `recordVerificationAttempt(id, billingAccountId, …)` | `payment_attempts`, `payment_events` | Yes  | Via billingAccountId     | [x]    |
| `logEvent(params)`                                   | `payment_events`                     | No   | None (event-only)        | [x]    |

#### `DrizzleExecutionGrantUserAdapter` (`packages/db-client/…/drizzle-grant.adapter.ts`)

| Method                                 | Tables             | Txn? | userId source | Wired? |
| -------------------------------------- | ------------------ | ---- | ------------- | ------ |
| `createGrant({ userId: UserId, … })`   | `execution_grants` | No   | Direct        | [x]    |
| `revokeGrant(callerUserId: UserId, …)` | `execution_grants` | No   | Direct        | [x]    |
| `deleteGrant(callerUserId: UserId, …)` | `execution_grants` | No   | Direct        | [x]    |

#### `DrizzleExecutionGrantWorkerAdapter` (`packages/db-client/…/drizzle-grant.adapter.ts`)

| Method                                                      | Tables             | Txn? | userId source          | Wired? |
| ----------------------------------------------------------- | ------------------ | ---- | ---------------------- | ------ |
| `validateGrant(actorId: ActorId, grantId)`                  | `execution_grants` | No   | ActorId (SYSTEM_ACTOR) | [x]    |
| `validateGrantForGraph(actorId: ActorId, grantId, graphId)` | `execution_grants` | No   | ActorId (SYSTEM_ACTOR) | [x]    |

#### `DrizzleScheduleUserAdapter` (`packages/db-client/…/drizzle-schedule.adapter.ts`)

| Method                                    | Tables                          | Txn? | userId source | Wired? |
| ----------------------------------------- | ------------------------------- | ---- | ------------- | ------ |
| `createSchedule(callerUserId: UserId, …)` | `schedules`, `execution_grants` | Yes  | Direct        | [x]    |
| `listSchedules(callerUserId: UserId)`     | `schedules`                     | No   | Direct        | [x]    |
| `getSchedule(callerUserId: UserId, …)`    | `schedules`                     | No   | Direct        | [x]    |
| `updateSchedule(callerUserId: UserId, …)` | `schedules`                     | Yes  | Direct        | [x]    |
| `deleteSchedule(callerUserId: UserId, …)` | `schedules`, `execution_grants` | Yes  | Direct        | [x]    |

#### `DrizzleScheduleWorkerAdapter` (`packages/db-client/…/drizzle-schedule.adapter.ts`)

| Method                                      | Tables      | Txn? | userId source          | Wired? |
| ------------------------------------------- | ----------- | ---- | ---------------------- | ------ |
| `getScheduleForWorker(actorId: ActorId, …)` | `schedules` | No   | ActorId (SYSTEM_ACTOR) | [x]    |
| `updateNextRunAt(actorId: ActorId, …)`      | `schedules` | No   | ActorId (SYSTEM_ACTOR) | [x]    |
| `updateLastRunAt(actorId: ActorId, …)`      | `schedules` | No   | ActorId (SYSTEM_ACTOR) | [x]    |
| `findStaleSchedules(actorId: ActorId)`      | `schedules` | No   | ActorId (SYSTEM_ACTOR) | [x]    |

#### `DrizzleGraphRunAdapter` (`packages/db-client/…/drizzle-run.adapter.ts`)

| Method                                         | Tables       | Txn? | userId source          | Wired? |
| ---------------------------------------------- | ------------ | ---- | ---------------------- | ------ |
| `createRun(actorId: ActorId, { … })`           | `graph_runs` | No   | ActorId (SYSTEM_ACTOR) | [x]    |
| `markRunStarted(actorId: ActorId, runId, …)`   | `graph_runs` | No   | ActorId (SYSTEM_ACTOR) | [x]    |
| `markRunCompleted(actorId: ActorId, runId, …)` | `graph_runs` | No   | ActorId (SYSTEM_ACTOR) | [x]    |

#### Special: SIWE Auth Callback (`src/auth.ts`)

| Method                        | Tables  | Txn? | userId source                           | Wired? |
| ----------------------------- | ------- | ---- | --------------------------------------- | ------ |
| `authorize(credentials, req)` | `users` | No   | None (pre-auth — uses `getServiceDb()`) | [x]    |

### Adapter Wiring Build History

#### Commit 2: Schedule + Grant

Port splits (`ScheduleUserPort`/`ScheduleWorkerPort`, `ExecutionGrantUserPort`/`ExecutionGrantWorkerPort`), adapter splits (User + Worker variants), `actorId` threading, container dual-wiring, route handler updates to `toUserId(sessionUser.id)`.

#### Commit 3: Accounts

**Design change:** Original plan threaded `callerUserId` through features/billing. Actual implementation binds `UserId` once at construction via `accountsForUser(userId)` factory — downstream code receives a pre-scoped `AccountService` with no signature changes. Features/billing/payment services untouched.

Split `DrizzleAccountService` → `UserDrizzleAccountService` (appDb, `withTenantScope`) + `ServiceDrizzleAccountService` (serviceDb, BYPASSRLS). Container exposes `accountsForUser(UserId)` factory + `serviceAccountService` singleton. All facades bind at edge via `toUserId(sessionUser.id)`.

**Files intentionally NOT changed** (no `callerUserId` threading needed with construction-time binding):
`src/features/ai/services/billing.ts`, `src/adapters/server/ai/inproc-completion-unit.adapter.ts`, `src/features/ai/services/preflight-credit-check.ts`, `src/features/payments/services/creditsConfirm.ts`, `src/features/payments/services/creditsSummary.ts`

#### Commit 4: Payment Attempts

Follows the Commit 3 construction-time binding pattern. `UserDrizzlePaymentAttemptRepository(appDb, userId)` binds `actorId = userActor(userId)` at construction; every method wraps in `withTenantScope`. Service methods on `ServiceDrizzlePaymentAttemptRepository(serviceDb)` include `billingAccountId` in WHERE clauses as defense-in-depth tenant anchor.

### File Pointers

| File                                                            | Role                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `infra/compose/postgres-init/provision.sh`                      | DML grants, `app_service` role, `ALTER DEFAULT PRIVILEGES`                          |
| `src/adapters/server/db/migrations/0004_enable_rls.sql`         | RLS + policies on 10 tables (hand-written SQL migration)                            |
| `src/adapters/server/db/migrations/0032_rls_epoch_coverage.sql` | Deny-all RLS on `epoch_selection` + `epoch_user_projections` (closes the 0010 leak) |
| `tests/component/setup/testcontainers-postgres.global.ts`       | Preflight gates: ENABLE⇒FORCE + RLS_COVERAGE (`%user_id` ⇒ RLS enabled)             |
| `packages/db-schema/src/index.ts`                               | Root barrel re-exporting all schema slices                                          |
| `packages/db-client/src/client.ts`                              | `createAppDbClient` (app-role, root export)                                         |
| `packages/db-client/src/service.ts`                             | `createServiceDbClient` (service-role, `./service` sub-path only)                   |
| `packages/db-client/src/build-client.ts`                        | Shared `buildClient()` factory + `Database` type                                    |
| `packages/ids/src/index.ts`                                     | `UserId`, `ActorId`, `toUserId`, `userActor` branded types                          |
| `packages/ids/src/system.ts`                                    | `SYSTEM_ACTOR: ActorId` (sub-path gated)                                            |
| `packages/db-client/src/tenant-scope.ts`                        | `withTenantScope` + `setTenantContext` (accept `ActorId`)                           |
| `src/adapters/server/db/drizzle.client.ts`                      | `getAppDb()` singleton (app-role only)                                              |
| `src/adapters/server/db/drizzle.service-client.ts`              | `getServiceDb()` singleton (BYPASSRLS, depcruiser-gated)                            |
| `src/adapters/server/db/tenant-scope.ts`                        | Re-exports from `@cogni/db-client`                                                  |
| `src/shared/db/db-url.ts`                                       | Append `?sslmode=require` for non-localhost URLs                                    |
| `src/shared/env/server.ts`                                      | Zod refine rejecting non-localhost URLs without `sslmode`                           |
| `src/shared/env/invariants.ts`                                  | Role separation checks (`assertEnvInvariants()`)                                    |
| `tests/component/db/rls-tenant-isolation.int.test.ts`           | Cross-tenant isolation + missing-context tests                                      |
| `tests/component/db/rls-adapter-wiring.int.test.ts`             | Adapter wiring gate tests                                                           |

## Acceptance Checks

**Automated:**

- Integration test: two users, `SET LOCAL` to user A, assert cannot read user B's `billing_accounts`
- Integration test: `SET LOCAL` to user A, assert cannot read user B's row in `users`
- Integration test: missing `SET LOCAL` → zero rows returned (not error)
- Integration test: `app_service` role can read both users' data
- Integration test: cross-tenant INSERT rejected by `WITH CHECK` policy
- Integration test: production `withTenantScope` / `setTenantContext` helpers verified
- Gate test: `DrizzleScheduleManagerAdapter.listSchedules` under RLS-enforced connection
- Gate test: `DrizzleAccountService.getOrCreateBillingAccountForUser` under RLS-enforced connection
- Sanity checks: superuser reads seeded schedule and billing account (proves data exists, failure is from RLS)
- Depcruiser `no-service-db-adapter-import` rule passes via `pnpm arch:check`

**Manual:**

1. Verify `SET LOCAL` with invalid UUID returns zero rows (not SQL error)
2. Verify `app_user` cannot `DROP TABLE` or `ALTER TABLE`

## Open Questions

_(none — P1 audit/hardening and P2 per-table optimization tracked as future initiative work: separate migrator role, DB ownership transfer, credential rotation, pg_audit, sslmode=verify-full, pgcrypto evaluation, restricted app_service grants, SECURITY DEFINER evaluation, worker adapter directory reorganization, denormalization evaluation)_

## Related

- [Databases](./databases.md) — Two-user model, migration strategy
- [RBAC](./rbac.md) — Application-layer authorization (OpenFGA)
- [Security & Auth](./security-auth.md) — Authentication (SIWE, JWT sessions)
- [Architecture](./architecture.md) — Hexagonal layers, adapter patterns
