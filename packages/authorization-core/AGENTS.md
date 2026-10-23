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

- `AuthorizationCheckPort`, `AuthorizationRelationAdminPort`, `AuthorizationPort`
- `BillingAccountOwnerBootstrapPort`, `AgentAccountAccessAdministrationPort`, `BillingAccountAuthorizationPort`, semantic human→agent billing-account grant types
- `AuthzCheckParams`, `AuthzDecision`, `AuthzAction`, `AuthzContext`
- `AuthzRelationTuple`, `AuthzWriteDecision`
- `authzToolResource`, `authzConnectionResource`, `authzGraphResource`, `authzUserResource`
- `relationForAuthzAction`
- `FakeAuthorizationAdapter`
- `@cogni/authorization-core/operator`: `OpenFgaAuthorizationAdapter` (trusted control plane only)

## Responsibilities

- This directory **does**: define shared authz contracts; map Cogni actions to OpenFGA relations; implement operator-only OpenFGA checks and tuple writes through the official SDK; provide deterministic tests fakes.
- This directory **does not**: read env vars; own OpenFGA deployment; define local role tables; import node app code.

## Usage

```bash
pnpm --filter @cogni/authorization-core typecheck
pnpm --filter @cogni/authorization-core build
vitest run --config packages/authorization-core/vitest.config.ts
```

## Notes

- Nodes never call the operator to authorize ([node-capability-grants-standard](https://cognidao.org/knowledge/node-capability-grants-standard)); the operator authorization facade (task.5226/task.5228) was rejected. Independently governed nodes must not import `@cogni/authorization-core/operator` or receive the operator's shared OpenFGA configuration.
- Only the trusted operator composition root may instantiate the raw `OpenFgaAuthorizationAdapter`.
