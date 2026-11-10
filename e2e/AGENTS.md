# e2e · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

End-to-end Playwright tests for API routes and UI workflows.

## Pointers

- [Root AGENTS.md](../AGENTS.md)
- [Architecture](../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "e2e",
  "may_import": ["*"],
  "must_not_import": []
}
```

## Public Surface

- **Exports:** none
- **Routes (if any):** Tests all routes externally
- **CLI (if any):** pnpm e2e, pnpm e2e:smoke, pnpm e2e:prod, pnpm e2e:all, pnpm e2e:debug, pnpm e2e:report
- **Env/Config keys:** TEST_BASE_URL, PLAYWRIGHT_AUTH_STATE

## Responsibilities

- This directory **does**: Test end-to-end user workflows via browser automation
- This directory **does not**: Import internal code, contain production logic

## Usage

Minimal local commands:

```bash
pnpm e2e        # staging-full tests (ignores smoke/)
pnpm e2e:smoke  # smoke tests (smoke/ only)
pnpm e2e:prod   # alias for e2e:smoke
pnpm e2e:all    # both projects
```

## Standards

- Black-box testing only
- Directory-based test organization: tests/smoke/ (prod-safe), tests/full/ (staging-only)
- Environment-driven via TEST_BASE_URL

## Dependencies

- **Internal:** none
- **External:** playwright, browser automation

## Change Protocol

- Update this file when **Exports**, **Routes**, or **Env/Config** change
- Bump **Last reviewed** date
- Update ESLint boundary rules if **Boundaries** changed
- Ensure boundary lint + (if Ports) **contract tests** pass

## Notes

- Tests must not depend on internal implementation details
