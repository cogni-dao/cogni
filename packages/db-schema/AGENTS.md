# db-schema · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Drizzle ORM table definitions for all database domains. Provides type-safe schema exports consumed by adapters and the main application.

## Pointers

- [Scheduler Spec](../../docs/spec/scheduler.md): Scheduling domain invariants
- [Databases](../../docs/spec/databases.md): Database architecture and migrations
- [Packages Architecture](../../docs/spec/packages-architecture.md): Package isolation boundaries

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

**External deps:** `drizzle-orm`.

## Public Surface

- **Exports (via subpath exports):**
  - `@cogni/db-schema/refs` - Core FK reference tables (`users`, `billingAccounts`)
  - `@cogni/db-schema/scheduling` - Scheduling tables (`executionGrants`, `schedules`, `graphRuns` (canonical, `scheduleRuns` deprecated alias), `executionRequests`, `GRAPH_RUN_STATUSES`, `GRAPH_RUN_KINDS`)
  - `@cogni/db-schema/auth` - Auth tables
  - `@cogni/db-schema/billing` - Billing tables
  - `@cogni/db-schema/ai` - AI-related tables
  - `@cogni/db-schema/ai-threads` - Thread persistence table (UIMessage[] JSONB, RLS, optimistic concurrency)
  - `@cogni/db-schema/identity` - Identity binding tables (`userBindings`, `linkTransactions`, `identityEvents`)
  - `@cogni/db-schema/attribution` - Attribution pipeline tables (`epochs`, `ingestionReceipts`, `epochSelection`, `epochReceiptClaimants`, `epochUserProjections`, `epochReviewSubjectOverrides`, `epochFinalClaimantAllocations`, `ingestionCursors`, `epochPoolComponents`, `epochStatements`, `epochStatementSignatures`)
- **Files considered API:** All `src/*.ts` files via package.json exports

## Ports

- **Uses ports:** none
- **Implements ports:** none (schema definitions only)

## Responsibilities

- This directory **does**: Define Drizzle table schemas, foreign key relationships, indexes
- This directory **does not**: Contain queries, adapters, business logic, or I/O

## Usage

```bash
pnpm --filter @cogni/db-schema typecheck
pnpm --filter @cogni/db-schema build
```

## Standards

- Per FORBIDDEN: No `@/`, `src/`, `process.env`, or runtime logic
- Per ALLOWED: Pure Drizzle schema definitions only
- All tables reference core entities via `./refs.ts` imports

## Dependencies

- **Internal:** none (standalone package)
- **External:** `drizzle-orm`

## Change Protocol

- Update this file when table schemas or subpath exports change
- Bump **Last reviewed** date
- Run migrations after schema changes

## Notes

- Subpath exports enable tree-shaking: consumers import only needed slices
- `refs.ts` defines FK target tables shared across all slices
- Schedule tables support Temporal migration (execution_requests for idempotency)
- `billing.ts` includes `llmChargeDetails` (1:1 with charge_receipts, PK/FK cascade) for model/tokens/provider/latency/graphId
- `charge_receipts.receipt_kind` distinguishes receipt types (e.g. "llm")

- `infra-control.ts` is the root-owned administrative `cogni_control` recovery ledger. It stays outside `src/**` and all app exports/configs, uses `infra/drizzle.control.config.ts`, and has no cross-database application/user FK.
