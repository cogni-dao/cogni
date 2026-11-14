# ids · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Branded ID types for compile-time RLS enforcement across the monorepo. Provides `UserId` and `ActorId` via `type-fest` `Tagged<>`, boundary constructors (`toUserId`, `userActor`), and the `SYSTEM_ACTOR` constant. Zero-dep leaf package (only `type-fest`).

## Pointers

- [Database RLS Spec](https://node-template.cognidao.org/knowledge/rls-tenant-isolation): RLS architecture and actor model
- [Packages Architecture](https://node-template.cognidao.org/knowledge/package-isolation-rules): Package conventions

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services",
    "packages"
  ]
}
```

**External deps:** `type-fest` (Tagged branded types).

## Public Surface

- **Exports (root `@cogni/ids`):**
  - `UserId` — `Tagged<string, "UserId">`, branded user identity for user-facing ports
  - `ActorId` — `Tagged<string, "ActorId">`, branded actor identity for worker-facing ports and `withTenantScope`
  - `toUserId(raw: string): UserId` — boundary constructor, validates UUID v4
  - `userActor(userId: UserId): ActorId` — convert UserId to ActorId without re-parsing
  - `UUID_RE: RegExp` — UUID v4 validation regex
- **Exports (sub-path `@cogni/ids/system`):**
  - `SYSTEM_ACTOR: ActorId` — deterministic UUID for system/worker operations (import-gated)
- **Files considered API:** `index.ts` (root), `system.ts` (sub-path)

## Ports

- **Uses ports:** none
- **Implements ports:** none

## Responsibilities

- This directory **does**: Define branded ID types and boundary constructors
- This directory **does not**: Perform I/O, depend on any other package, contain DB or framework code

## Usage

```bash
pnpm --filter @cogni/ids typecheck
pnpm --filter @cogni/ids build
```

## Standards

- Per `FORBIDDEN`: No I/O, no `@/`, no `src/`, no framework imports
- Per `ALLOWED`: Pure TypeScript types and validation only
- No `as UserId` / `as ActorId` casts outside test fixtures — enforced by PR review
- Only edge code (HTTP handlers, env parsing, test fixtures) should call `toUserId`/`userActor`

## Dependencies

- **Internal:** none (leaf package)
- **External:** `type-fest` (Tagged branded types)

## Change Protocol

- Update this file when ID types or constructors change
- Coordinate with DATABASE_RLS_SPEC.md
- Bump **Last reviewed** date

## Notes

- `SYSTEM_ACTOR` lives in `@cogni/ids/system` sub-path (not root) for import-boundary safety
- No `as UserId` / `as ActorId` casts outside test fixtures
