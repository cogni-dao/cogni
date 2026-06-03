# internship-subsidy · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Prototype intern AI subscription subsidy planning. Composes a rail-neutral program model with OSS distribution rail adapters such as Allo and Sablier Flow.

## Pointers

- [Architecture](../../../../../../docs/spec/architecture.md)
- [Ports](../../ports/AGENTS.md)
- [Adapters](../../adapters/AGENTS.md)

## Boundaries

```json
{
  "layer": "features",
  "may_import": [
    "features",
    "ports",
    "core",
    "shared",
    "components",
    "contracts"
  ],
  "must_not_import": [
    "app",
    "adapters/server",
    "adapters/worker",
    "bootstrap",
    "styles"
  ]
}
```

## Public Surface

- **Exports (services):** `buildSubsidyPrototype()`
- **Exports (components):** `InternshipSubsidyPrototype`
- **Routes (app pages):** `/internship/subsidy`
- **Routes (API):** `GET /api/v1/public/internship-subsidy/prototype`
- **Env/Config keys:** none

## Responsibilities

- This directory **does**: Build public prototype DTOs; render public prototype UI; keep Allo/Sablier behind the rail port.
- This directory **does not**: Sign transactions, call chain RPCs, persist applicants, or implement smart contracts.

## Usage

```bash
pnpm test tests/unit/features/internship-subsidy/
```

## Notes

- Prototype only. Production settlement belongs in Financial Ledger / Operator Port work.
