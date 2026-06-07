# authorization-core · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Shared authorization port, OpenFGA adapter, resource helpers, and deterministic test fake for node-template-based Cogni nodes. This package is the RBAC spine consumed by operator, node-template, and future node-template forks.

## Pointers

- [RBAC](../../docs/spec/rbac.md)
- [Access Control Charter](../../docs/spec/access-control-charter.md)
- [Packages Architecture](../../docs/spec/packages-architecture.md)

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

## Public Surface

- `AuthorizationPort`
- `AuthzCheckParams`, `AuthzDecision`, `AuthzAction`, `AuthzContext`
- `AuthzRelationTuple`, `AuthzWriteDecision`
- `authzToolResource`, `authzConnectionResource`, `authzGraphResource`, `authzUserResource`
- `relationForAuthzAction`
- `OpenFgaAuthorizationAdapter`
- `FakeAuthorizationAdapter`

## Responsibilities

- This directory **does**: define shared authz contracts; map Cogni actions to OpenFGA relations; implement OpenFGA checks and tuple writes through the official SDK; provide deterministic tests fakes.
- This directory **does not**: read env vars; own OpenFGA deployment; define local role tables; import node app code.

## Usage

```bash
pnpm --filter @cogni/authorization-core typecheck
pnpm --filter @cogni/authorization-core build
vitest run --config packages/authorization-core/vitest.config.ts
```

## Notes

- Runtime node composition roots decide whether to instantiate the OpenFGA adapter from env.
