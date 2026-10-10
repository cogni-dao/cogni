# authorization-core · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Shared authorization port, resource helpers, deterministic test fake, and trusted-operator OpenFGA adapter for node-template-based Cogni nodes.

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
- `FakeAuthorizationAdapter`
- `@cogni/authorization-core/operator`: `OpenFgaAuthorizationAdapter` (trusted control plane only)

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

- Independently governed nodes must never import `@cogni/authorization-core/operator` or receive raw shared OpenFGA configuration. They consume the mediated `RemoteAuthorizationAdapter` delivered by `task.5226`.
- Only the trusted operator composition root may instantiate the raw `OpenFgaAuthorizationAdapter`.
