---
id: research.system-tenant-seeding-heartbeat-funding
type: research
title: "System Tenant: Seeding, Governance Heartbeat & Self-Funding"
status: draft
trust: draft
summary: Research spike on system tenant seeding/health, Temporal-based governance heartbeat, and post-charge revenue share funding model.
read_when: Planning system tenant bootstrap, governance scheduling, or credit revenue share
created: 2026-02-13
owner: cogni-dev
tags:
  - system-tenant
  - governance
  - billing
  - research
---

# Research: System Tenant — Seeding, Governance Heartbeat & Self-Funding

> date: 2026-02-13

## Question

How should the `cogni_system` tenant be seeded, kept healthy at runtime, given a code-configurable governance heartbeat (Temporal schedule + repo-spec), and kept funded via automatic credit sharing from user purchases?

## Context

The [system-tenant spec](../spec/system-tenant.md) defines `cogni_system` as a first-class tenant for governance AI loops. The [system-tenant project](../../work/projects/proj.system-tenant-governance.md) has a P0 roadmap (schema, PolicyResolverPort, idempotency) but three critical areas remain under-specified:

1. **Seeding & Health** — The spec shows a SQL seed and a TS healthcheck, but no migration exists. No production seed tooling exists (only test fixtures in `tests/_fixtures/stack/seed.ts`). The bootstrap container (`src/bootstrap/container.ts`) has no startup healthchecks.
2. **Governance Heartbeat** — The [governance-agents project](../../work/projects/proj.governance-agents.md) plans Temporal workflows for signal collection, brief generation, and incident-gated agent execution. The [scheduler spec](../spec/scheduler.md) defines ExecutionGrants for scheduled runs. But nothing connects these to a "heartbeat" — a periodic proof-of-life that the system tenant can still execute and is not stuck/dead.
3. **Self-Funding** — The current billing model charges all tenants the same markup (2.0× via `USER_PRICE_MARKUP_FACTOR`). Users buy credits 1:1 USD→credits. The markup revenue (difference between user cost and provider cost) is implicit profit. There is no mechanism for the system tenant to receive a share of this revenue to fund its own operations.

### Existing Primitives

| Primitive                        | Location                                           | Status                                     |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------ |
| `billing_accounts` table         | `packages/db-schema/src/refs.ts`                   | No `is_system_tenant` column               |
| `credit_ledger`                  | `packages/db-schema/src/billing.ts`                | Append-only, idempotent                    |
| `CREDITS_PER_USD = 10_000_000`   | `src/core/billing/pricing.ts`                      | Protocol constant                          |
| `USER_PRICE_MARKUP_FACTOR = 2.0` | `src/shared/env/server.ts`                         | Env-configurable                           |
| `calculateLlmUserCharge()`       | `src/core/billing/pricing.ts`                      | Pure: providerCost × markup                |
| `calculateDefaultLlmCharge()`    | `src/features/ai/services/llmPricingPolicy.ts`     | Reads env markup                           |
| `confirmCreditsPayment()`        | `src/features/payments/services/creditsConfirm.ts` | Widget payment → credits                   |
| `ExecutionGrant`                 | `packages/db-schema/src/scheduling.ts`             | Durable auth for scheduled runs            |
| `.cogni/repo-spec.yaml`          | `.cogni/repo-spec.yaml`                            | DAO address, chain, gates                  |
| Test seed utilities              | `tests/_fixtures/stack/seed.ts`                    | `seedUser()`, `seedBillingAccount()`       |
| Migrations                       | `src/adapters/server/db/migrations/`               | 7 migrations (0000-0006), no system tenant |

---

## Findings

### Area 1: Seeding & Health

#### Option A: Drizzle migration + startup healthcheck (Recommended)

**What:** A new migration (0007 or similar) that:

1. Adds `is_system_tenant BOOLEAN NOT NULL DEFAULT false` to `billing_accounts`
2. Inserts `cogni_system_principal` user (ON CONFLICT DO NOTHING)
3. Inserts `cogni_system` billing account with `is_system_tenant=true` (ON CONFLICT DO NOTHING)

