---
id: "handoff.cogni-1279-node-template-ghcr-cicd-sync"
type: handoff
work_item_id: "cogni-1279"
status: active
created: 2026-06-08
updated: 2026-06-08
branch: "derekg1729/purge-in-tree-node-template"
last_commit: "50977e31731240aab011f75ba728b4168e2df63e"
---

# Handoff: Node Template GHCR + CI/CD Sync

## Mission

Pickup: finish the node-template/node-ref CI/CD sync after the GHCR package permission fix. The GHCR `write_package` blocker is resolved; the remaining work is repo alignment across the four persistent repos only: `Cogni-DAO/cogni`, `Cogni-DAO/node-template`, `cogni-test-org/cogni-monorepo`, and `cogni-test-org/node-template`. Treat other `cogni-test-org/*` node repos as throwaway wizard spawns unless explicitly named.

## Goal

- `Cogni-DAO/node-template` PR Build is green end-to-end after `ci: sync source-sha PR build contract` (#8) landed.
- `cogni-test-org/cogni-monorepo` mirrors merged control-plane CI/CD changes from Cogni-DAO/cogni #1575 and #1577.
- `cogni-test-org/node-template` remains aligned with `Cogni-DAO/node-template` for node-at-root PR Build files.
- E2E signal: a node-template PR publishes `ghcr.io/cogni-dao/node-template:sha-<headSha>` and completes `PR Build / manifest`.

## Start By Reading

- `docs/spec/node-ci-cd-contract.md`
- `docs/guides/github-app-webhook-setup.md` sections "Operator mint/flight App permissions" and "GHCR package requirement for wizard E2E"
- `.agents/skills/node-template-infra-sync-prs/SKILL.md`
- `Cogni-DAO/node-template` PR #8: https://github.com/Cogni-DAO/node-template/pull/8
- `Cogni-DAO/cogni` PR #1575: https://github.com/Cogni-DAO/cogni/pull/1575
- `Cogni-DAO/cogni` PR #1577: https://github.com/Cogni-DAO/cogni/pull/1577

## Current State

- GHCR package access is fixed. A throwaway smoke PR `Cogni-DAO/node-template#9` built successfully and published `ghcr.io/cogni-dao/node-template:sha-2773bfbfc67e46b56d029ce78db106669b581f35`; the package version id was `924767374`. The PR was closed and branch deleted.
- `Cogni-DAO/node-template#8` is merged at `13131f28a117f28d91924214c3c3b5c2205a1a19`. Do not patch #8; create a new follow-up PR.
- The smoke PR then failed in `PR Build / manifest` because `Cogni-DAO/node-template` lacks `scripts/ci/write-node-build-manifest.mjs`.
- `cogni-test-org/node-template` already has `scripts/ci/write-node-build-manifest.mjs`. Its `pr-build.yml`, `write-node-build-fragment.mjs`, and `scripts/check-node-ci-workflow.mjs` match `Cogni-DAO/node-template`; only the manifest writer is missing from production template.
- `Cogni-DAO/cogni#1575` merged at `39a3167718229247e5c85779a377ffcf6e9bed1b`; `cogni-test-org/cogni-monorepo` already matches its touched CI/DNS files.
- `Cogni-DAO/cogni#1577` merged at `3e01e758a89f11e9f6c848db1d41c7d773c3ed05`; `cogni-test-org/cogni-monorepo` does not yet have `scripts/ci/assert-target-substrate.sh` or `scripts/ci/tests/assert-target-substrate.test.sh`.

## Repo Matrix

| Repo                            | Role                             | Needed update                                                                                                                         |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Cogni-DAO/cogni`               | Production control-plane source  | Already has #1575 and #1577 merged. No follow-up unless new drift appears.                                                            |
| `Cogni-DAO/node-template`       | Production node-at-root template | Needs a new PR adding `scripts/ci/write-node-build-manifest.mjs` from `cogni-test-org/node-template` and verifying PR Build manifest. |
| `cogni-test-org/cogni-monorepo` | Test control-plane mirror        | Needs a new PR porting #1577 substrate assertion files and workflow/check changes from `Cogni-DAO/cogni`. #1575 is already synced.    |
| `cogni-test-org/node-template`  | Test node-at-root template       | Currently ahead/complete for manifest writer. After production template PR merges, confirm it still matches; likely no PR needed.     |

## Design / Implementation Target

1. Preserve the source-SHA artifact contract: source repos publish `ghcr.io/<lower-owner>/<lower-repo>:sha-<sourceSha>`.
2. Do not add PATs or deploy tokens to child/template repos for publishing. Publishing uses repo-local `GITHUB_TOKEN` plus `permissions.packages: write`.
3. Do not delete/recreate `ghcr.io/cogni-dao/node-template`; historical tags exist. Package reconciliation is the Actions access grant already applied.

## Next Actions / Risks

- [ ] Open a new `Cogni-DAO/node-template` PR adding `scripts/ci/write-node-build-manifest.mjs`, preferably copied byte-for-byte from `cogni-test-org/node-template:main`.
- [ ] Run/observe a node-template PR Build through `manifest` success. Use a throwaway PR if needed.
- [ ] Open one `cogni-test-org/cogni-monorepo` PR porting merged `Cogni-DAO/cogni#1577`.
- [ ] Verify `cogni-test-org/cogni-monorepo` checks, especially `workflow-check` and candidate-flight syntax.
- [ ] Re-scan the four repos after both PRs merge and update `.context/node-template-infra-sync-prs/pr1577-1575-test-org-scan.json`.

- Existing open `Cogni-DAO/node-template` PRs #6 and #7 may be stale against #8; do not conflate their graph/app changes with the manifest writer fix.
- `cogni-test-org/cogni` is a private fixture with odd API branch visibility in this session; the usable persistent test monorepo target is `cogni-test-org/cogni-monorepo`.
- If a future spawned node reuses a slug whose GHCR package already exists under another repo, it can hit the same `write_package` class; fresh unique wizard spawns should not.

## Pointers

| File / Resource                                                                | Why it matters                                                                   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `scripts/ci/write-node-build-manifest.mjs` in `cogni-test-org/node-template`   | Missing production-template file that caused smoke PR #9 manifest failure.       |
| `.github/workflows/pr-build.yml` in `Cogni-DAO/node-template`                  | Calls the missing manifest writer after successful image build.                  |
| `scripts/ci/assert-target-substrate.sh` from `Cogni-DAO/cogni#1577`            | New merged control-plane substrate guard to port to test monorepo.               |
| `scripts/ci/tests/assert-target-substrate.test.sh` from `Cogni-DAO/cogni#1577` | Test coverage for the substrate guard.                                           |
| `.context/node-template-infra-sync-prs/pr1577-1575-test-org-scan.json`         | Scratch ledger started for this sync; update or replace with final target state. |
