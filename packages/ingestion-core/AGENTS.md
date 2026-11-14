# ingestion-core · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Pure domain types, port interface, and helpers for activity ingestion source adapters. Purpose-neutral — shared across ledger (→ curation → allocations) and governance (→ metrics, alerts, digests) consumers. No adapter deps, no I/O.

## Pointers

- [Attribution Ledger Spec](https://node-template.cognidao.org/knowledge/attribution-epoch-ledger)
- [Packages Architecture](https://node-template.cognidao.org/knowledge/package-isolation-rules)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

**External deps:** none (pure TypeScript, Web Crypto only).

## Public Surface

- **Exports:**
  - `DataSourceRegistration` — Capability manifest binding optional `PollAdapter` + `WebhookNormalizer` per source
  - `PollAdapter` — Port for Temporal activity-based cursor sync (replaces direct SourceAdapter usage)
  - `WebhookNormalizer` — Port for HTTP webhook verify + normalize to `ActivityEvent[]`
  - `SourceAdapter` — Deprecated type alias for backward compatibility
  - `ActivityEvent` — Purpose-neutral raw activity event (no epoch/user/node fields)
  - `StreamDefinition`, `StreamCursor`, `CollectParams`, `CollectResult` — Adapter I/O types
  - `buildEventId()` — Deterministic event ID construction
  - `canonicalJson()` — Sorted-key JSON for deterministic serialization
  - `hashCanonicalPayload()` — SHA-256 via Web Crypto

## Ports

- **Uses ports:** none
- **Implements ports:** none (defines DataSourceRegistration, PollAdapter, WebhookNormalizer ports — implementations in services/scheduler-worker and src/adapters/server)

## Responsibilities

- This directory **does**: Define adapter port interface, activity event types, deterministic ID + hashing helpers
- This directory **does not**: Perform I/O, import adapter deps (octokit, discord.js), access databases, import from `src/` or `services/`

## Usage

```bash
pnpm --filter @cogni/ingestion-core typecheck
pnpm --filter @cogni/ingestion-core build
```

## Standards

- Pure functions and types only — no I/O, no framework deps
- ACTIVITY_IDEMPOTENT: Deterministic event IDs from source data
- PROVENANCE_REQUIRED: payloadHash (SHA-256) on every event
- ActivityEvent is purpose-neutral: no epoch, receipt, payout, or node fields

## Dependencies

- **Internal:** none (standalone package)
- **External:** none (Web Crypto is a platform built-in)

## Change Protocol

- Update this file when public exports change
- Coordinate with https://node-template.cognidao.org/knowledge/attribution-epoch-ledger spec invariants
- Adapter implementations in services/scheduler-worker must match port interface

## Notes

- `src/ports/source-adapter.port.ts` re-exports from this package for app-layer consumers
- Per PACKAGES_NO_SRC_IMPORTS: This package cannot import from `src/**`
- Per ADAPTERS_NOT_IN_CORE: Only types + pure helpers here; poll adapters in services/scheduler-worker, webhook normalizers in services/scheduler-worker + src/adapters/server
