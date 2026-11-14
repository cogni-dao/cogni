---
id: security-auth-spec
type: spec
title: Security & Authentication
status: active
spec_state: draft
trust: draft
summary: Auth.js + SIWE session cookies for browsers; App API keys (target) for programmatic clients; credential mapping to LiteLLM virtual keys for per-key spend tracking.
read_when: Working on authentication, route protection, API key design, or credential mapping.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [auth]
---

# Security & Authentication

## Context

This spec owns client auth surfaces, route protection policy, and credential handling rules. It does **not** own billing ledger semantics (see accounts-design spec). The system has two auth surfaces: browser UI (implemented via Auth.js session cookies) and programmatic API (target: App API keys). Both resolve to a billing account for credits.

## Goal

Define a unified auth model where browser sessions and programmatic API keys both resolve to a billing account, with LiteLLM virtual key mapping for per-key spend tracking — while enforcing strict credential handling rules (no secrets in browser storage, hash-only key storage).

## Non-Goals

- Billing ledger semantics or credit accounting (see accounts-design spec)
- LiteLLM proxy configuration details (see ai-setup spec)
- RBAC role definitions or permission grants (see rbac spec)

## Core Invariants

1. **NO_BROWSER_SECRETS**: No API keys in localStorage/sessionStorage. Browser auth uses HttpOnly session cookies only.

2. **HASH_ONLY_STORAGE**: App API keys are stored as hashes only; plaintext shown once at creation, never stored.

3. **NO_PLAINTEXT_LITELLM_KEYS**: LiteLLM key material is never returned to the client or stored plaintext in the app DB.

4. **EXPLICIT_BEHAVIOR**: No "modes" implied by naming. If behavior changes, it must be explicit and validated.

5. **CURRENT_TARGET_SEPARATION**: "Current State" vs "Target State" must be clearly separated in documentation and code comments.

## Design

### Auth Surfaces

#### A) Browser UI (Current — Implemented)

- Auth mechanism: Auth.js session cookie (HttpOnly).
- SIWE verification: Auth.js Credentials provider + `siwe` library.
- Used by: web app calling `/api/v1/*`.

#### B) Programmatic API (Target — Not Yet Implemented)

- Auth mechanism: `Authorization: Bearer <app_api_key>` (product key, not a LiteLLM key).
- Lookup: hash the presented key, match `app_api_keys.key_hash`.
- Result: `{ billing_account_id, app_api_key_id }` for authorization + attribution.

Key lifecycle endpoints (target):

- `POST /api/v1/keys` (session required)
- `GET /api/v1/keys` (session required)
- `DELETE /api/v1/keys/:id` (session required)

### Route Policy

- Public (no auth): `/health`, `/openapi.json`, `/meta/*`, `/api/auth/*`
- Protected (requires auth): **all** `/api/v1/*` endpoints
  - Current: session required
  - Target: session OR app_api_key

### Credential Mapping (Target for LLM Calls)

- App API keys are **our** product credential.
- Each app_api_key maps 1:1 to a **server-only** LiteLLM virtual key identity for per-key spend attribution.
- Outbound call uses the mapped LiteLLM key (never exposed to client).

### Current State (Implemented)

- Session-only auth is implemented.
- Outbound LiteLLM calls use service auth (`LITELLM_MASTER_KEY`).
- App API keys are not implemented yet.
- Per-key spend attribution is not implemented until app_api_keys + mapping exists.

### Target State Acceptance Criteria (API Keys)

These criteria will be tracked by `proj.accounts-api-keys` initiative when the ACCOUNTS docs are migrated:

1. `app_api_keys` table exists with hash-only storage + show-once plaintext.
2. `/api/v1/*` accepts session OR Bearer app_api_key.
3. For LLM endpoints, Bearer app_api_key resolves to a mapped LiteLLM key for per-key spend tracking.
4. No LiteLLM key material is ever returned to the client or stored plaintext.

### File Pointers

| File                 | Purpose                      |
| -------------------- | ---------------------------- |
| `src/app/api/auth/`  | Auth.js route handlers       |
| `src/core/auth/`     | Auth domain logic            |
| `src/adapters/auth/` | Auth adapter implementations |

## Acceptance Checks

**Automated:**

- `pnpm check` — type checking validates auth types
- `pnpm test` — auth-related unit tests

**Manual:**

1. Verify no API keys appear in browser storage (DevTools → Application → Storage)
2. Verify session cookies are HttpOnly
3. Verify protected routes return 401 without valid session

## Open Questions

_(none)_

## Related

- [Authentication Spec](./authentication.md) — Auth.js implementation details
- [RBAC Spec](./rbac.md) — Role-based access control
- [AI Setup Spec](./ai-setup.md) — LiteLLM proxy configuration
