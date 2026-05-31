# lib/auth · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Server-side authentication helpers: session retrieval and billing account mapping. Bridges NextAuth session identity to billing account resolution.

## Pointers

- [Authentication](../../../../../docs/spec/authentication.md): Auth architecture
- [AccountService port](../../ports/accounts.port.ts)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["ports", "shared"],
  "must_not_import": ["adapters", "core", "features"]
}
```

## Public Surface

- **Exports:**
  - `getServerSessionUser()` — server-side session retrieval (NextAuth wrapper)
  - `getOrCreateBillingAccountForUser()` — maps session user to billing account via AccountService
- **Files considered API:** `server.ts`, `mapping.ts`

## Ports

- **Uses ports:** `AccountService` (via dependency injection)
- **Implements ports:** none

## Responsibilities

- This directory **does**: Provide session retrieval and billing account mapping helpers
- This directory **does not**: Contain business logic, framework routing, or adapter implementations

## Usage

```bash
pnpm test tests/unit/
```

## Standards

- `getServerSessionUser()` returns null unless both id AND walletAddress are present
- `getOrCreateBillingAccountForUser()` accepts injected AccountService (no direct adapter import)

## Dependencies

- **Internal:** `@/ports`, `@/shared/auth`, `@/auth`
- **External:** `next-auth`

## Change Protocol

- Update this file when **Exports** change
- Bump **Last reviewed** date

## Notes

- `mapping.ts` is a thin orchestration layer — keeps mapping logic out of adapters and routes
