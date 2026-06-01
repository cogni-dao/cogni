# public/attribution · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Public (unauthenticated) HTTP endpoints for finalized attribution data. Exposes finalized-epoch lists, user projections, epoch statements, and claimant-aware finalized attribution to the community-attribution frontend without requiring a SIWE session.

## Pointers

- [Attribution Ledger Spec](../../../../../../../../docs/spec/attribution-ledger.md)
- [Attribution Contracts](../../../../../contracts/attribution.list-epochs.v1.contract.ts)

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
  - `GET /api/v1/public/attribution/epochs` — list finalized epochs (paginated)
  - `GET /api/v1/public/attribution/epochs/[id]/user-projections` — user projections for a finalized epoch
  - `GET /api/v1/public/attribution/epochs/[id]/claimants` — claimant-aware finalized attribution for a finalized epoch
  - `GET /api/v1/public/attribution/epochs/[id]/statement` — payout statement (null if none)
- **Files considered API:** `epochs/route.ts`, `epochs/[id]/user-projections/route.ts`, `epochs/[id]/claimants/route.ts`, `epochs/[id]/statement/route.ts`

## Ports

- **Uses ports:** `AttributionStore` (via container)
- **Implements ports:** none

## Responsibilities

- This directory **does:** serve finalized epoch data via `wrapPublicRoute()`, validate output via Zod contracts, enforce PUBLIC_READS_FINALIZED_ONLY invariant.
- This directory **does not:** expose open/current epoch data, raw activity streams, PII fields, or write mutations.

## Usage

```bash
curl http://localhost:3000/api/v1/public/attribution/epochs
curl http://localhost:3000/api/v1/public/attribution/epochs/1/user-projections
curl http://localhost:3000/api/v1/public/attribution/epochs/1/claimants
curl http://localhost:3000/api/v1/public/attribution/epochs/1/statement
```

## Standards

- All routes use `wrapPublicRoute()` with cache headers
- Output validated via contract schemas before responding
- Only finalized epochs exposed (PUBLIC_READS_FINALIZED_ONLY)

## Dependencies

- **Internal:** `@/bootstrap/http` (wrapPublicRoute), `@/bootstrap/container`, `@/contracts/attribution.*.v1.contract`, `@/shared/config`
- **External:** `next/server`

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date

## Notes

- `_lib/attribution-dto.ts` contains shared DTO mappers for BigInt/Date serialization; used by both public and auth routes.
- `wrapPublicRoute` does not propagate TContext to handler — dynamic routes use `context as { params: Promise<{ id: string }> }` cast.
