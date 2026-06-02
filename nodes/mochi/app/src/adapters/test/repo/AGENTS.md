# test/repo · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Deterministic fake RepoCapability for testing. Returns fixed results without spawning subprocesses.

## Pointers

- [COGNI_BRAIN_SPEC](../../../../../../docs/spec/cogni-brain.md)
- [RepoCapability interface](../../../../../../packages/ai-tools/src/capabilities/repo.ts)

## Boundaries

```json
{
  "layer": "adapters/test",
  "may_import": ["ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** `FakeRepoAdapter`
- **Files considered API:** `fake-repo.adapter.ts`

## Responsibilities

- This directory **does**: Provide deterministic mock RepoCapability for tests
- This directory **does not**: Spawn subprocesses, access filesystem, contain production logic

## Usage

Wired automatically when `APP_ENV=test` via bootstrap container.

## Standards

- Deterministic responses, no IO
- Exposes call count accessors for test assertions

## Dependencies

- **Internal:** `@cogni/ai-tools` (RepoCapability interface)
- **External:** none

## Change Protocol

- Update this file when exports change

## Notes

- Uses fixed SHA `abc1234` for deterministic test assertions
