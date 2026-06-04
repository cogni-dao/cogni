# app/\_lib · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Private app-layer helpers for route handlers. Provides server-side utilities like caching, session resolution, and shared route logic.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [App Layer](../AGENTS.md)
- [Model Selection](../../../../../docs/spec/model-selection.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["shared", "contracts", "features", "ports"],
  "must_not_import": ["adapters", "core"]
}
```

## Public Surface

- **Exports:** models-cache (getCachedModels, isModelAllowed, getDefaultModelId), auth/session helpers, request-identity resolver + agent key issuer
- **Files considered API:** models-cache.ts, auth/session.ts, auth/request-identity.ts

## Responsibilities

- This directory **does**: provide server-side caching, session helpers, route utilities
- This directory **does not**: implement business logic, expose HTTP endpoints, contain UI components

## Usage

Minimal local commands:

```bash
pnpm typecheck
```

## Standards

- Private to app layer - not imported by features or other layers
- No business logic - delegate to features/services
- Server-only code (uses serverEnv, logging)

## Dependencies

- **Internal:** @/shared, @/contracts, @/features
- **External:** none (uses Node fetch)

## Change Protocol

- Update this file when **Exports** change
- Bump **Last reviewed** date

## Notes

- models-cache.ts: Fetches from LiteLLM /model/info, 1h cache with SWR
- auth/session.ts: Session resolution helpers for route handlers
