---
id: dao-enforcement-spec
type: spec
title: DAO Enforcement — Payments Financial Rails
status: active
spec_state: draft
trust: draft
summary: How the Cogni DAO owns the crypto widget payments loop — config-in-git, runtime invariants, and the operator's in-process review static gates.
read_when: Working with payments, credit minting, repo-spec, or the operator's in-process review gates.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [web3, billing]
---

# DAO Enforcement — Payments Financial Rails

## Context

The Cogni DAO "owns" the crypto widget payments loop in cogni-template. This spec is **binding** for the payments MVP:

- It describes the only allowed way to mint credits from crypto payments.
- It describes how repository config and the operator's in-process review gates detect violations.

For the payments MVP, DAO "ownership" of payments is enforced at three layers:

1. **Configuration** — The DAO payment receiving address and chain_id live in `.cogni/repo-spec.yaml` (governance in git, not env). Server code reads repo-spec and passes widget config as props; the browser never reads env vars or the filesystem. Backend ops/watchers derive addresses from repo-spec (no env override).

2. **Runtime Invariants** — Only authenticated SIWE sessions can call `POST /api/v1/payments/credits/confirm`. That endpoint resolves the caller's `billing_account_id` from the session only. Credits are minted by inserting a `credit_ledger` row with `reason = 'widget_payment'` and updating `billing_accounts.balance_credits`.

3. **Static Enforcement (in-process review on cogni-operator)** — `.cogni/repo-spec.yaml` declares the payments config and allowed envs. The operator's in-process review gates ensure no code paths exist outside the approved rails.

For MVP, we accept that crypto widgets are a **soft oracle**: we trust the widget's success callback as "user paid" and rely on later Ponder/on-chain reconciliation for hard guarantees.

## Goal

Enforce DAO ownership of the crypto payments loop via config-in-git, runtime invariants, and static PR gates — ensuring no code path can mint credits or use sensitive keys outside the approved rails.

## Non-Goals

- On-chain reconciliation / hard oracle verification (deferred to Ponder integration)
- Multi-provider payment routing (single widget provider for MVP)
- Env-based override of DAO addresses (addresses are governed in git)

## Core Invariants

### Frontend

1. **WIDGET_ADDRESS_FROM_REPO_SPEC**: The receiver address for payment widgets MUST come from the repo-spec helper (server-provided props). No literal `0x...` addresses may be hardcoded into widget configuration or any other `src/**` app code; no env overrides.

2. **AUTH_BEFORE_PAYMENT**: User must be logged in via SIWE (Auth.js session) before the "Buy Credits" UI is shown. On widget payment success callback, the UI computes `amountUsdCents`, generates a `clientPaymentId` (UUID), and calls `POST /api/v1/payments/credits/confirm` with `{ amountUsdCents, clientPaymentId, metadata? }`. The UI must **never** send `billingAccountId` or user identifiers in the body.

3. **SINGLE_PAYMENT_ENTRY_POINT**: The "Buy Credits" button must live in a shared layout/header and open a single `BuyCreditsModal` (or equivalent) component that owns the payment widget integration.

### Backend

4. **SINGLE_MINTING_ENDPOINT**: `POST /api/v1/payments/credits/confirm` is the ONLY endpoint allowed to create `credit_ledger` entries with `reason = 'widget_payment'`.

5. **SESSION_ONLY_IDENTITY**: `billing_account_id` is resolved from the SIWE session via Auth.js → `user.id` → billing account mapping. The request body MUST NOT include any account or user identifiers that influence the billing account.

6. **INTEGER_CREDIT_MATH**: `amountUsdCents` is a positive integer (cents) supplied by the UI. Credits are computed using integer math: `1 credit = $0.001`, `1 cent = 10 credits`, `credits = amountUsdCents * 10` (or equivalent formula using `CREDITS_PER_USDC`). The ledger row uses `amount = credits` (positive BIGINT) and `reason = 'widget_payment'`.