A startup healthcheck in `src/bootstrap/` that queries for `cogni_system` and fails fast if missing.

**Pros:**

- Idempotent — safe to re-run
- Migration is the standard mechanism for schema + seed in this codebase
- Startup healthcheck catches missing tenant before first governance run
- Matches the spec exactly (system-tenant.md §Schema)

**Cons:**

- Mixes DDL (add column) with DML (insert rows) in one migration — acceptable for a single-row seed
- The `cogni_system_principal` user has no wallet address (NULL) — breaks the implicit assumption that users = wallet holders. But `owner_user_id` is NOT NULL, so a service principal user is required

**Fit with our system:**

- Drizzle kit generates migrations; we'd write a custom SQL migration (like `0004_enable_rls.sql`)
- Bootstrap container already wires `serviceAccountService` (BYPASSRLS) which is what the healthcheck would use
- RLS policy on `billing_accounts` scopes by `owner_user_id` — system tenant queries need `ServiceDrizzleAccountService` (BYPASSRLS), which already exists

**Implementation sketch:**

```sql
-- 0007_system_tenant.sql
ALTER TABLE billing_accounts ADD COLUMN is_system_tenant boolean NOT NULL DEFAULT false;

INSERT INTO users (id, wallet_address)
VALUES ('cogni_system_principal', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO billing_accounts (id, owner_user_id, is_system_tenant, balance_credits, created_at)
VALUES ('cogni_system', 'cogni_system_principal', true, 0, now())
ON CONFLICT (id) DO NOTHING;
```

```typescript
// src/bootstrap/healthchecks.ts
export async function verifySystemTenant(
  serviceDb: ServiceDbClient
): Promise<void> {
  const result = await serviceDb.query.billingAccounts.findFirst({
    where: eq(billingAccounts.id, "cogni_system"),
  });
  if (!result?.isSystemTenant) {
    throw new Error(
      "FATAL: cogni_system billing account missing or not flagged. Run migrations."
    );
  }
}
```

#### Option B: Seed script separate from migration

**What:** Column added in migration; row insert in `scripts/db/seed-system-tenant.ts` run separately.

**Pros:** Separates schema from data

**Cons:** Two-step process; easy to forget the seed step; no production seed tooling exists today. Creates a new operational dependency.

**Verdict:** Reject for P0. The single-row seed is trivially idempotent and belongs in the migration.

#### Option C: Application-level auto-provision (like `getOrCreateBillingAccountForUser`)

**What:** On first governance run, auto-create `cogni_system` if missing.

**Pros:** Zero-touch provisioning

**Cons:** Violates `SYSTEM_TENANT_STARTUP_CHECK` invariant. Delays failure to runtime. Mixes provisioning with execution. Could create race conditions if multiple governance workflows start simultaneously.

**Verdict:** Reject. Fail-fast at startup is the right pattern.

---

### Area 2: Governance Heartbeat

#### What "heartbeat" means here

Three distinct concerns:

1. **Liveness probe:** Can the system tenant still authenticate and execute? (Is the account active, funded, and the execution pipeline working?)
2. **Governance loop scheduling:** What triggers governance AI runs? (Temporal Schedules, per the governance-agents project)
3. **Configuration source:** Where do governance loop parameters live? (`.cogni/repo-spec.yaml` vs database vs env)

#### Option A: Temporal Schedule + lightweight heartbeat workflow (Recommended)

**What:** A `SystemTenantHeartbeatWorkflow` in the governance Temporal worker that runs every N minutes (configurable in `.cogni/repo-spec.yaml` or env). It:

1. Validates `cogni_system` account exists and has sufficient balance
2. Validates the ExecutionGrant for governance is active and not expired
3. Optionally runs a no-op graph execution to prove the pipeline works (smoke test)
4. Emits a `governance.heartbeat` signal event with status + balance + grant expiry
5. If balance below threshold → emits `governance.heartbeat.low_balance` alert

