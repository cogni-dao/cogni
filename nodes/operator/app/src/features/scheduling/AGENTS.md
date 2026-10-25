# features/scheduling · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Last reviewed:** 2026-10-25
- **Status:** stable

## Purpose

Bind authenticated operator identities and node-owned schedule lookup to the published scheduling metadata reader.

## Pointers

- [Ports](../../ports/AGENTS.md)
- [Container](../../bootstrap/AGENTS.md)
- [Delivery work item](https://cognidao.org/work/items/task.5356)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["ports", "shared", "types"],
  "must_not_import": ["app", "adapters"]
}
```

## Public Surface

- `services/history.ts`: `createOwnedScheduleHistory` injects the schedule manager and `ScheduleRunReader` into `@cogni/scheduling`.
- Dependencies: `@cogni/ids`, `@cogni/scheduling`, and `@/ports/server`.

## Responsibilities

- Validate caller identities before node-owned schedule lookup.
- Delegate ownership checks, metadata mapping and cursor behavior to the published package.
- Leave route authentication, database composition, React components and styling in the operator app.

## Notes

- No SQL duplication, database pools, transcript reads or execution ownership here.
- Existing GraphExecutor and Temporal wiring remain unchanged.
