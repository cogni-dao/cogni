---
id: spec.accounts-design
type: spec
title: Accounts & Credits System Design
status: draft
spec_state: draft
trust: draft
summary: Three-layer identity model (Auth.js → billing accounts → virtual keys), credit ledger tenancy, and owner vs actor semantics
read_when: Working on billing accounts, credit ledger, tenancy boundaries, or system tenant
implements: []
owner: cogni-dev
created: 2025-12-10
verified: null
tags:
  - billing
  - accounts
  - tenancy
---

# Accounts & Credits System Design

## Context

Auth.js (SIWE) authenticates users; our billing layer owns a billing account per user and a credit ledger. In MVP, outbound LiteLLM calls use service auth (`LITELLM_MASTER_KEY`). `virtual_keys` currently acts as an internal FK/scope handle for ledger/receipts (no per-key spend attribution yet).

## Goal

Define the billing identity model, credit tenancy boundaries, and owner vs actor semantics that all billing, metering, and spend attribution code must follow.

## Non-Goals

- SIWE/Auth.js mechanics in depth (see [security-auth.md](./security-auth.md))
- App API key lifecycle and endpoints (see [proj.accounts-api-keys](../../work/projects/proj.accounts-api-keys.md) P3)
- Multi-tenant/OAuth providers (see initiative P4)

---

## Core Invariants

1. **ONE_USER_ONE_BILLING_ACCOUNT**: `auth.users.id` maps 1:1 to `billing_accounts.owner_user_id`.

2. **CREDITS_PER_BILLING_ACCOUNT**: `credit_ledger` is append-only source of truth; balance is a shared pool per `billing_account`.

3. **NO_CLIENT_LITELLM_KEYS**: LiteLLM key material never appears in browser storage, responses, or logs.

4. **NO_PLAINTEXT_SECRETS**: App keys are stored hashed (show-once); LiteLLM key material is encrypted or stored as a reference, never plaintext.

5. **CUSTOMER_DATA_UNDER_CUSTOMER_ACCOUNT**: Customer-derived content is always stored under the customer's `account_id`, even if initiated by system automation. Never repoint customer artifacts into a system account.

---

## Design

### Three-Layer Identity Model

#### 1) Auth.js Identity (Login)

- Tables: `users`, `accounts`, `verification_tokens` (+ sessions table may exist but JWT strategy can bypass it).
- Purpose: prove wallet ownership (SIWE) and manage browser sessions.

#### 2) Billing Accounts (Credit Tenancy)

- Table: `billing_accounts`
- Purpose: tenancy anchor for credits + ledger + receipts.
- Mapping: exactly one `users.id` → one `billing_accounts.owner_user_id`.

#### 3) LiteLLM Virtual Keys (Spend Attribution)

- Table: `virtual_keys` (MVP sentinel mode)
- Purpose: FK/scope handle for `charge_receipts`. In MVP stores sentinel `[master-key-mode]`.
- Server-only: never returned to client.

### Current State (Service-Auth MVP)

- Auth.js session-only auth for `/api/v1/*` (no app API keys yet).
- Outbound LiteLLM calls use service auth (`LITELLM_MASTER_KEY`).
- `virtual_keys` acts as internal FK/scope handle (no per-key spend attribution yet).
- Per-key attribution is not implemented until `app_api_keys` + 1:1 mapping exists.

### Tables (Current)

- `billing_accounts(id, owner_user_id, is_system_tenant, balance_credits, created_at, updated_at)` — `is_system_tenant` boolean (default false)
- `virtual_keys(id, billing_account_id, litellm_virtual_key, is_default, active, label, created_at)` — MVP sentinel mode
- `credit_ledger(id, billing_account_id, amount, balance_after, reason, reference, metadata, created_at)`
- `charge_receipts(id, billing_account_id, virtual_key_id, litellm_call_id, charged_credits, response_cost_usd, provenance, source_system, source_reference, created_at)`

### Tenancy & Data Ownership (Owner vs Actor)

**Definitions:**

- **Owner (`account_id`)**: Data tenancy boundary. RLS enforced. Determines deletion scope and retention policy.
- **Actor (`actor_type`, `actor_id`)**: Who initiated the run. Metadata only — does not change tenancy.

| Field        | Purpose                   | Storage                               |
| ------------ | ------------------------- | ------------------------------------- |
| `account_id` | Data owner (RLS boundary) | Column (NOT NULL)                     |
| `actor_type` | `'user'` or `'service'`   | metadata (P0), column (P1 if indexed) |
| `actor_id`   | Initiator identifier      | metadata (P0), column (P1 if indexed) |

### System Tenant

- `is_system_tenant=true` for purely internal governance/automation runs
- System tenant has explicit tool allowlists (no wildcards) and high spend caps (not unlimited)
- System tenant may have different retention defaults (policy-driven)
- **Forbidden:** Customer message content in system tenant

See: [system-tenant.md](./system-tenant.md) for full implementation spec.

### Scope

This spec owns:

- The billing model (accounts, credits, receipts) and how credentials map to spend attribution.
- Tenancy rules: owner vs actor semantics, data ownership boundaries.
- It does **not** define SIWE/Auth.js mechanics in depth (see [security-auth.md](./security-auth.md)).

### File Pointers

| File                                        | Purpose                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/shared/db/schema.ts`                   | Drizzle schema for billing_accounts, virtual_keys, credit_ledger, charge_receipts |
| `src/lib/auth/mapping.ts`                   | `getOrCreateBillingAccountForUser` — account provisioning                         |
| `src/adapters/server/ai/litellm.adapter.ts` | LiteLLM adapter — master key auth boundary                                        |

## Acceptance Checks

**Automated:**

- `pnpm test -- accounts` — validates account provisioning and credit ledger operations

**Manual:**

1. Verify `billing_accounts` row created with correct `owner_user_id` after first SIWE login
2. Verify `credit_ledger` entries are append-only and `balance_after` is consistent

### Actor Model (Planned)

The owner/actor semantics above will be formalized as a first-class `actors` table in [proj.operator-plane](../../work/projects/proj.operator-plane.md). The existing `actor_type`/`actor_id` metadata fields become FK references to `actors.id`. `billing_account_id` remains the tenancy/RLS boundary — `actor_id` is economic attribution, not tenancy. See the [human–AI identity standard](https://cognidao.org/knowledge/human-ai-identity-standard) for the full `actor_id` boundary.

## Open Questions

_(none)_

## Related

- [accounts-api-endpoints.md](./accounts-api-endpoints.md) — MVP LiteLLM endpoint usage
- [security-auth.md](./security-auth.md) — authentication architecture
- [billing-evolution.md](./billing-evolution.md) — billing stages
- [system-tenant.md](./system-tenant.md) — system tenant design
- [Project: Accounts & API Keys](../../work/projects/proj.accounts-api-keys.md)