This is distinct from the governance agent workflows (signal collection, brief generation, incident routing) which are heavier and run on their own schedules.

**Pros:**

- Leverages existing Temporal infrastructure (planned for governance-agents)
- Lightweight — doesn't require a full graph execution on every tick
- Signal-based — feeds into the same CloudEvents pipeline as other governance signals
- Configurable — schedule interval and balance thresholds in repo-spec or env
- Observable — heartbeat events flow to Loki/Grafana like everything else

**Cons:**

- Requires Temporal infrastructure (not yet deployed, but planned as P0 of governance-agents)
- Adds another workflow to manage
- No-op graph execution adds latency to heartbeat (could be optional)

**Configuration via `.cogni/repo-spec.yaml`:**

The repo-spec already has `governance`, `payments_in`, `providers`, `llm_proxy`, and `gates` sections. A natural extension:

```yaml
governance:
  heartbeat:
    interval_minutes: 5
    low_balance_threshold_credits: 1000000 # $0.10
    grant_expiry_warning_hours: 24
  system_tenant:
    id: cogni_system
    tool_allowlist:
      - core__metrics_query
      - core__loki_query
      - core__github_read
    budget_credits_per_day: 100000000 # $10/day
```

**Fit with our system:**

- The [scheduler spec](../spec/scheduler.md) already defines `ExecutionGrant` as the auth mechanism for scheduled runs
- The [governance-agents project](../../work/projects/proj.governance-agents.md) already plans Temporal Schedules for signal collection
- The heartbeat is just another Temporal Schedule in the governance namespace
- `.cogni/repo-spec.yaml` is already read by `src/shared/config/` — extending it for governance config is natural

#### Option B: Simple cron in scheduler-worker (no Temporal)

**What:** A `setInterval` in the existing `services/scheduler-worker/main.ts` (like the billing reconciler in task.0039).

**Pros:** No Temporal dependency. Works with existing infrastructure.

**Cons:** Less durable than Temporal (no retry, no history, no visibility). Mixes governance concerns into the billing worker. Doesn't scale to the full governance pipeline.

**Verdict:** Acceptable as an interim if Temporal isn't ready, but the heartbeat should migrate to Temporal when governance-agents P0 lands.

#### Option C: External healthcheck (e.g., UptimeRobot, Grafana synthetic monitoring)

**What:** External service pings a `/api/internal/governance/healthz` endpoint that validates system tenant state.

**Pros:** Works without Temporal. External perspective (catches network-level failures).

**Cons:** Can only check readiness, not execute governance workflows. Doesn't emit signals into the governance pipeline. Adds external dependency.

**Verdict:** Complementary, not primary. Good for "is the HTTP server up?" but not for "can the governance pipeline execute?".

---

### Area 3: Self-Funding (Credit Revenue Share)

#### The economics

Current state:

- Users buy credits at 1:1 USD→credits (`usdCentsToCredits()` in `creditsConfirm.ts`)
- Users consume credits at 2.0× markup (`USER_PRICE_MARKUP_FACTOR = 2.0`)
- Provider cost = X, user charged = 2X, "profit" = X (exists only as reduced balance drain rate)
- The markup revenue is **implicit** — it's not separated into a distinct account

The user's request: when users buy credits, 75% of the credit markup goes to the system tenant.

**Decision (confirmed by owner, refined after review):** Revenue share at **purchase time** as **bonus credits** — user gets 100% of what they paid for (unchanged), system tenant gets additional bonus credits.

