# db · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Database schema definitions (barrel) and URL construction utility (direct import only).

- **Barrel (`@/shared/db`)**: Schema tables for runtime adapters
- **Direct (`@/shared/db/db-url`)**: `buildDatabaseUrl` for tooling only (drizzle.config.ts, test scripts)

Per DATABASE_RLS_SPEC.md design decision 7: runtime app uses explicit DSNs, no URL construction.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Database Architecture](../../../../../docs/spec/databases.md)

## Boundaries

```json
{
  "layer": "shared",
  "may_import": ["shared"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters/server",
    "adapters/worker",
    "adapters/cli",
    "mcp"
  ]
}
```

## Public Surface

**Exports (barrel `@/shared/db`):**

- Schema tables from `@cogni/db-schema` (users, billingAccounts, schedules, etc.)

**Direct imports (not in barrel):**

- `db-url.ts`: `buildDatabaseUrl`, `DbEnvInput` — tooling only

**Files considered API:** index.ts (barrel), db-url.ts (tooling)
**Routes/CLI:** none
**Env/Config keys:** none

## Responsibilities

- This directory **does**: provide schema definitions (barrel), URL construction (direct import for tooling)
- This directory **does not**: handle connections, migrations, or runtime database operations

## Usage

```typescript
// Runtime adapters — schema from barrel
import { users, billingAccounts } from "@/shared/db";

// Tooling scripts only — direct import (NOT in barrel)
import { buildDatabaseUrl } from "@/shared/db/db-url";
```

## Standards

- No framework dependencies (Next.js, Zod prohibited in db-url.ts)
- Pure functions only for URL construction
- Drizzle schema follows project conventions

## Dependencies

- **Internal:** none
- **External:** none (db-url.ts), drizzle-orm (schema.ts)

## Change Protocol

- Update this file when **Exports** change
- Bump **Last reviewed** date
- Update imports in drizzle.config.ts and test tooling if buildDatabaseUrl signature changes
- Note: server.ts no longer imports buildDatabaseUrl (explicit DSNs only per DATABASE_RLS_SPEC.md)
- Ensure pnpm lint && pnpm typecheck pass

## Notes

- `buildDatabaseUrl` excluded from barrel to prevent runtime DSN construction
- Tooling scripts (drizzle.config.ts, reset-db.ts, drop-test-db.ts) import directly from `db-url.ts`
