# mcp · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** draft

## Purpose

MCP host entrypoint. Registers tools that mirror src/contracts/\*\* operations and delegates to feature use-cases. Shared guard enforces auth, rate limits, and idempotency.

## Pointers

- [Root AGENTS.md](../../../../AGENTS.md)
- [Architecture](../../../../docs/spec/architecture.md)
- [Related ADRs](../../../../docs/decisions/adr/)

## Boundaries

```json
{
  "layer": "mcp",
  "may_import": ["mcp", "features", "ports", "contracts", "bootstrap"],
  "must_not_import": ["app", "core"]
}
```

## Public Surface

- **Exports:** server.ts (bootstrap for MCP), minimal helpers
- **CLI (if any):** pnpm mcp:serve (future)
- **Env/Config keys:** none now
- **Files considered API:** server.ts

## Ports (optional)

- **Uses ports:** Telemetry, RateLimiter, Clock, Rng, repos via container
- **Implements ports:** none
- **Contracts:** must validate against src/contracts/\*\*

## Responsibilities

- This directory **does**: register tools 1:1 with contracts; run guard; call feature use-cases; emit telemetry.
- This directory **does not**: implement domain rules or persistence; render UI.

## Usage

```bash
pnpm -w typecheck
# Future:
# pnpm mcp:serve
```

## Standards

- Tool names must equal contract id.
- Input/output validation must use the contract's Zod.
- Guard precedes execution; failures are audited.

## Dependencies

- **Internal:** contracts/, bootstrap/container, features/ services, shared/, ports/
- **External:** MCP TypeScript SDK (when adopted)

## Change Protocol

- Update this file when **Exports** change.
- If registration shape changes, bump affected contract versions and update ADR.

## Notes

- Future: server may be generated from src/contracts/\*\*. Keep hand-written code minimal until then.
