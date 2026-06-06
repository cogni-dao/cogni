# schedules · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

REST API routes for schedule CRUD operations. Auth-protected endpoints for creating, listing, updating, and deleting scheduled graph executions.

## Pointers

- [Scheduler Spec](../../../../../../../docs/spec/scheduler.md)
- [Schedule Contracts](../../../../contracts/)

## Boundaries

```json
{
  "layer": "app",
  "may_import": [
    "features",
    "bootstrap",
    "contracts",
    "shared",
    "ports",
    "styles"
  ],
  "must_not_import": ["adapters", "core"]
}
```

## Public Surface

- **Exports:** none (route handlers only)
- **Routes:**
  - `POST /api/v1/schedules` — create schedule (returns 201)
  - `GET /api/v1/schedules` — list user's schedules
  - `PATCH /api/v1/schedules/[scheduleId]` — update schedule
  - `DELETE /api/v1/schedules/[scheduleId]` — delete schedule (returns 204)
- **Files considered API:** route.ts, [scheduleId]/route.ts

## Ports

- **Uses ports:** `ScheduleManagerPort` (via container)
- **Implements ports:** none

## Responsibilities

- This directory **does:** validate request bodies via Zod contracts, authenticate via session, delegate to ScheduleManagerPort.
- This directory **does not:** contain scheduling logic, grant management, or job queue operations.

## Usage

```bash
# Create schedule
curl -X POST /api/v1/schedules -d '{"graphId":"langgraph:poet","cron":"0 9 * * *","timezone":"UTC","input":{}}'

# List schedules
curl /api/v1/schedules
```

## Standards

- All routes auth-protected (session required)
- Input validated via contract schemas
- Ownership enforced (user can only access own schedules)

## Dependencies

- **Internal:** @/contracts/schedules.\*.v1.contract, @/bootstrap/container, @/app/\_lib/auth/session
- **External:** next/server

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date
- Update contracts if request/response shape changes

## Notes

- Schedule creation atomically creates grant + schedule + enqueues first job
- Disabling schedule sets `nextRunAt` to null; re-enabling seeds next run
