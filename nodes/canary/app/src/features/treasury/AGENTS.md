# treasury · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekbar90
- **Status:** stable

## Purpose

Client-side treasury balance display feature. Fetches DAO treasury USDC balance from public API and renders in header badge.

## Pointers

- [TreasuryBadge.tsx](components/TreasuryBadge.tsx): Header badge component
- [useTreasurySnapshot.ts](hooks/useTreasurySnapshot.ts): React Query hook
- [docs/spec/onchain-readers.md](../../../../../docs/spec/onchain-readers.md): Treasury snapshot architecture

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["contracts", "shared"],
  "must_not_import": ["app", "adapters", "ports", "core", "bootstrap", "mcp"]
}
```

## Public Surface

- **Exports:**
  - `TreasuryBadge` (React component)
  - `useTreasurySnapshot` (React Query hook)
  - `UseTreasurySnapshotResult` (TypeScript interface)
- **Routes:** none (consumes `/api/v1/public/treasury/snapshot`)
- **Files considered API:** `components/TreasuryBadge.tsx`, `hooks/useTreasurySnapshot.ts`

## Ports

- **Uses ports:** none (calls public HTTP API directly)
- **Implements ports:** none
- **Contracts:** none

## Responsibilities

- This directory **does**: Fetch treasury snapshot from public API; display USDC balance in header; link to block explorer
- This directory **does not**: Perform RPC calls; handle authentication; poll for updates; support multiple tokens

## Usage

```bash
# Run tests
pnpm test tests/unit/features/treasury/
```

## Standards

- Client-side only (`"use client"` directive required)
- No polling (React Query `staleTime` only, no `refetchInterval`)
- Public data (no auth required)
- USDC only (6 decimals)

## Dependencies

- **Internal:** `@/contracts/treasury.snapshot.v1.contract`, `@/shared/web3` (block explorer utils)
- **External:** `@tanstack/react-query`, `next/link`

## Change Protocol

- Update this file when exports or API consumption changes
- Bump **Last reviewed** date
- Update tests in `tests/unit/features/treasury/` if behavior changes

## Notes

- Phase 2: USDC balance only; multi-token support deferred
- No client-side polling to minimize RPC load
- Graceful degradation: shows "$ --" on loading/error
