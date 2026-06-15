# setup · AGENTS.md

> Scope: this directory only. Keep ≤150 lines.

## Metadata

- **Owners:** @cogni-dao/core
- **Status:** stable

## Purpose

Legacy setup pages. Protected route group requiring wallet connection.

## Pointers

- [Node Formation Spec](../../../../../../docs/spec/node-formation.md): P0 MVP design
- [Chain Action Flow UI](../../../../../../docs/spec/chain-action-flow-ui.md): vNext reusable UI components

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["features", "components", "shared", "types", "contracts"],
  "must_not_import": ["core", "ports", "adapters", "bootstrap"]
}
```

## Public Surface

- **Routes:**
  - `/setup/dao` [GET] - legacy redirect to `/nodes`
  - `/setup/dao/payments` [GET] - legacy redirect to `/nodes/payments`
- **Exports:** none (page components only)

## Responsibilities

- This directory **does**: Redirect legacy setup URLs to canonical node routes
- This directory **does not**: Contain transaction logic, state machines, or API calls

## Usage

```bash
# Access page (requires running dev server + wallet connection)
open http://localhost:3000/setup/dao
```

## Standards

- All pages delegate to `.client.tsx` for client-side interactivity
- Follow Credits page pattern (PageContainer + SectionCard + feature hook)
- Use existing kit components; no feature-specific UI primitives here

## Dependencies

- **Internal:** `@/features/setup`, `@/components`, `@/shared/web3`
- **External:** wagmi, viem, lucide-react

## Change Protocol

- Update when adding new `/setup/*` routes
- Bump **Last reviewed** date
- Keep route list in sync with filesystem

## Notes

- Protected route group - requires wallet connection via `(app)` layout
- All pages delegate to `.client.tsx` for client-side logic
