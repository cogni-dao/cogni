# operator-gateway-activation · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft
- **Last reviewed:** 2026-11-04

## Purpose

Pure operator-owned gateway activation intent, host port and recovery policy.
The operator API and infrastructure runner consume the same contract.

## Pointers

- [Owning bug](https://cognidao.org/work/items/bug.5570)
- [Package architecture](../../../../docs/spec/packages-architecture.md)

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

- No app, service, environment, filesystem or credential imports.
- Inject every host effect through GatewayHostPort.
- Preserve immutable intent and observe ambiguous effects before resuming.

## Public Surface

- Package: @cogni/operator-gateway-activation
- Exports: value-free intent/observation schemas and activateGateway.
- Request/status schemas include strict provider target, UUID, environment and historical evidence.
- No listeners, process lifecycle, secret values or runtime configuration.

## Verification

Use the focused tests in tests/unit/gateway-activation.test.ts at the repository root.
The owning bug.5570 requires independent review and live candidate/preview/production proof.

## Responsibilities

- Own sealed contracts and recoverable state selection.
- Delegate host I/O and authority checks to the runtime adapters.

## Notes

The node owns this package. It is private and is not a sovereign-node release.
