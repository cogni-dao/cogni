# \_facades · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Thin app-layer wrappers that resolve dependencies, bind request context, map DTOs, wrap telemetry, and normalize errors. Facades never contain business logic.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": [
    "app",
    "features",
    "bootstrap",
    "contracts",
    "shared",
    "types"
  ],
  "must_not_import": ["adapters/server", "adapters/worker", "core"]
}
```

## Public Surface

- **Exports:** Feature facade functions for use-case coordination
- **Files considered API:** \*_/_.server.ts

## Ports (optional)

- **Uses ports:** Via bootstrap dependency resolution
- **Implements ports:** none
- **Contracts:** none

## Responsibilities

- This directory **does**: Validate input with contracts, resolve dependencies, map DTOs, add tracing/usage tracking
- This directory **does not**: Contain business logic, persistence, provider calls, or domain rules

## Usage

```bash
pnpm test tests/unit/app/_facades/
pnpm typecheck
```

## Standards

- File naming: `<feature>/<usecase>.server.ts` (Node-only code)
- Create when ≥2 endpoints share wiring; otherwise compose inline in routes
- Unit tests with mocked containers required

## Dependencies

- **Internal:** features/**/services/**, bootstrap/container, contracts, shared
- **External:** None (composition only)

## Change Protocol

- Update this file when **Exports** or boundaries change
- Bump **Last reviewed** date
- Ensure ESLint app-layer rules pass

## Notes

- Underscore prefix signals internal app code (not routes)
- Facades provide streaming variants when needed
