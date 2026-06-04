# config · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Server-only thin wrapper over `@cogni/repo-spec`. Handles file I/O, caching, and CHAIN_ID validation. All schema logic and typed extraction lives in the `@cogni/repo-spec` package; this directory re-exports types and provides cached server-only accessors. These settings must not rely on environment variables.

## Pointers

- [Root AGENTS.md](../../AGENTS.md)
- [.cogni/repo-spec.yaml](../../../../../.cogni/repo-spec.yaml)

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

- **Exports:** `getNodeId()`, `getScopeId()`, `getPaymentConfig()`, `InboundPaymentConfig`, `getGovernanceConfig()`, `GovernanceConfig`, `GovernanceSchedule`, `getLedgerApprovers()` - server-only helpers reading repo-spec metadata
- **Exports (schema):** Re-exported from `@cogni/repo-spec`: `repoSpecSchema`, `creditsTopupSpecSchema`, `governanceScheduleSchema`, `governanceSpecSchema`, `activityLedgerSpecSchema`, `poolConfigSpecSchema`
- **Exports (types):** Re-exported from `@cogni/repo-spec`: `LedgerPoolConfig`, `LedgerConfig`, `GovernanceSchedule`, `InboundPaymentConfig`, `GovernanceConfig`
- **Routes/CLI:** none
- **Env/Config keys:** none (reads versioned files only)
- **Files considered API:** index.ts, repoSpec.server.ts, repoSpec.schema.ts

## Responsibilities

- This directory **does**: read `.cogni/repo-spec.yaml` from disk, cache parsed results, pass CHAIN_ID to `@cogni/repo-spec` accessors, and re-export schemas/types for app consumers.
- This directory **does not**: define schemas, validate YAML structure, access browser APIs, or expose env overrides. Schema logic lives in `@cogni/repo-spec`.

## Usage

- Server components/helpers: `import { getNodeId, getPaymentConfig, getGovernanceConfig } from "@/shared/config";`
- Client components: `import type { InboundPaymentConfig } from "@/shared/config";` (props only, no direct file access)

## Standards

- Helpers must read repo-spec from disk on the server only and cache parsed results.
- Schema-first validation: All repo-spec structures validated via Zod schemas at runtime; types derived from schemas.
- No env-based overrides for governance-managed addresses or chain configuration.
- Export through `index.ts` entry point only.

## Dependencies

- **Internal:** `@cogni/repo-spec` (schema, parse, accessors), `@/shared/web3` (chain constants)
- **External:** Node fs/path

## Change Protocol

- Update this file when adding/removing helpers or expanding public surface.
- Keep helpers server-only and cache parsed data to avoid repeated IO.
- Bump **Last reviewed** when materially changed.

## Notes

- Repo-spec changes require an image rebuild + deploy to take effect (baked at build time).
- Chain alignment: `cogni_dao.chain_id` must match `CHAIN_ID` from `@/shared/web3/chain` or startup fails.
- Schema and type definitions live in `@cogni/repo-spec`; this directory re-exports for stable `@/shared/config` import paths.
