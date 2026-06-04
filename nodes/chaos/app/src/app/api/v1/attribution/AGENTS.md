# attribution · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Authenticated HTTP endpoints for attribution operations. SIWE-protected reads for all epochs and PII-containing activity streams, plus approver-gated write mutations for review-subject overrides, pool components, epoch review transitions, and epoch finalization.

## Pointers

- [Attribution Ledger Spec](../../../../../../../docs/spec/attribution-ledger.md)
- [Attribution Contracts](../../../../contracts/attribution.list-epochs.v1.contract.ts)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["bootstrap", "contracts", "shared"],
  "must_not_import": ["adapters", "core", "ports", "features"]
}
```

## Public Surface

- **Exports:** none (route handlers only)
- **Routes:**
  - `GET /api/v1/attribution/epochs` — list all epochs including open (SIWE auth)
  - `GET /api/v1/attribution/epochs/[id]/activity` — ingestion receipts with selection join (SIWE auth, PII)
  - `GET /api/v1/attribution/epochs/[id]/claimants` — claimant-aware finalized attribution (SIWE auth)
  - `GET /api/v1/attribution/epochs/[id]/user-projections` — read unsigned per-user projections (SIWE auth)
  - `POST /api/v1/attribution/epochs/[id]/pool-components` — record pool component (SIWE + approver)
  - `POST /api/v1/attribution/epochs/[id]/review` — close ingestion, transition open → review (SIWE + approver)
  - `GET /api/v1/attribution/epochs/[id]/sign-data` — EIP-712 typed data for epoch signing (SIWE + approver)
  - `GET|PATCH|DELETE /api/v1/attribution/epochs/[id]/review-subject-overrides` — manage subject identity overrides for epoch review (SIWE + approver)
  - `POST /api/v1/attribution/epochs/[id]/finalize` — sign + finalize epoch, returns 202 + {workflowId, created} (SIWE + approver, WRITES_VIA_TEMPORAL). Returns 503 if no ledger-tasks pollers.
  - `POST /api/v1/attribution/epochs/collect` — trigger epoch collection on demand (SIWE session, any user, 5min cooldown). Triggers LEDGER_INGEST schedule via ScheduleHandle.trigger().
- **Files considered API:** `epochs/route.ts`, `epochs/[id]/activity/route.ts`, `epochs/[id]/claimants/route.ts`, `epochs/[id]/user-projections/route.ts`, `epochs/[id]/pool-components/route.ts`, `epochs/[id]/review/route.ts`, `epochs/[id]/sign-data/route.ts`, `epochs/[id]/review-subject-overrides/route.ts`, `epochs/[id]/finalize/route.ts`, `epochs/collect/route.ts`

## Ports

- **Uses ports:** `AttributionStore` (via container)
- **Implements ports:** none

## Responsibilities

- This directory **does:** authenticate via SIWE session, check approver allowlist for write routes, validate I/O via Zod contracts, delegate to `AttributionStore`.
- This directory **does not:** contain business logic, expose unauthenticated data, or bypass approver checks.

## Usage

```bash
# Authenticated reads (require SIWE session cookie)
curl -b session http://localhost:3000/api/v1/attribution/epochs
curl -b session http://localhost:3000/api/v1/attribution/epochs/1/activity

# Authenticated projection read
curl -b session http://localhost:3000/api/v1/attribution/epochs/1/user-projections

# Approver-gated override write
curl -X PATCH -b session http://localhost:3000/api/v1/attribution/epochs/1/review-subject-overrides \
  -H 'Content-Type: application/json' \
  -d '{"overrides":[{"subjectRef":"receipt-1","overrideUnits":"5000"}]}'
```

## Standards

- All routes use `wrapRouteHandlerWithLogging({ auth: { mode: "required" } })`
- Write routes call `checkApprover()` from `_lib/approver-guard.ts` before mutations
- Approver allowlist sourced from `activity_ledger.approvers` in `.cogni/repo-spec.yaml`

## Dependencies

- **Internal:** `@/bootstrap/http`, `@/bootstrap/container`, `@/contracts/attribution.*.v1.contract`, `@/shared/config`, `@/app/_lib/auth/session`
- **External:** `next/server`, `@temporalio/client` (finalize route only)

## Change Protocol

- Update this file when **Routes** or **approver-guard** logic changes
- Bump **Last reviewed** date

## Notes

- `_lib/approver-guard.ts` checks `sessionUser.walletAddress` against `getAttributionApprovers()`. Empty approvers list = all writes rejected.
- Approver list is cached at process level; changes require restart.
