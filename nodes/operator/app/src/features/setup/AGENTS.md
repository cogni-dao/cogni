# setup · AGENTS.md

> Scope: this directory only. Keep ≤150 lines.

## Metadata

- **Owners:** @cogni-dao/core
- **Status:** stable

## Purpose

DAO formation feature slice. Pure state machines, transaction builders, server verification client, and React hooks for wallet-signed Aragon OSx DAO creation.

## Pointers

- [Node Formation Spec](https://cognidao.org/knowledge/node-formation-contract): P0 MVP design spec
- `packages/aragon-osx`: Pure OSx primitives (no IO)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["shared", "components", "types", "contracts"],
  "must_not_import": ["core", "ports", "adapters", "app", "bootstrap", "mcp"]
}
```

## Public Surface

- **Exports (via `public.ts`):**
  - `useDAOFormation` - Hook orchestrating formation flow
  - `FormationFlowDialog` - Progress dialog component
  - Types: `DAOFormationConfig`, `FormationState`, `VerifiedAddresses`
- **API Routes:** none (uses `/api/setup/verify`)
- **Files considered API:** `public.ts`, `hooks/useDAOFormation.ts`, `components/FormationFlowDialog.tsx`

## Ports

- **Uses ports:** none (uses `@aragon-osx` package + wagmi directly)
- **Implements ports:** none
- **Contracts:** none required

## Responsibilities

- This directory **does**:
  - Formation state machine (`daoFormation/formation.reducer.ts`)
  - Pure tx argument builders (`daoFormation/txBuilders.ts`)
  - Server verification client (`daoFormation/api.ts`)
  - Wagmi hook wiring (`hooks/useDAOFormation.ts`)
  - Formation dialog UI (`components/FormationFlowDialog.tsx`)
- This directory **does not**:
  - Contain OSx encoding logic (delegated to `@aragon-osx`)
  - Implement server verification (app/api layer)
  - Parse receipts (delegated to `@aragon-osx`)

## Usage

```bash
# Run tests
pnpm test src/features/setup

# Import in app
import { useDAOFormation } from "@/features/setup/public";
```

## Standards

- Pure functions in `daoFormation/` - no side effects
- Hooks in `hooks/` are thin wagmi wiring only
- Components mirror PaymentFlow pattern
- All OSx version constants live in `@aragon-osx`

## Dependencies

- **Internal:** `@cogni/aragon-osx`, `@cogni/cogni-contracts`, `@/shared/web3`, `@/shared/errors`, `@/components/kit`
- **External:** wagmi, viem, react

## Change Protocol

- Update `public.ts` when exports change
- Keep types in sync with `formation.reducer.ts`
- Bump **Last reviewed** date
- Ensure `pnpm check` passes

## Notes

- P0 MVP: wallet-signed formation only (no CLI, terraform, GitHub automation)
- Server verification at `/api/setup/verify` derives all addresses from receipts
- Uses `@aragon-osx` for pure OSx primitives (encoding, receipt parsing, version constants)