7. **IDEMPOTENT_MINTING**: `clientPaymentId` is REQUIRED and must be a UUID. Before minting credits, the service checks for an existing `credit_ledger` row with `reason = 'widget_payment'` and `reference = clientPaymentId`. If such a row exists, the operation is a no-op and returns the current balance.

8. **ATOMIC_CREDIT_WRITE**: `credit_ledger` insert and `billing_accounts.balance_credits` update must occur in a single transaction.

9. **REASON_ISOLATION**: The literal `widget_payment` reason should be defined once (e.g. in a shared constants module) and used only by the credits confirm service.

## Design

### Repo-Spec Structure

The `.cogni/repo-spec.yaml` in cogni-template MUST declare the payment widget and env conventions so the operator's in-process review can enforce them.

Example (simplified):

```yaml
payments_in:
  widget:
    provider: depay # Current widget provider (DePay OSS mode)
    receiving_address: "0x0000000000000000000000000000000000000000" # DAO-owned receiver (no env override)
    allowed_chains:
      - base
    allowed_tokens:
      - USDC

cogni_dao:
  chain_id: "8453"

providers:
  openrouter:
    api_host: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
  cherryservers:
    api_host: https://api.cherryservers.com/v1
    api_key_env: CHERRY_API_TOKEN

llm_proxy:
  host_env: LITELLM_PROXY_URL
  master_key_env: LITELLM_MASTER_KEY

secrets:
  manager:
    type: env
```

This is declarative only. It describes:

- Which DAO receiving address and chain the widget must use (governed in git, not env).
- Which env vars are considered sensitive API keys.
- Which host/master-key pair defines the LLM proxy.

### In-Process Review Gates (cogni-operator)

The operator's in-process review (`nodes/operator/app/src/features/review/`) implements static gates that read `.cogni/repo-spec.yaml` and analyze PR diffs to enforce the rules above.

#### Gate: wallet-address-literals

**Intent:** Prevent new hardcoded on-chain addresses in app code.

**Behavior:**

- Scan changed hunks in `src/**` files for `0x[0-9a-fA-F]{40}`.
- If any new literal EVM address is introduced, the gate FAILS.
- Tests/mocks may be exempted by path convention if needed (e.g. `tests/**`), but production app code cannot introduce addresses directly.

**Effect:** Ensures the DAO multisig and any other on-chain addresses must be supplied via configuration instead of being baked into code.

#### Gate: widget-payment-reason

**Intent:** Ensure only the credits confirm flow can mint `widget_payment` credits.

**Behavior:**

- If `payments_in.widget` exists in repo-spec, the gate activates.
- Scan PR diffs for the string `widget_payment`.
- Allow it only in:
  - `src/app/api/v1/payments/credits/**/route.ts`,
  - `src/features/payments/**`,
  - and a shared constants file (e.g. `src/shared/constants/**/payments.ts`).
- If `widget_payment` appears in any other file, the gate FAILS.

**Effect:** No other feature can sneak in a code path that writes `credit_ledger` rows pretending to be widget payments.

#### Gate: provider-api-key-usage

**Intent:** Constrain sensitive provider and DAO env vars to env modules and the correct adapters.

**Behavior:**

- Read sensitive env names from repo-spec:
  - `providers.*.api_key_env` (OpenRouter, CherryServers, etc.).
  - `llm_proxy.master_key_env` (LiteLLM master key).
- For each env var name found in the PR diff:
  - Allow references only in:
    - `src/shared/env/**` (env parsing/validation), and
    - the corresponding adapter directory (e.g. `src/adapters/openrouter/**`, `src/adapters/cherryservers/**`, `src/adapters/litellm/**`).
  - If the env var name appears in any other path, the gate FAILS.

**Effect:** Sensitive provider keys cannot be quietly wired into unrelated modules or new network clients.

### Per-Scope Payment Rails (Multi-Project)

When a Node hosts multiple governance domains (scope_ids), each project manifest can declare its own payment rails:

```yaml
# .cogni/projects/chat-service.yaml
dao:
  contract: "0xAAAA..."
  chain_id: "8453"
payments:
  receiving_address: "0xAAAA..." # Chat service DAO's wallet
  allowed_tokens: [USDC]
```

**Invariants for per-scope rails:**

- **SCOPE_OWNS_RAILS**: Each scope's `receiving_address` must match its declared `dao.contract` or be an explicitly authorized address. No scope may use another scope's receiving address.
- **FALLBACK_SCOPE_RAILS**: The `'default'` scope inherits from `.cogni/repo-spec.yaml` `payments_in` (existing V0 behavior). Named scopes override with their own manifest.
- **RAIL_PAYOUT_ALIGNMENT**: Epoch payouts for a scope draw from that scope's DAO treasury. The `payout_statements` for scope X reference scope X's payment rails, never another scope's.

### Governance Config Protection

`.cogni/**` files (especially scope manifests and weight policies) are governance-critical and must be protected:

1. **CODEOWNERS guard**: `.cogni/**` must be listed in `CODEOWNERS` with explicit DAO-authorized reviewers. PRs changing scope config require these reviewers' approval.

2. **Policy change events**: When a `.cogni/projects/*.yaml` manifest is modified (weight policy, DAO address, payment rails), the merge triggers an immutable **"policy_changed"** event in the `activity_events` table. This event:
   - Records the old and new values (before/after snapshot)
   - References the merge commit SHA as `artifact_url`
   - Is append-only (ACTIVITY_APPEND_ONLY) and auditable
   - Ensures payout explanations can reference which policy was active for each epoch

3. **Weight policy pinning**: Each epoch stores its `weight_config` at creation time. A policy change mid-epoch does NOT retroactively affect the current epoch's weights — only future epochs pick up the new policy.

### Extensibility Baseline

As additional payment providers and on-chain verification (Ponder) are added:

- All on-chain payment flows must settle into `credit_ledger` via well-defined reasons (e.g. `widget_payment`, `onchain_deposit`).
- `.cogni/repo-spec.yaml` remains the single source of truth for which env vars and providers participate in the DAO's financial rails.
- The in-process review evolves with new gates and reasons, but the core invariants remain: no literal EVM addresses in code, single-owner minting paths per reason, sensitive keys confined to env modules and adapters.

### File Pointers

| File                                               | Role                                            |
| -------------------------------------------------- | ----------------------------------------------- |
| `.cogni/repo-spec.yaml`                            | DAO governance — addresses, chains, env vars    |
| `src/app/api/v1/payments/credits/confirm/route.ts` | Single minting endpoint                         |
| `src/features/payments/`                           | Payment feature code (allowed `widget_payment`) |
| `src/shared/env/`                                  | Env parsing (allowed sensitive key references)  |
| `src/shared/config/repoSpec.server.ts`             | Repo-spec loader + alignment validation         |

## Acceptance Checks

**Automated:**

- In-process review `wallet-address-literals` gate fails on hardcoded `0x...` in `src/**`
- In-process review `widget-payment-reason` gate fails on `widget_payment` outside allowed paths
- In-process review `provider-api-key-usage` gate fails on sensitive env vars outside allowed paths

**Manual:**

1. Verify `POST /api/v1/payments/credits/confirm` resolves `billing_account_id` from session only
2. Verify duplicate `clientPaymentId` returns existing balance (idempotency)
3. Verify credit math: 100 cents → 1000 credits (integer math, no floating point)

## Open Questions

_(none — on-chain reconciliation and multi-provider routing tracked in proj.payments-enhancements.md)_

## Related

- [Chain Configuration](./chain-config.md)
- [Authentication](./authentication.md)
- [Billing Evolution](./billing-evolution.md)
- [Identity Model](./identity-model.md) — node_id, scope_id definitions
- [Attribution Ledger](./attribution-ledger.md) — scope_id in ledger invariants
