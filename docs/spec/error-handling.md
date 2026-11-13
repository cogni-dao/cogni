---
id: error-handling-spec
type: spec
title: Error Handling Architecture
status: active
spec_state: draft
trust: draft
summary: Layered error translation pattern — domain errors, port errors, feature errors, AI execution errors — with clean boundaries and type safety.
read_when: Adding error types, translating errors across boundaries, or working with AI execution error codes.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [meta]
---

# Error Handling Architecture

## Context

This codebase uses a **layered error translation pattern** that maintains clean boundaries while preserving type safety and structured error information across all layers. Errors flow from adapters through features to app routes, getting translated at each boundary into the consuming layer's error algebra.

## Goal

Provide structured, type-safe error handling where each architectural layer has its own error types, errors are translated at boundaries (not leaked), and consumers receive stable error contracts that don't break when internals change.

## Non-Goals

- Global error middleware (each route handles its own errors via feature error contracts)
- Error recovery/retry logic at the architecture level (handled per-feature)
- Client-side error handling patterns (this is backend only)

## Core Invariants

1. **LAYER_ERROR_ISOLATION**: Each layer defines and uses its own error types. Domain errors stay in core, port errors stay between adapters and features, feature errors stay between features and app routes.

2. **ERROR_TRANSLATION_AT_BOUNDARY**: Errors are caught and translated at each layer boundary. Adapters throw port errors; features catch port errors and return feature errors; app routes match feature error kinds to HTTP status codes.

3. **NO_RAW_THROW_PAST_FEATURE**: Feature services never let raw port/adapter errors leak to the app layer. They catch, translate, and return `{ ok: false, error: FeatureError }`.

4. **ERROR_NORMALIZATION_ONCE** (AI errors): `normalizeErrorToExecutionCode()` is the single source of truth for mapping any error to an `AiExecutionErrorCode`. Metrics and consumers receive pre-normalized codes, never introspect error objects.

5. **NO_RAW_THROW_PAST_COMPLETION** (AI errors): `completion.ts` catches all errors, normalizes, and returns structured `{ ok: false, error: AiExecutionErrorCode }` to all consumers.

6. **FAULT_PARTY_BEFORE_BUCKET**: An error code must encode _who can fix it_ before it collapses to a generic bucket. Operator-fault upstream failures normalize to `provider_unavailable` (provider down, `5xx`) or `provider_unfunded` (the operator's provider account is out of credit, OpenRouter `402`; bug.5626) → HTTP `503`, never `internal`/`500`, and never `insufficient_credits` (that is the _user's_ balance). `internal` is the alarm bucket, not the dump: a known condition reaching it is a taxonomy hole. Distinct codes get distinct `ai_llm_errors_total{code}` labels so credit depletion is alertable (bug.5056).

## Design

### Error Types by Layer

**Domain Errors (`core/*/errors.ts`)**

- Business rule violations: `UnknownApiKeyError`, `InsufficientCreditsError`, `AccountNotFoundError`
- Rich contextual data: account IDs, required amounts, previous balances, etc.
- **Used by**: Core domain logic, feature services (via `core/*/public.ts`)
- **Never used by**: App layer, adapters

**Port Errors (`ports/*`)**

- Errors defined at the port boundary: `InsufficientCreditsPortError`, `AccountNotFoundPortError`
- Structured data emitted by adapters and consumed by features
- **Used by**: Adapters (thrown), feature services (caught and translated)
- **Not thrown by**: Core domain (core does not talk directly to infra)

**Feature Errors (`features/*/errors.ts`)**

- Cross-boundary contracts: e.g. `AccountsFeatureError` with a `kind` discriminator
- Stable error algebra: `{ kind: "UNKNOWN_API_KEY" }`, `{ kind: "INSUFFICIENT_CREDITS"; accountId; required; available }`
- **Used by**: Feature services (returned), app layer (for HTTP mapping)
- **Never used by**: Adapters, ports

### Error Flow Pattern

```txt
Adapter → Port Error → Feature Service → Feature Error → App Route → HTTP Response
```

**Example:**

1. **Adapter**: `throw new InsufficientCreditsPortError(accountId, cost, balance)`
2. **Feature**: catches port error → returns `{ ok: false, error: { kind: "INSUFFICIENT_CREDITS", accountId, required: cost, available: balance } }`
3. **App Route**: matches `error.kind === "INSUFFICIENT_CREDITS"` → returns `NextResponse.json({ error: "Insufficient credits" }, { status: 402 })`

### Implementation Guidelines

**Adapters (`src/adapters/**/\*.adapter.ts`)\*\*

```typescript
import { InsufficientCreditsPortError } from "@/ports/accounts.port";

// ✅ Throw structured port errors
throw new InsufficientCreditsPortError(accountId, cost, balance);

// ❌ Never throw domain errors
// throw new InsufficientCreditsError(accountId, cost, balance);

// ❌ Avoid generic errors for domain-relevant conditions
// throw new Error("Insufficient credits");
```

