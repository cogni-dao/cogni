# attribution-pipeline-plugins · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Built-in enricher and allocator plugin implementations for the attribution pipeline. Contains plugin descriptors, adapters, profiles, and registry construction. This package churns — new plugins, new profiles, and new adapters land here. The stable contracts it implements live in `@cogni/attribution-pipeline-contracts`.

## Pointers

- [Plugin Attribution Pipeline Spec](https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline)
- [Packages Architecture](https://node-template.cognidao.org/knowledge/package-isolation-rules)
- [Contracts Package](../attribution-pipeline-contracts/AGENTS.md)

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

**External deps:** `zod` plus workspace packages.

## Public Surface

- **Exports:**
  - `ECHO_EVALUATION_REF`, `ECHO_ALGO_REF`, `ECHO_SCHEMA_REF` — echo plugin constants
  - `EchoPayloadSchema` — runtime Zod schema for echo payloadJson
  - `buildEchoPayload()` — pure function to build echo evaluation payload
  - `createEchoAdapter()` — factory returning `EnricherAdapter` for echo enricher
  - `WeightSumOutputSchema` — runtime Zod schema for allocator output
  - `WEIGHT_SUM_ALLOCATOR` — `AllocatorDescriptor` wrapping `computeReceiptWeights()`
  - `COGNI_V0_PROFILE` — built-in `PipelineProfile` for weekly activity attribution
  - `createDefaultRegistries()` — constructs default `{profiles, enrichers, allocators}` registries

## Ports

- **Uses ports:** none
- **Implements ports:** `EnricherAdapter` (from `@cogni/attribution-pipeline-contracts`)
- **Defines ports:** none

## Responsibilities

- This directory **does**: Implement built-in enricher adapters, allocator descriptors, pipeline profiles, and registry construction
- This directory **does not**: Define framework contracts (those live in `@cogni/attribution-pipeline-contracts`), perform direct I/O (adapters receive stores via context), modify `@cogni/attribution-ledger`, or contain executor logic (that stays in `services/scheduler-worker`)

## Usage

```bash
pnpm --filter @cogni/attribution-pipeline-plugins typecheck
pnpm --filter @cogni/attribution-pipeline-plugins build
```

## Standards

- Plugin adapters implement `EnricherAdapter` from framework package
- Descriptors are pure data — constants and pure functions only (ENRICHER_DESCRIPTOR_PURE)
- Profiles are plain readonly data (PROFILE_IS_DATA)
- All evaluation writes validated via framework (EVALUATION_WRITE_VALIDATED)
- Dependency direction: `attribution-pipeline-plugins → attribution-pipeline-contracts → attribution-ledger`
- Never import from `services/` or `src/` (PURE_LIBRARY)

## Dependencies

- **Internal:** `@cogni/attribution-pipeline-contracts` (framework contracts), `@cogni/attribution-ledger` (domain types, allocation algorithms, claimant-shares logic)
- **External:** `zod`

## Change Protocol

- Update this file when public exports change
- Coordinate with https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline spec invariants
- New plugins: add descriptor + adapter + tests; update registry and barrel

## Notes

- Dependency direction: `attribution-pipeline-plugins → attribution-pipeline-contracts → attribution-ledger`
- This package is where churn happens — new enrichers, new allocators, new profiles (FRAMEWORK_STABLE_PLUGINS_CHURN)
- Never imported by `@cogni/attribution-pipeline-contracts` or `@cogni/attribution-ledger` (PLUGIN_NO_LEDGER_CORE_LEAK)
