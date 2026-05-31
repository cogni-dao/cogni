# types · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable

## Purpose

Bottom-of-tree type definitions. TS utility types, branded types, ambient global.d.ts, domain enums, conditional types, literal unions. Re-exports AI types from `@cogni/ai-core` (per SINGLE_SOURCE_OF_TRUTH invariant). No runtime code.

## Pointers

- [Root AGENTS.md](../../../../AGENTS.md)
- [Architecture](../../../../docs/spec/architecture.md)
- **Related:** [contracts](../contracts/) (external IO specs), [shared/schemas](../shared/) (runtime primitives), [packages/ai-core](../../../../packages/ai-core/) (canonical AI types)

## Boundaries

```json
{
  "layer": "types",
  "may_import": ["types"],
  "must_not_import": [
    "app",
    "features",
    "adapters/server",
    "adapters/worker",
    "core",
    "ports",
    "contracts",
    "shared"
  ]
}
```

## Public Surface

- **Exports:** TS utility types, branded types, global.d.ts, Env interfaces, domain enums
  - `payments.ts` - PaymentFlowState, PaymentStatus, PaymentAttemptStatus, PaymentErrorCode (canonical source)
  - `billing.ts` - Re-exports SourceSystem from @cogni/ai-core; defines ChargeReason, BillingCommitFn (DI callback type for billing decorator)
  - `usage.ts` - Re-exports UsageFact, ExecutorType from @cogni/ai-core
  - `ai-events.ts` - Re-exports AiEvent union from @cogni/ai-core
  - `ai-span.ts` - AiSpanPort, AiSpanHandle (provider-agnostic span interface for tool instrumentation)
  - `run-context.ts` - Re-exports RunContext from @cogni/ai-core
  - `next-auth.d.ts` - NextAuth session extensions
- **Files considered API:** **/\*.ts, **/\*.d.ts

## Ports (optional)

- **Uses ports:** none
- **Implements ports:** none
- **Contracts:** n/a

## Responsibilities

- This directory **does**: provide compile-time type utilities, branded types, ambient declarations, domain enums; re-exports AI types from @cogni/ai-core for backwards compatibility
- This directory **does not**: contain Zod schemas, runtime validation, external IO definitions, or functions; does not define AI types (canonical source: @cogni/ai-core)

## Usage

```bash
pnpm -w typecheck
```

## Standards

- TypeScript types only; no Zod or runtime validation
- Use branded types for domain concepts (e.g., `WalletAddress`, `SessionId`)
- Global ambient types go in `global.d.ts`

## Dependencies

- **Internal:** types/ only, @cogni/ai-core (re-exports)
- **External:** none (compile-time only)

## Change Protocol

- Update this file when **Exports** change
- No versioning policy (compile-time only)
- Ensure typecheck passes

## Notes

- Bottom layer - all other layers may import from here
- AI types (AiEvent, UsageFact, etc.) are re-exports from @cogni/ai-core per SINGLE_SOURCE_OF_TRUTH invariant
- Never the source of truth for external IO - use `contracts/` for that
- For runtime primitives, use `shared/schemas/`
- payments.ts contains type-only exports; prevents circular dependencies between core/contracts/features
