---
name: node-template-sync
description: Use when a node-template change must reach the child node forks, when asked how node-template updates propagate to nodes, to mirror node-template CI/app to forks, to debug a missing or stale fork sync PR, or to bring a node-template app feature INTO the operator (cogni) by hand. Covers the AUTOMATED two-tier operator flow (merge→main webhook), why operator is excluded, and the manual operator cherry-pick path. Triggers: "sync node-template", "ship node-template update to nodes", "mirror to forks", "why didn't fork X get the update", "node-template merge didn't sync", "port a node-template feature into operator", "cherry-pick to cogni".
---

# node-template → fork sync

Keeping every child node fork aligned with `node-template`. **The mechanism is automated** (operator, on merge→main) and **two-tier**. This skill is for understanding, verifying, the rare manual fallback, and the **operator (cogni) cherry-pick path** — operator is deliberately NOT an automated target.

## How it works (as-built — PR #1750)

```
node-template merge → main
  → operator GitHub App webhook  (push event, HMAC-verified at /api/internal/webhooks/github)
    → dispatchCanonicalForkSync  (src/app/_facades/deploy/canonical-fork-sync.server.ts)
      → targets = infra/catalog/*.yaml source_repo rows in the parent monorepo
        (NODE_SUBMODULE_PARENT_{OWNER,REPO}); node-template + operator EXCLUDED
      → for each fork, TWO decoupled tiers (per-tier, per-fork error isolation):
          Tier 1  syncCanonicalFilesToFork    → byte-overwrite CI/contract files
          Tier 2  syncTemplateUpstreamToFork  → MERGE node-template upstream (preserves fork edits)
```

- **Two tiers, decoupled.** Tier 1 surgically overwrites the flight-contract files so a CI fix lands even when Tier 2's app merge conflicts. Tier 2 is an optional merge PR the fork owner reviews.
- **One living PR per tier per fork.** Stable, SHA-free branches force-updated on each node-template merge (Dependabot/Renovate pattern: rebase-in-place, never delete+recreate).
  - Tier 1 → `cogni-operator/node-template-sync`, title `chore: sync CI + contract files from node-template`.
  - Tier 2 → `cogni-operator/node-template-upstream`, title `chore: merge node-template upstream`.

### Tier 1 — CI/contract overwrite (required, byte-for-byte-safe)

`CI_CONTRACT_PATHS` in the facade — a fork drifting here breaks the operator's flight contract:

```
.github/workflows/ci.yaml
.github/workflows/pr-build.yml
.github/workflows/pr-lint.yaml
scripts/check-node-ci-workflow.mjs
```

Add a path only if it is **identical across all forks** — never node-specific (`package.json` carries per-node deps; do not clobber).

### Tier 2 — upstream app/graphs/runtime merge (optional, fork-reviewed)

`syncTemplateUpstreamToFork` materializes the node-template tip commit as a branch **inside the fork** (reachable via the shared fork network), then opens a **same-repo** PR head=`cogni-operator/node-template-upstream` → base=fork main. It's a **merge, not an overwrite** — fork customizations survive. The PR body enumerates the node-template commit subjects it carries.

## Two wiring traps (the hard-won part — also in the `node-template-fork-sync` hub entry)

1. **Trigger = the App's existing webhook. Never a held secret.** No token route, no `scripts/ci/*.sh`. The freeze-correct on-demand alternative is an OpenFGA-gated `node.*` action, not a static bearer.
2. **Fork targets come from `infra/catalog`, NOT the nodes table or the node registry.** Targets are `source_repo` rows in the parent monorepo (`NODE_SUBMODULE_PARENT_{OWNER,REPO}`), env-aligned (cogni-test-org on candidate-a, Cogni-DAO on prod). The registry would resolve to the parent monorepo or a hardcoded hub repo — enumerating it targets the hub itself.

## Operator (cogni) is NOT an automated target — by design

`FORK_SYNC_EXCLUDED_SLUGS = {node-template, operator}`. Operator can't ride either tier:

- **Tier 1 is the wrong direction.** Per [`repo-sync-contract`](../../../docs/spec/repo-sync-contract.md) `HUB_IS_COGNI_MONOREPO`, cogni is the _canonical source_ of operator-scope CI; node-template pulls from it. node-template's root single-node `ci.yaml` is incompatible with the monorepo's multi-node merge_group CI. Hub↔template CI drift is watched (correct direction) by `sync-drift-detector.yml`.
- **Tier 2 can't mechanically run.** It needs node-template and the target in one git object store (materialize the upstream SHA as a branch → same-repo PR). cogni is not a fork of node-template, so the SHA is unreachable. And paths don't correspond: node-template is repo-root; operator is `nodes/operator/**` + shared `packages/**`, with a divergent superset app (the control plane). This is the history-preserving bidirectional case `repo-sync-contract` defers to v2 (josh-proxy).

## Operator cherry-pick path (manual — the recurring one)

node-template app features that operator wants (e.g. [node-template#43](https://github.com/cogni-dao/node-template/pull/43) 3D graph view) are **hand cherry-picks**, not an automated mirror. Expect these to recur.

1. Identify the node-template PR/commit and the files it touched (repo-root paths).
2. Map paths into the monorepo: node-template `app/**` → `nodes/operator/app/**`; shared substrate → the matching `packages/**` (operator's app is a superset, so reconcile against what already exists rather than overwriting).
3. Apply the change as a normal operator code PR through the standard lifecycle (single work item, branch → CI → candidate-a validation). No sync tooling involved.
4. Many such features originated in the monorepo before node-template was split out — check whether operator already has (or had) it before porting.

## Verify a sync

- **Loki:** event `node_template_fork_sync_complete` at the deployed buildSha — fields `source`, `forks`, `ciOpened`, `ciFailed`, `templateOpened`, `templateFailed`, `entries[]` (each `{ target, ci, ciPrUrl?, template, templatePrUrl? }`).
- **GitHub:** each target fork shows the two living branches/PRs above.
- **forks: 0** is valid (no catalog forks for the operator's env) — the trigger fired; nothing to mirror.

## If a fork didn't get the update

- The App must subscribe to **`push`** events and be installed on the fork's org (candidate-a App = `cogni-operator-test` on `cogni-test-org`; prod = `cogni-operator` on `Cogni-DAO`).
- The fork must be a `source_repo` row in the parent monorepo's `infra/catalog` (not the source/hub, not hand-created repos missing from the catalog).
- Tier 1: the changed file must be in `CI_CONTRACT_PATHS`; otherwise no diff → no PR (correct). Tier 2: `up_to_date` means no un-merged upstream deltas.

## Manual fallback

There is intentionally **no token route and no `scripts/ci/*.sh`** (the old `sync-node-template-fork-pr.sh` is retired). If you must trigger out-of-band, the home is the typed operator deploy plane (`syncCanonicalFilesToFork` / `syncTemplateUpstreamToFork`), invoked via an authenticated, RBAC-gated operator action — never a curl with a shared secret.

## References

- Code: `src/app/_facades/deploy/canonical-fork-sync.server.ts`, `src/adapters/server/vcs/github-repo-write.ts`, `src/app/api/internal/webhooks/[source]/route.ts`.
- As-built contract: [`docs/spec/repo-sync-contract.md`](../../../docs/spec/repo-sync-contract.md), [`docs/spec/node-ci-cd-contract.md`](../../../docs/spec/node-ci-cd-contract.md).
- Hub knowledge: `node-template-fork-sync` (operator / infrastructure).
