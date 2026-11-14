# src · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft
- **Last reviewed:** 2026-08-05 (fleet-reprovision: force operator image rebuild on current main so prod can promote off a SHA that carries the current AppSet layer — the June-24 image predated it)

## Purpose

Next.js application source implementing hexagonal architecture for a fully web3-enclosed, crypto-funded AI application. Contains all layers from delivery to domain.

## Pointers

- [Root AGENTS.md](../../../AGENTS.md)
- [Architecture](https://node-template.cognidao.org/knowledge/hexagonal-layering-contract)
- [Authentication overview](https://node-template.cognidao.org/knowledge/authentication-session-bearer)
- [Accounts design (billing + identity)](https://node-template.cognidao.org/knowledge/billing-account-tenancy)
- [Operator identity model](https://cognidao.org/knowledge/operator-identity-model)
- [Database architecture](https://node-template.cognidao.org/knowledge/database-migration-contract)
- [Environment modes](../../../docs/spec/environments.md)
- [DB schema](./shared/db/schema.ts) - Users, billing accounts, ledger, virtual keys
- [Auth implementation](auth.ts) - NextAuth.js with SIWE provider

## Boundaries

```json
{
  "layer": "meta",
  "may_import": ["*"],
  "must_not_import": []
}
```

## Public Surface

- **Exports:** Next.js application
- **Routes (if any):** All app routes via app/
- **Env/Config keys:** Via shared/env/ schemas
- **Files considered API:** app/ routes, features/ exports, components/ exports

## Ports (optional)

- **Uses ports:** All ports defined in ports/
- **Implements ports:** Via adapters/
- **Contracts (required if implementing):** tests/contract/ coverage

## Responsibilities

- This directory **does**: Implement hexagonal architecture, provide delivery layer, domain logic, infrastructure
- This directory **does not**: Contain build tools, deployment config, external test utilities

## Usage

Minimal local commands:

```bash
pnpm dev
pnpm build
pnpm typecheck
```

## Standards

- Hexagonal architecture: app → features → ports → core, adapters → ports → core
- Strict layer boundaries enforced via ESLint
- All subdirs have AGENTS.md files

## Dependencies

- **Internal:** Hexagonal layer structure: app/, bootstrap/, features/, ports/, core/, adapters/, shared/
- **External:** Next.js, React, TypeScript, web3 stack, AI stack

## Change Protocol

- Update this file when **Exports** or major structure changes
- Bump **Last reviewed** date
- Update ESLint boundary rules if **Boundaries** changed
- Each subdir maintains its own AGENTS.md

## Notes

- Every subdirectory has detailed AGENTS.md with specific layer rules
- Dependencies flow inward per hexagonal architecture principles
- **Authentication**: SIWE-based wallet auth with `users.wallet_address` UNIQUE constraint (1 wallet = 1 user MVP, see ACCOUNTS_DESIGN.md for multi-wallet migration plan)
