# http · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** draft

## Purpose

HTTP-specific contract layer using ts-rest. Generates OpenAPI specs and HTTP routers from protocol-neutral contracts.

## Pointers

- [Contracts AGENTS.md](../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)
- [ts-rest Documentation](https://ts-rest.com/)

## Boundaries

```json
{
  "layer": "contracts",
  "may_import": ["shared", "types"],
  "must_not_import": [
    "app",
    "features",
    "adapters/server",
    "adapters/worker",
    "core",
    "ports"
  ]
}
```

## Public Surface

- **Exports:** ApiContractV1 (ts-rest router), OpenAPIV1 (OpenAPI spec)
- **Routes (if any):** none (defines route contracts)
- **Files considered API:** router.v1.ts, openapi.v1.ts

## Responsibilities

- This directory **does**: map protocol-neutral contracts to HTTP; generate OpenAPI specs; define ts-rest routers
- This directory **does not**: contain business logic, implementation details, or protocol-neutral contracts

## Usage

```bash
pnpm typecheck  # validate ts-rest contracts
pnpm build      # generate types
```

## Standards

- Uses ts-rest for type-safe HTTP contract definitions
- Generates OpenAPI v3 specifications automatically
- Maps to protocol-neutral contract operations

## Dependencies

- **Internal:** parent contracts directory (protocol-neutral operations)
- **External:** @ts-rest/core, @ts-rest/open-api

## Change Protocol

- Update this file when **Exports** change
- Bump **Last reviewed** date
- Ensure OpenAPI generation succeeds

## Notes

- Bridges protocol-neutral contracts to HTTP transport
- Enables future MCP and other protocol adapters
