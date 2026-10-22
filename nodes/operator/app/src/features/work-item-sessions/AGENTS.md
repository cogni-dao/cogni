# features/work-item-sessions · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Pure policy for operator work-item execution sessions: deadline math, DTO mapping, and the `nextAction` text the operator pushes back to contributors via `GET /coordination`. No persistence, auth, or HTTP translation lives here — this directory is the brain, not the IO.

## Pointers

- [Root AGENTS.md](../../../../../../../AGENTS.md)
- [Development Lifecycle spec](../../../../../../../docs/spec/development-lifecycle.md) (`nextActionForWorkItem` is the operator's pushback channel referenced by the spec)
- [Operator Dev Lifecycle Coordinator design](../../../../../../../docs/design/operator-dev-lifecycle-coordinator.md)
- [Sessions Zod contract](../../contracts/work-item-sessions.v1.contract.ts)
- [App-layer facade](../../app/_facades/work/coordination.server.ts) (binds session user + container, calls policy)
- [HTTP routes](../../app/api/v1/work/items/%5Bid%5D/) — `claims`, `heartbeat`, `pr`, `coordination`
- [Session port](../../ports/work-item-session.port.ts)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["contracts", "ports"],
  "must_not_import": ["app", "adapters", "bootstrap"]
}
```

## Public Surface

- **Exports (from `session-policy.ts`):**
  - `DEFAULT_SESSION_TTL_SECONDS` — 30-minute session TTL constant
  - `deadlineFromNow(now, ttlSeconds)` — pure deadline calculator
  - `effectiveSessionStatus(session, now)` — collapses `active` to `idle` when deadline elapsed
  - `toWorkItemSessionDto(session, now)` — `WorkItemSessionRecord` → `WorkItemSessionDto`
  - `nextActionForWorkItem({ workItem, session, now, conflict? })` — operator pushback text driving `/coordination` responses. Once a PR is linked it names the hub lifecycle order: `needs_merge` starts a fresh `/review-implementation` while CI runs, then flight, `/validate-candidate`, and one PATCH to `needs_closeout` + `deployVerified: true`; `needs_closeout` runs `/closeout` (operator merge). `deployVerified` never branches the text.
- **Routes (if any):** none — this directory is policy only. Routes live under `app/api/v1/work/items/[id]/{claims,heartbeat,pr,coordination}/`.
- **Env/Config keys:** none

## Ports (optional)

- **Uses ports:** none directly (consumes `WorkItemSessionRecord` / `WorkItemSessionStatus` types from `@/ports`)
- **Implements ports:** none

## Responsibilities

- This directory **does**: encode session lifecycle policy as pure functions; decide the next-action text for any (workItem, session) pair; map persistence records to DTOs.
- This directory **does not**: persist sessions, perform auth, parse HTTP, call the work-item store, or hold any IO. Persistence belongs to the `WorkItemSessionPort` adapter; HTTP and auth belong to the route handlers; container wiring + work-item facade calls belong to `app/_facades/work/coordination.server.ts`.

## Notes

- Invariant: `DOLT_IS_SOURCE_OF_TRUTH` — work-item status from Dolt remains the lifecycle input; session state only guides active execution.
- `nextActionForWorkItem` is exercised by external agents polling `GET /api/v1/work/items/:id/coordination` between lifecycle steps; treat its text as a stable contract surface, not a debug string.
- All functions take an explicit `now: Date` so tests can pin time without faking the clock.
