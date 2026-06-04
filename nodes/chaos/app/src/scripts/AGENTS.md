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

Note: This directory currently has no governance sync entrypoint file; sync is triggered via internal HTTP endpoint.

## Public Surface

- **Exports:** none (entry points only)
- **CLI (if any):** `pnpm governance:schedules:sync` (curl to internal ops endpoint)

## Responsibilities

- This directory **does**: Host script-facing conventions
- This directory **does not**: Contain governance schedule sync runtime logic

## Usage

```bash
pnpm governance:schedules:sync
```

## Standards

- `governance:schedules:sync` triggers `/api/internal/ops/governance/schedules/sync`

## Dependencies

- **Internal:** `@/bootstrap/jobs`
- **External:** none

## Change Protocol

- Update this file when adding new script entry points
- Bump **Last reviewed** date

## Notes

- Scripts run via `tsx` (plain Node, no Next.js) — `server-only` guard is bypassed by design
