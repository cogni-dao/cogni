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
infra/k8s/overlays/{candidate-a,canary,preview,production}/<NODE>/
infra/catalog/<NODE>.yaml
scripts/experiments/*<NODE>*.ts                                  # any node-specific exploratory scripts
scripts/experiments/<NODE>-*/                                    # any node-specific dirs
```

### Edit (surgical)

- **`infra/k8s/argocd/{candidate-a,preview,production}-applicationset.yaml`** — remove the `- git:` generator entry whose `revision: deploy/<env>-<NODE>` references the node. (Canary applicationset deleted in bug.0312; only the three remaining envs apply.)
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
- ❌ **`candidate-flight` red** on this PR — the workflow runs from main's HEAD (where `infra/catalog/<NODE>.yaml` still exists), so `detect-affected.sh` marks the node as affected based on PR diff, tries to build it, and fails because the Dockerfile is gone in PR head. **This is one-shot and expected.** After merge, future flights won't include the node.
- ❌ **`single-node-scope`** non-required, may go either way depending on which domains the PR spans.

### Common iteration failures

1. **Lockfile out of date** — `ERR_PNPM_OUTDATED_LOCKFILE`. Fix: `pnpm install --lockfile-only` + commit.
2. **`tests/ci-invariants/single-node-scope-parity.spec.ts` failures** — fixtures reference the deleted node. Fix: substitute to another node + re-sort `domains` arrays alphabetically.
3. **`tests/arch/tool-catalog-no-global-iteration.test.ts` ENOENT** — test iterates a hardcoded NODES list including the deleted node. Fix: remove from list.

## Multi-environment cluster cleanup

The strip PR removes the node from cogni's source tree. Argo CD on each cluster keeps the node's Application + pods alive until each ApplicationSet is re-applied. Argo's `prune: true` then evicts the orphan Application.

| Env             | Cleanup trigger                                                                                                                               | Manual?      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **preview**     | `flight-preview.yml` auto-fires on merge → calls `promote-and-deploy.yml` (preview) → `deploy-infra` job re-applies AS to preview's argocd ns | ✅ automatic |
| **candidate-a** | `gh workflow run candidate-flight-infra.yml --repo Cogni-DAO/cogni`                                                                           | 🔴 manual    |
| **production**  | `gh workflow run promote-and-deploy.yml --repo Cogni-DAO/cogni -f environment=production -f source_sha=<merged-main-sha>`                     | 🔴 manual    |

### Verification (per env)

After each cluster's AS is re-applied, SSH to the VM and confirm:

```bash
# AS no longer has the node's generator
kubectl -n argocd get applicationset cogni-<env> -o yaml | grep "deploy/<env>-<NODE>"  # should return nothing

# Application gone
kubectl -n argocd get application <env>-<NODE>  # should say NotFound

# Pod gone
kubectl -n cogni-<env> get pods -l app=<NODE>-node-app  # should say "No resources found"
```

VM IPs (cogni's clusters):

- production: `84.32.110.202` (key: `~/dev/cogni-template/.local/production-vm-key`, user: root)
- preview: `84.32.110.92` (key: `~/dev/cogni-template/.local/preview-vm-key`)
- candidate-a: `84.32.109.160` (key: `~/dev/cogni-template/.local/canary-vm-key` — candidate-a inherited the retired canary VM)

### What persists (not auto-deleted)

Argo's prune only deletes k8s resources it owns. The following persist on each VM:

- Postgres database `cogni_<NODE>` (data tables stay; just no app connects to them anymore)
- Doltgres database `knowledge_<NODE>` (same)
- Any GHCR images at `ghcr.io/cogni-dao/cogni-template:*-<NODE>` and `cogni-template-migrate:*-<NODE>`
- Deploy branches `deploy/{preview,candidate-a,production}-<NODE>` (now orphaned; can be deleted manually)

For a future "fully clean" follow-up, drop the DBs + delete deploy branches. v0 leaves them as audit trail.

## Rollback

If you need to undo the strip after merge:

1. `git revert <merge-sha>` on cogni, open + merge revert PR
2. Re-fire `promote-and-deploy.yml` for each env to re-apply ApplicationSets with the node restored
3. **Data**: if data was migrated to a new repo's VM, restoring on cogni requires a fresh dump from the new location. The original `cogni_<NODE>` DB tables on cogni's prod VM should still have the pre-cutover snapshot — but it'll be stale by however long the new repo has been live.

## Live example

[PR #1330](https://github.com/Cogni-DAO/cogni/pull/1330) stripped `nodes/poly` in support of [`Cogni-DAO/cogni-poly`](https://github.com/Cogni-DAO/cogni-poly) (private repo split). Diff: 1545 files, +10 / −359906. Required CI green after 2 iterations (lockfile regen + fixture domain-order fix).

## Related

- [Private Node Repo Contract](../spec/private-node-repo-contract.md) — Phase 0 split that originated this playbook
- [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence) (hub) — node delivery sequence, including candidate-a
- [CD Pipeline E2E](../spec/cd-pipeline-e2e.md) — full deploy plane architecture
