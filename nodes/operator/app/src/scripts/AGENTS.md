# scripts · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Operational command surface for script-based tasks.

## Pointers

- [Bootstrap Jobs AGENTS.md](../bootstrap/jobs/AGENTS.md)

## Boundaries

```json
{
  "layer": "scripts",
  "may_import": ["scripts", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core", "adapters", "contracts"]
}
```

Note: This directory has no governance sync entrypoint; the app reconciles schedules directly at boot.

## Public Surface

- **Exports:** none (entry points only)
- **CLI (if any):** none

## Responsibilities

- This directory **does**: Host script-facing conventions
- This directory **does not**: Contain governance schedule sync runtime logic

## Usage

There is no governance schedule sync CLI. Boot reconciliation invokes the job directly.

## Standards

- Do not reintroduce a standing-bearer HTTP trigger for governance schedule sync.

## Dependencies

- **Internal:** `@/bootstrap/jobs`
- **External:** none

## Change Protocol

- Update this file when adding new script entry points
- Bump **Last reviewed** date

## Notes

- Scripts run via `tsx` (plain Node, no Next.js) — `server-only` guard is bypassed by design
