# features · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Vertical slices containing use cases like accounts/, ai/, and home/. Orchestrates core domain via ports.

## Pointers

- [Root AGENTS.md](../../../../AGENTS.md)
- [Architecture](../../../../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "features",
  "may_import": [
    "features",
    "ports",
    "core",
    "shared",
    "types",
    "components",
    "contracts"
  ],
  "must_not_import": [
    "app",
    "adapters/server",
    "adapters/worker",
    "bootstrap",
    "styles"
  ]
}
```

**Import Rules:** See [Architecture Enforcement Rules](../../../../docs/spec/architecture.md#enforcement-rules) for canonical entry points (@/core, @/ports, etc.) and type-only requirements.

## Public Surface

- **Exports:** accounts/services (admin ops), ai/services (completion), home/components (landing page), ingestion/services (webhook receiver), site-meta/services (route manifest)
- **Routes (if any):** Feature-specific routes via app/
- **Env/Config keys:** Feature-specific environment variables
- **Files considered API:** actions.ts, index.ts, public components

## Ports (optional)

- **Uses ports:** Depends on feature requirements
- **Implements ports:** none
- **Contracts (required if implementing):** none

## Responsibilities

- This directory **does**: Implement use cases, orchestrate domain logic, provide feature boundaries
- This directory **does not**: Import other features, access adapters directly, contain UI routing

## Usage

Minimal local commands:

```bash
pnpm test tests/unit/features/
pnpm typecheck
```

## Standards

- Each feature isolated with own actions/, services/, components/, hooks/, types/, constants/
- Features import components via kit/barrel only; vendor and styles are blocked by ESLint
- Unit tests with mocked ports required

## Dependencies

- **Internal:** ports/, core/, shared/
- **External:** React, Next.js client-side libraries

## Change Protocol

- Update this file when **Exports**, **Routes**, or **Env/Config** change
- Bump **Last reviewed** date
- Update ESLint boundary rules if **Boundaries** changed
- Ensure boundary lint + (if Ports) **contract tests** pass

## Notes

- Features must not cross-import each other (enforced by ESLint no-restricted-imports rule)
