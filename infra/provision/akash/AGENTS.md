# akash · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Future Akash Network deployment configurations for decentralized cloud infrastructure.

## Pointers

- [FUTURE_AKASH_INTEGRATION.md](https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/infra/provision/akash/FUTURE_AKASH_INTEGRATION.md): Integration planning document

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** none

## Responsibilities

- This directory **does**: Plan future Akash Network integration
- This directory **does not**: Contain functional deployment configurations

## Usage

Minimal local commands:

```bash
# Future implementation - no current commands
```

## Standards

- Follow Akash Network deployment specifications
- Integrate with existing Cherry Servers patterns
- Maintain crypto-only payment model

## Dependencies

- **Internal:** `../../files/` for shared scripts
- **External:** Akash Network, Akash CLI

## Change Protocol

- Update this file when **integration planning** progresses
- Bump **Last reviewed** date
- Coordinate with main provider patterns

## Notes

- Placeholder for future decentralized cloud deployment
- Will follow same base/app split pattern as Cherry Servers
