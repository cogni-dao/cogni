# tests/component/repo · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Component tests for RipgrepAdapter, GitLsFilesAdapter, and Brain repo capability wiring against real temp git repos. Validates path security, search bounds, SHA stamping, file retrieval, file listing, cross-tool path canonicalization, and tool invocation smoke tests.

## Pointers

- [RipgrepAdapter source](../../../src/adapters/server/repo/ripgrep.adapter.ts)
- [RepoCapability interface](../../../../../packages/ai-tools/src/capabilities/repo.ts)
- [COGNI_BRAIN_SPEC](../../../../../docs/spec/cogni-brain.md)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["adapters/server", "shared", "tests"],
  "must_not_import": ["core", "features", "app", "mcp"]
}
```

## Public Surface

- **Exports:** `createTempGitRepo()`, `cleanupTempGitRepo()`, `assertBinariesAvailable()`, `KNOWN_FILE`, `TempGitRepo` (from fixtures/temp-git-repo.ts — shared with brain tests)
- **CLI:** `pnpm test:component -- tests/component/repo`
- **Env/Config keys:** none (uses temp directories)
- **Files considered API:** `fixtures/temp-git-repo.ts` (shared fixture)

## Responsibilities

- This directory **does**: Test RipgrepAdapter and GitLsFilesAdapter against real git repos with real `rg` and `git` binaries
- This directory **does not**: Test DI container wiring, test citation guard

## Usage

```bash
pnpm test:component -- tests/component/repo
```

## Standards

- Requires system `rg` and `git` binaries (preflight via `assertBinariesAvailable()`)
- Temp repos created in os.tmpdir with `realpathSync` (macOS /tmp symlink safe)
- Cleanup always runs via afterAll guard (`if (repo) cleanupTempGitRepo(repo)`)
- Tests cover: path validation (traversal, symlink escape, absolute), size bounds, SHA stamping, search bounds, list with glob/limit, cross-tool path canonicalization

## Dependencies

- **Internal:** src/adapters/server/repo, @cogni/ai-tools (types)
- **External:** vitest, ripgrep binary, git

## Change Protocol

- Update this file when fixture exports or test coverage change
- Bump **Last reviewed** date

## Notes

- `repo-wiring-smoke.int.test.ts` (merged from brain/) tests end-to-end repo capability wiring
- CI installs ripgrep via `taiki-e/install-action` in the component job
