# node-core · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Shared domain models, types, and pure business logic for all node apps. Contains accounts, AI, attribution, billing, chat, and payments domain logic. PURE_LIBRARY — no env vars, no process lifecycle, no framework deps.

## Pointers

- [Packages Architecture](https://node-template.cognidao.org/knowledge/package-isolation-rules)
- [Node App Shell Spec](https://node-template.cognidao.org/knowledge/node-app-shell-contract)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

## Public Surface

- **Exports (via `src/index.ts`):**
  - `Account`, `AccountNotFoundError`, `InsufficientCreditsError`, `ensureHasCredits`, `hasSufficientCredits`
  - `applyBaselineSystemPrompt`, `BASELINE_SYSTEM_PROMPT`, `estimateTotalTokens`, `ESTIMATED_USD_PER_1K_TOKENS`
  - `EpochStatus`, `FinalizedAllocation`, `StatementLineItem`, attribution error classes
  - `CREDITS_PER_USD`, `calculateLlmUserCharge`, `calculateOpenRouterTopUp`, `creditsToUsd`, `usdToCredits`
  - `Message`, `MessageRole`, `MessageToolCall` (re-export from `@cogni/ai-core`)
  - `ChatErrorCode`, `ChatValidationError`, `assertMessageLength`, `trimConversationHistory`
  - Payment types: `PaymentAttempt`, `PaymentErrorCode`, `PaymentAttemptStatus`, state machine helpers
  - Type re-exports: `AiEvent`, `UsageFact`, `RunContext`, `SourceSystem`, `ChargeReason`

## Responsibilities

- This directory **does**: Define cross-node domain models, validation rules, error classes, pricing logic
- This directory **does not**: Make I/O calls, read env vars, import framework code, define ports or adapters

## Usage

```bash
pnpm --filter @cogni/node-core typecheck
pnpm --filter @cogni/node-core build
```

## Dependencies

- **Internal:** `@cogni/ai-core`, `@cogni/attribution-ledger`
- **External:** none

## Notes

- Extracted from `apps/operator/src/core/` and `apps/operator/src/types/` (task.0248 Phase 1)
- `@/core` and `@/types/*` aliases no longer resolve — all consumers import from `@cogni/node-core`
