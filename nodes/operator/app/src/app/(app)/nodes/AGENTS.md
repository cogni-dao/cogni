# nodes · AGENTS.md

> Scope: this directory only. Keep ≤150 lines.

## Metadata

- **Owners:** @cogni-dao/core
- **Status:** stable

## Purpose

Authenticated node management and formation wizard routes. `/nodes` is the app-owned surface for registering, forming, publishing, and monitoring the user's nodes.

## Pointers

- [Node Formation Spec](../../../../../../docs/spec/node-formation.md)
- [Route Group Rules](../AGENTS.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["features", "components", "shared", "types", "contracts"],
  "must_not_import": ["core", "ports", "adapters"]
}
```

## Public Surface

- **Routes:**
  - `/nodes` [GET] - DB-backed node registration + formation wizard
  - `/nodes/[id]` [GET] - canonical per-node setup wizard
  - `/nodes/payments` [GET] - payment activation page
- **Exports:** none (page components only)

## Responsibilities

- This directory **does**: Render owner-scoped node management pages and delegate interactive actions to client islands.
- This directory **does not**: Expose public node discovery; public browsing belongs under `/explore/nodes`.

## Usage

```bash
open http://localhost:3000/nodes
```

## Standards

- Keep all user-facing node-management links under `/nodes`.
- Use `/explore/nodes` only for public discovery and transparency pages.
- API calls stay under `/api/v1/nodes`.

## Change Protocol

- Update this file when adding new `/nodes/*` app routes.
- Keep `src/proxy.ts` route protection aligned with this route tree.

## Notes

- Legacy `/setup/dao*` URLs redirect into this route family.
