# ci-invariants/native · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Extends the parent static-test contract only for the owned native acceptance tests here.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable
- **Last reviewed:** 2026-10-23

## Purpose

Native integration acceptance of declared infrastructure failure behavior in isolated CI-owned Docker containers. CI runs this directory in the dedicated native lane, selected by the exact trusted PR event-base policy and required by the terminal unit gate. Missing/incompatible policy and merge-group/main always run native proof. Ordinary local root Vitest discovery still includes this directory.

## Pointers

- [Root Vitest discovery](../../../vitest.config.mts)
- [CI native discovery](../../../scripts/vitest/vitest.native.config.mts)
- [Runtime declarations](../../../infra/compose/runtime/docker-compose.yml)
- [Parent static guidance](../AGENTS.md)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["*"],
  "must_not_import": []
}
```

## Public Surface

- **Exports:** `imageContentIdentity` — pure inspect API default-equivalence helper for the owned image bridge
- **Files considered API:** native `*.spec.ts` acceptance tests; no production entry points
- **CLI:** `pnpm exec vitest run --config scripts/vitest/vitest.native.config.mts`; ordinary root discovery remains full

## Responsibilities

- This directory **does:** exercise declared images and configuration against disposable dependencies; prove fault sensitivity with native controls and process-start evidence.
- This directory **does not:** contact deployed production, candidate, preview, or test-fleet endpoints; consume their credentials; dispatch workflows; or implement recovery lifecycle policy.

## Standards

- Docker faults may target only container IDs created by the current test. Networks and any autoheal selector must be unique to that test.
- Public image pulls for the declared infrastructure images are permitted. Service and database traffic stays within the owned fixture; credentials are generated solely for it.
- CI must execute these tests and fail when Docker or required native evidence is unavailable. A local skip must be explicit and never reported as passing runtime proof.
- Local Docker execution requires explicit heavy-command consent. The current repair is authored locally and exercised in CI.
- Derive images and health/restart policy from committed declarations; do not substitute parallel policy to manufacture a pass.
- Always clean up in `finally`: stop the fault actor, restore owned paused dependencies, then remove owned containers and networks. Attempt all cleanup steps even if one fails.
- Call results native integration evidence. Workflow success alone does not prove a deployed environment.

## Notes

This narrow native-integration exception applies only here; the parent static-test guidance continues to govern sibling directories.