| Event                     | Credits minted | Recipient                                      |
| ------------------------- | -------------- | ---------------------------------------------- |
| User buys $100 of credits | 1,000,000,000  | User (100% — unchanged from today)             |
| Revenue share bonus       | 750,000,000    | System tenant (75% of user's purchased amount) |

The DAO already holds the money (sent to DAO wallet address). No DAO reserve account needed.

The 2× markup at consumption means the user's $100 of credits buys $50 of compute. The $50 surplus is the economic backing for the system tenant's 750M bonus credits.

#### Option A: Purchase-time bonus credits in `confirmCreditsPayment()` (Selected)

**What:** When a user completes a credit purchase, atomically credit two accounts:

1. User gets 100% of purchased credits (**unchanged from today**)
2. System tenant gets bonus credits = `floor(purchasedCredits × SYSTEM_TENANT_REVENUE_SHARE)`

The DAO already holds the money (sent to DAO wallet). No DAO reserve account needed.

**Implementation in the payment pipeline:**

```
confirmCreditsPayment() called with amountUsdCents
  → purchasedCredits = usdCentsToCredits(amountUsdCents)
  → bonusCredits = calculateRevenueShareBonus(purchasedCredits, REVENUE_SHARE)
  → creditAccount(userId, purchasedCredits, 'widget_payment', clientPaymentId)
  → creditAccount('cogni_system', bonusCredits, 'platform_revenue_share', clientPaymentId)
```

**New env/config:**

```
SYSTEM_TENANT_REVENUE_SHARE=0.75  # 75% of purchased credits minted as bonus to system tenant
```

**Pros:**

- User gets exactly what they paid for (no change to existing behavior)
- Simple — one additional `creditAccount` call in `confirmCreditsPayment`
- Atomic — both credits in one DB transaction
- Idempotent — `clientPaymentId` reference with different `reason` values
- Audit trail: both ledger entries reference the same payment
- System tenant balance grows with every purchase

**Cons:**

- Total credits minted exceed USD backing (1.75× for default config). Sustainable because 2× markup at consumption means credits buy half their face value in compute.
- If revenue share is set too high relative to markup, system tenant could consume more compute than markup revenue covers (guardrail: `revenueShare ≤ 1.0`)

**Fit with our system:**

- `accountService.creditAccount()` already exists with idempotency
- `confirmCreditsPayment()` is the single entry point for credit purchases
- `ServiceDrizzleAccountService` (BYPASSRLS) can credit the system tenant

#### Option B: Post-charge revenue split (at consumption)

**What:** After every `charge_receipt`, calculate markup and credit system tenant.

**Verdict:** Rejected by owner. Revenue share should happen at purchase time, not consumption time.

#### Option C: Flat periodic allocation (treasury-style)

**What:** DAO votes to allocate N credits/month to system tenant.

**Verdict:** Complementary for initial bootstrapping (seed balance), not the long-term model.

---

## Recommendation (with owner decisions)

### Seeding & Health: Migration + startup healthcheck

A single Drizzle migration adds the `is_system_tenant` column, seeds `cogni_system_principal` user and `cogni_system` billing account (balance: 0). Startup healthcheck in `src/bootstrap/healthchecks.ts` fails fast if missing.

### Governance Heartbeat: Temporal Schedule driven by `.cogni/repo-spec.yaml`

Temporal is available on the network. Governance is landing ASAP. The primary complexity is a Temporal schedule whose parameters are defined in `.cogni/repo-spec.yaml` under a `governance:` section. The heartbeat workflow validates account existence, balance, and grant status, and emits `governance.heartbeat` CloudEvents.

### Self-Funding: Purchase-time bonus credits

Revenue share at **purchase time** as **bonus credits** (confirmed by owner, refined after review). User gets 100% of purchased credits (unchanged). System tenant gets additional bonus credits = 75% of user's purchased amount. DAO already holds the money. No DAO reserve account needed.

### Config placement

| Setting                           | Where                                      | Why                                                   |
| --------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `SYSTEM_TENANT_REVENUE_SHARE`     | env (with repo-spec as documentation)      | Runtime-configurable, like `USER_PRICE_MARKUP_FACTOR` |
| Heartbeat interval, thresholds    | `.cogni/repo-spec.yaml` governance section | Declarative, versioned, DAO-auditable                 |
| Tool allowlist for system tenant  | Database (via PolicyResolverPort)          | Queryable at runtime per spec                         |
| System tenant ID (`cogni_system`) | Hardcoded constant                         | Protocol constant, like `CREDITS_PER_USD`             |

---

## Resolved Questions

- [x] **Revenue share timing** — Purchase time (owner decision). System tenant is funded immediately when users buy credits.
- [x] **User credit amount** — Unchanged. User gets 100% of purchased credits. System tenant bonus is additional minting.
- [x] **DAO reserve** — Not needed on-ledger. DAO already holds the money (sent to DAO wallet). The 25% not minted is implicit margin.
- [x] **Atomicity** — Atomic. Both credit_ledger writes (user + system tenant) in one DB transaction. Maximum reliability.
- [x] **Initial balance** — 0 credits. System tenant bootstraps from first user purchase.
- [x] **Temporal dependency** — Temporal exists on the network. Governance is landing ASAP. No interim needed.

## Open Questions

- [ ] **System tenant markup** — When the system tenant consumes its credits, does it pay the same 2× markup? If yes, 750M credits buys $37.50 of compute. If 1× (no self-markup), 750M buys $75. Recommend: 1× for system tenant (no self-tax).
- [ ] **Startup healthcheck placement** — In `src/bootstrap/container.ts` (composition root) or as a separate step in the Next.js instrumentation hook?

---

## Proposed Layout

### Spec Updates

| Spec                             | Change                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/spec/system-tenant.md`     | Add §Self-Funding (purchase-time bonus credits, new invariant `PURCHASE_TIME_REVENUE_SHARE`). Add §Governance Heartbeat (Temporal schedule, repo-spec config). Update §Schema with `platform_revenue_share` ledger reason. |
| `docs/spec/billing-evolution.md` | Add §Revenue Share section: bonus credit formula, env config. New invariant `REVENUE_SHARE_IS_BONUS`.                                                                                                                      |

### Tasks (PR-sized, rough sequence)

| #     | Title                                                                         | Est   | Dependencies   | Work Item     |
| ----- | ----------------------------------------------------------------------------- | ----- | -------------- | ------------- |
| **1** | **System tenant bootstrap + purchase-time revenue share**                     | **3** | **None (P0)**  | **task.0046** |
| 2     | Extend `.cogni/repo-spec.yaml` with `governance:` section + Zod config reader | 2     | None           | —             |
| 3     | Governance heartbeat Temporal workflow                                        | 3     | Task 1, Task 2 | —             |

**Task 1 is the P0 (task.0046).** It bundles the tightly-coupled foundation:

- Migration: `is_system_tenant` column + unique index + `cogni_system` seed (0 credits)
- Schema: `isSystemTenant` in Drizzle schema
- Startup healthcheck: fail fast if `cogni_system` missing
- Bonus credits in `confirmCreditsPayment()`: user gets 100%, system tenant gets 75% bonus
- Pure billing math: `calculateRevenueShareBonus()` in `src/core/billing/pricing.ts`
- Env: `SYSTEM_TENANT_REVENUE_SHARE` (default 0.75)
- Tests: unit (bonus math, idempotency), stack (E2E purchase + retry)

### Purchase-Time Revenue Share Formula (reference)

```
purchasedCredits = usdCentsToCredits(amountUsdCents)      // what user paid for
userCredits = purchasedCredits                              // user gets 100% (unchanged)
bonusCredits = floor(purchasedCredits × REVENUE_SHARE)     // 75% bonus for system tenant
```

Example: User buys $100 of credits (75% revenue share):

| Recipient        | Formula                          | Credits           | Note                               |
| ---------------- | -------------------------------- | ----------------- | ---------------------------------- |
| User             | `purchasedCredits`               | 1,000,000,000     | 100% of purchase (unchanged)       |
| System tenant    | `floor(purchasedCredits × 0.75)` | 750,000,000       | Bonus credits                      |
| **Total minted** |                                  | **1,750,000,000** | Backed by 2× markup at consumption |

Note: total minted = 1.75× purchase. Sustainable because 2× markup at consumption means user credits buy half their face value in compute. The $50 surplus backs the system tenant's bonus.