**Feature Services (`src/features/*/services/*.ts`)**

```typescript
import { isInsufficientCreditsPortError } from "@/ports/accounts.port";
import type { AccountsFeatureError } from "@/features/accounts/errors";

try {
  await accountPort.debitCredits(params);
} catch (error) {
  // Translate port errors to feature errors
  if (isInsufficientCreditsPortError(error)) {
    return {
      ok: false,
      error: {
        kind: "INSUFFICIENT_CREDITS",
        accountId: error.accountId,
        required: error.cost,
        available: error.previousBalance,
      } satisfies AccountsFeatureError,
    };
  }

  throw error; // let unexpected errors bubble
}
```

**App Routes (`src/app/api/**/route.ts`)\*\*

```typescript
import type { AccountsFeatureError } from "@/features/accounts/errors";

try {
  const result = await featureService.operation(params);

  if (!result.ok) {
    const error = result.error as AccountsFeatureError;

    if (error.kind === "UNKNOWN_API_KEY") {
      return NextResponse.json({ error: "Invalid API key" }, { status: 403 });
    }

    if (error.kind === "INSUFFICIENT_CREDITS") {
      return NextResponse.json(
        { error: "Insufficient credits" },
        { status: 402 }
      );
    }
  }

  // handle success...
} catch (error) {
  // generic fallback error handling
}
```

### AI Execution Errors

AI/LLM errors follow a specialized pattern with **single-point normalization** to stable error codes.

**Error Types (all in `@cogni/ai-core`):**

- `LlmError` — Thrown by adapters; captures `kind` (timeout, rate_limited, provider_4xx, etc.) and optional HTTP `status`
- `AiExecutionError` — Carries structured `code` field through call chains (thrown by CogniCompletionAdapter)
- `AiExecutionErrorCode` — Stable contract: `invalid_request`, `not_found`, `timeout`, `aborted`, `rate_limit`, `internal`, `insufficient_credits`, `provider_unavailable`, `provider_unfunded`

**Error Flow:**

1. Adapter throws `LlmError` with kind + status at HTTP/SSE boundary
2. `CogniCompletionAdapter` catches, throws `AiExecutionError` with structured code
3. Graph runner catches, calls `normalizeErrorToExecutionCode()` for any error type
4. `completion.ts` catches connection-time errors, normalizes via same function
5. Returns `{ ok: false, error: AiExecutionErrorCode }` to all consumers
6. Metrics, logs, and responses consume the pre-normalized code

**Normalization Priority:** AbortError → AiExecutionError.code → LlmError (status 429/408 → kind fallback) → "internal"

**Structured Boundary Logging:** Adapters emit `adapter.litellm.http_error` / `adapter.litellm.sse_error` with `{statusCode, kind, requestId, traceId, model}`. Raw provider messages stay in Langfuse only.

**Import Paths:**

| Consumer | Import From                                                                        |
| -------- | ---------------------------------------------------------------------------------- |
| Packages | `@cogni/ai-core` — canonical source for all error types and normalization          |
| Features | `@cogni/ai-core` — `normalizeErrorToExecutionCode`, `isLlmError`, `LlmError`       |
| Adapters | `@/ports` — re-exports from `@cogni/ai-core` (arch constraint: adapters use ports) |
| Metrics  | Receives `AiExecutionErrorCode` directly (no error introspection)                  |

### Design Notes

- Core should not depend on port errors — core domain logic remains infrastructure-agnostic
- Ports + port errors are used exclusively between adapters and features
- Feature error algebras provide stable contracts that isolate app routes from domain changes
- AI errors use `AiExecutionErrorCode` as the stable contract across the system

### File Pointers

| File                                       | Role                                         |
| ------------------------------------------ | -------------------------------------------- |
| `src/core/*/errors.ts`                     | Domain error types                           |
| `src/ports/*.port.ts`                      | Port error types + type guards               |
| `src/features/*/errors.ts`                 | Feature error algebras (kind discriminators) |
| `packages/ai-core/src/errors/`             | AI error types + normalization function      |
| `src/app/_facades/ai/completion.server.ts` | AI error boundary (normalizes all errors)    |

## Acceptance Checks

**Automated:**

- Unit tests verify port error → feature error translation in feature services
- Unit tests verify `normalizeErrorToExecutionCode()` maps all known error types
- Depcruiser rules enforce import boundaries (adapters import from ports, not core)

**Manual:**

1. Verify an `InsufficientCreditsPortError` in an adapter results in HTTP 402 at the route level
2. Verify an unknown error type from an adapter results in HTTP 500 (generic fallback)

## Open Questions

_(none)_

## Related

- [Architecture](./architecture.md) — Hexagonal layer definitions
- [AI Architecture and Evals](./ai-evals.md) — AI execution patterns
- [Observability](./observability.md) — Structured logging for error boundaries
