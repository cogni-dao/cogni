# repo · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Repository access adapters implementing RepoCapability. RipgrepAdapter provides code search and file retrieval; GitLsFilesAdapter provides file listing and SHA resolution. Composed into a single RepoCapability by the bootstrap factory.

## Pointers

- [RepoCapability interface](../../../../../../packages/ai-tools/src/capabilities/repo.ts)
- [COGNI_BRAIN_SPEC](../../../../../../docs/spec/cogni-brain.md)
- [Tool Use Spec](../../../../../../docs/spec/tool-use.md)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** `RipgrepAdapter`, `RipgrepAdapterConfig`, `RepoPathError`, `GitLsFilesAdapter`, `GitLsFilesAdapterConfig`
- **Env/Config keys:** `COGNI_REPO_SHA` (optional SHA override, consumed by GitLsFilesAdapter)
- **Files considered API:** `ripgrep.adapter.ts`, `git-ls-files.adapter.ts`, `index.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** RepoCapability (from @cogni/ai-tools)

## Responsibilities

- This directory **does**: Implement RepoCapability via RipgrepAdapter (search, open) and GitLsFilesAdapter (list, getSha)
- This directory **does not**: Define tool contracts (owned by @cogni/ai-tools), compose adapters (owned by bootstrap), handle billing/telemetry

## Usage

Imported via server barrel (`@/adapters/server`) and composed by `createRepoCapability()` in `src/bootstrap/capabilities/repo.ts`. Consumed by `core__repo_search`, `core__repo_open`, and `core__repo_list` tool implementations. Not used directly — always accessed through `RepoCapability` interface.

```typescript
// Bootstrap composes both adapters:
const gitAdapter = new GitLsFilesAdapter({ repoRoot: env.COGNI_REPO_ROOT });
const rgAdapter = new RipgrepAdapter({
  repoRoot: env.COGNI_REPO_ROOT,
  repoId: "main",
  getSha: () => gitAdapter.getSha(),
});
```

## Standards

- REPO_READ_ONLY: Read-only access, no writes
- REPO_ROOT_ONLY: All paths validated (rejects `..`, symlink escapes)
- SHA_STAMPED: All results include HEAD sha7
- HARD_BOUNDS: search≤50 hits, snippet≤20 lines, open≤200 lines, max 256KB
- PATH_CANONICAL: All output paths use canonical format (no leading ./)
- NO_EXEC_IN_BRAIN: Only spawns `rg`, `git ls-files`, and `git rev-parse` with fixed flags
- RG_BINARY_NOT_NPM: Uses system `rg` binary via child_process

## Dependencies

- **Internal:** @cogni/ai-tools (RepoCapability interface), @/shared/observability
- **External:** ripgrep binary (rg), git

## Change Protocol

- Update this file when exports or env config change
- Coordinate with COGNI_BRAIN_SPEC.md for invariant changes

## Notes

- Requires system `rg` and `git` binaries at runtime (not npm packages)
- COGNI_REPO_SHA override is wired in GitLsFilesAdapter (used for mounts without .git)
- GitLsFilesAdapter owns SHA resolution; RipgrepAdapter receives getSha as an injected callback
