---
id: guide.node-removal
type: guide
title: Node Removal — Playbook for Stripping a Node from cogni
status: draft
trust: draft
summary: Step-by-step recipe for removing a node from Cogni-DAO/cogni — strip PR scope, expected CI failures, multi-env cluster cleanup, verification, rollback.
read_when: Removing a node (e.g., after splitting it into its own private repo, after deprecating it, or after migrating its responsibilities into another node). As-built from PR #1330 (strip nodes/poly).
owner: cogni-dev
created: 2026-05-12
tags: [ci-cd, repo-split, node-lifecycle, runbook]
---

# Node Removal Playbook

> As-built from [PR #1330](https://github.com/Cogni-DAO/cogni/pull/1330) (strip `nodes/poly`), executed 2026-05-11/12 as Phase 0 step 0.8 of [`docs/spec/private-node-repo-contract.md`](../spec/private-node-repo-contract.md).
>
> Replace `<NODE>` below with the node directory name (e.g., `poly`, `resy`, `node-template`).

## Pre-flight prerequisites

Before opening the strip PR, confirm:

1. **Data migration done.** If the node had any production data (postgres tables, doltgres rows), it's been dumped + restored to wherever the node now lives (e.g., the node's new private repo's prod VM). Postgres + doltgres data on cogni's VM persists past Argo Application prune — but Argo's prune is irreversible by design, so do the migration first.
2. **DNS cutover done.** If the node had a public domain (e.g., `<node>.cognidao.org`), it now points at the node's new VM, not cogni's prod VM.
3. **Business logic disabled if dangerous.** For nodes with side-effecting workloads (e.g., poly's copy-trade mirror, scheduler jobs against external systems), disable them at the data layer BEFORE strip so the in-flight pod doesn't keep acting until Argo prunes it. Examples:
   - Poly: `UPDATE poly_copy_trade_targets SET disabled_at = NOW() WHERE disabled_at IS NULL` against the prod `cogni_<node>` DB
   - Scheduler-worker: drop active schedules from the `scheduler_schedules` table
4. **Drift watcher established.** Between opening the strip PR and merging, monitor cogni's `main` for new commits to `nodes/<NODE>/`. Any such commits must be forward-ported to the node's new home before strip merge (example: cogni PR #1326 → cogni-poly PR #14).
5. **All ApplicationSet generators for the node are accounted for.** `infra/catalog/<NODE>.yaml` exists; overlays `infra/k8s/overlays/{candidate-a,canary,preview,production}/<NODE>/` all exist.

## Strip PR — what to delete + edit

### Delete (bulk)

```
nodes/<NODE>/                                                   # entire node source
infra/catalog/<NODE>.yaml
scripts/experiments/*<NODE>*.ts                                  # any node-specific exploratory scripts
scripts/experiments/<NODE>-*/                                    # any node-specific dirs
```

### Edit (surgical)

- **`tsconfig.json`** — remove any `{ "path": "./nodes/<NODE>/packages/..." }` workspace project references.
- **`biome/app.json`** — remove any per-node linter overrides block whose `includes` glob starts with `nodes/<NODE>/`.
- **`biome/base.json`** — remove any explicit allowlist entries pointing at `nodes/<NODE>/`.
- **`package.json`** — remove these script families:
  - `dev:<NODE>`, `dev:<NODE>:test` (and remove the references from `dev:stack:full` / `dev:stack:test:full` chains)
  - `db:generate:<NODE>`, `db:generate:<NODE>:doltgres`
  - `db:check:<NODE>`, `db:check:<NODE>:doltgres` (and remove from the `db:check` chain)
  - `db:migrate:<NODE>`, `db:migrate:<NODE>:doltgres`, `db:migrate:<NODE>:container`, `db:migrate:<NODE>:doltgres:container`, `db:migrate:test:<NODE>` (and from `db:migrate:nodes` / `db:migrate:test:nodes` chains)
  - `db:seed-money:<NODE>` (and from `db:seed-money:nodes` chain)
  - `db:seed:doltgres:<NODE>` (and from `db:seed:doltgres:nodes` chain)
  - `setup:secrets:<NODE>`
  - `typecheck:<NODE>`
  - `test:external:<NODE>`
  - Any `<NODE>:*` operational scripts (e.g., `poly:wallet:rotate-clob-creds`)
  - Workspace dependency entries: `@cogni/<NODE>-*` lines from the root `dependencies` block.
- **`pnpm-lock.yaml`** — regenerate after removing workspace deps:
  ```
  pnpm install --lockfile-only
  ```
- **`scripts/db/seed-doltgres.mts`** — if it dynamic-imports `@cogni/<NODE>-knowledge`, remove the try/catch block.
- **`scripts/ci/build-and-push-images.sh`** — remove the `<NODE>)` case in the per-target build switch.
- **`.github/workflows/ci.yaml`** — remove `<NODE>:` entry from the `dorny/paths-filter` filters block + remove `!nodes/<NODE>/**` from the `operator:` negative-filter list.
- **`infra/compose/runtime/docker-compose.yml`** — remove the node's slug + UUID from the `COGNI_NODE_ENDPOINTS` env var.
- **CI invariant fixtures** (`tests/ci-invariants/fixtures/single-node-scope/*.json`) — if any fixtures reference `nodes/<NODE>/` paths or `"<NODE>"` in `domains` arrays, substitute another existing non-operator node (e.g., `resy`) and re-sort the `domains` array alphabetically.
- **`tests/arch/tool-catalog-no-global-iteration.test.ts`** — remove `"<NODE>"` from the `NODES = [...]` array.

### Deliberately keep

- **`packages/repo-spec/src/testing.ts`** `TEST_NODE_ENTRIES.<NODE>` — stable test fixture used by `accessors.test.ts`, `services/scheduler-worker/tests/`, `packages/temporal-workflows/tests/`, `tests/ci-invariants/`. Keeping the fixture is harmless (it's just a stable UUID + path string, not a real node config).
- **Doc comments** mentioning the node in shared package READMEs.
- **`.dependency-cruiser.cjs`** cross-node-import rules naming the node — these still enforce the invariant "other nodes MUST NOT import this node's tools" even after strip. Removing them weakens the architecture rules.
- **`.claude/skills/<NODE>-*/`** local agent tooling — local-only, not part of published code. Optional cleanup.

## Expected CI behavior

When you push the strip branch, expect:

- ✅ **Required gates green** (`unit`, `component`, `static`, `manifest`) after a couple iterations (typically: lockfile regen, fixture domain-order fix).
- ❌ **The operator candidate flight is red** on this PR: the workflow runs from main's HEAD, where `infra/catalog/<NODE>.yaml` still exists. Expected; it does not block the strip.
- ❌ **`single-node-scope`** non-required, may go either way depending on which domains the PR spans.

### Common iteration failures

1. **Lockfile out of date** — `ERR_PNPM_OUTDATED_LOCKFILE`. Fix: `pnpm install --lockfile-only` + commit.
2. **`tests/ci-invariants/single-node-scope-parity.spec.ts` failures** — fixtures reference the deleted node. Fix: substitute to another node + re-sort `domains` arrays alphabetically.
3. **`tests/arch/tool-catalog-no-global-iteration.test.ts` ENOENT** — test iterates a hardcoded NODES list including the deleted node. Fix: remove from list.

## Multi-environment cleanup

A node's app runs on Akash through `POST /api/v1/deploy/workloads`, so the strip PR does not remove it from any cluster. Remove the node's workload from each env it runs in. There is no stop verb. Close the lease with `scripts/ops/recover-orphaned-akash-lease.sh --dseq <dseq>`, then verify by re-reading Console. See [deploy-a-declared-workload](https://cognidao.org/knowledge/deploy-a-declared-workload) and the `akash-node-expert` skill.

**Operator only:** an operator-lane app is evicted by Argo `prune: true` after the operator's ApplicationSets are re-applied (`flight-preview.yml` for preview, `candidate-flight-infra.yml` and `promote-and-deploy.yml` for the others).

### Verification (per env)

Confirm the host no longer serves (`curl https://<host>/version` fails) and `GET /api/v1/deploy/workloads?nodeId=<id>&env=<env>` shows no active release.

## Rollback

If you need to undo the strip after merge:

1. `git revert <merge-sha>` on cogni, open + merge revert PR
2. Deploy the node again with `POST /api/v1/deploy/workloads` for each env
3. **Data**: if data was migrated to a new repo's VM, restoring on cogni requires a fresh dump from the new location. The original `cogni_<NODE>` DB tables on cogni's prod VM should still have the pre-cutover snapshot — but it'll be stale by however long the new repo has been live.

## Live example

[PR #1330](https://github.com/Cogni-DAO/cogni/pull/1330) stripped `nodes/poly` in support of [`Cogni-DAO/cogni-poly`](https://github.com/Cogni-DAO/cogni-poly) (private repo split). Diff: 1545 files, +10 / −359906. Required CI green after 2 iterations (lockfile regen + fixture domain-order fix).

## Related

- [Private Node Repo Contract](../spec/private-node-repo-contract.md) — Phase 0 split that originated this playbook
- [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence) (hub) — node delivery sequence, including candidate-a
