---
name: node-template-sync
description: Use when a canonical node-template change must reach the child node forks, or when asked how node-template updates propagate to nodes, to mirror node-template CI/infra/config to forks, to sync node-template to all nodes, to debug a missing or stale fork sync PR, or to verify the node-template→fork mirror. Covers the AUTOMATED operator flow (merge→main webhook) and the manual fallback. Triggers: "sync node-template", "ship node-template update to nodes", "mirror canonical files to forks", "why didn't fork X get the update", "node-template merge didn't sync".
---

# node-template → fork sync

Keeping every child node fork aligned with `node-template`'s **canonical content**. **The mechanism is automated** (operator, on merge→main); **the inherited file set is not yet complete** — see the scope gap below. This skill is for understanding, verifying, and the rare manual fallback — not a manual playbook to run by hand.

## ⚠️ Scope gap (open) — graphs + runtime do NOT sync yet

Today `CANONICAL_FORK_SYNC_PATHS` is the **byte-for-byte-safe CI subset** (3 workflows + `check-node-ci-workflow.mjs`). node-template improvements to **default graphs (`graphs/**`, `packages/**-graphs`) and runtime/app code do NOT propagate** — the feature's real goal is unmet until they do. They can't simply be added to the hardcoded list: forks **customize** those files, so a byte-for-byte overwrite would propose clobbering fork work. The fix is a **fork-inheritance manifest** node-template declares (framework-owned = mirror · fork-owned = never touch · shared-customizable = merge/flag), applying `repo-sync-contract`'s `omit_from_artifact`/`artifact_only` model to the node-template→fork axis. Then a default-graph improvement is in the inherited set and syncs with no code change. **That manifest is the next deliverable.**

## How it works (as-built — PR #1681 / task.5020)

```
node-template merge → main
  → operator GitHub App webhook  (push event, HMAC-verified at /api/internal/webhooks/github)
    → dispatchCanonicalForkSync  (src/app/_facades/deploy/canonical-fork-sync.server.ts)
      → for each active child fork:  OperatorDeployPlanePort.syncCanonicalFilesToFork
        → read canonical paths @ pushed SHA → diff vs fork main → changed-only tree
        → open/update ONE PR on branch  cogni-operator/sync-canonical-<shortSha>
```

- **One PR per fork.** The SHA-stable branch is the idempotency key — webhook re-delivery updates the same PR, never opens a second.
- **Per-fork error isolation.** One fork failing (e.g. App not installed) logs `failed` and never aborts the others.
- **Canonical set** = `CANONICAL_FORK_SYNC_PATHS` in the facade. Add a path only if it is **identical across all forks** — never node-specific (`package.json` carries per-node deps; do not clobber).

## Two wiring traps (the hard-won part — also in the `node-template-fork-sync` hub entry)

1. **Trigger = the App's existing webhook. Never a held secret.** An `INTERNAL_OPS_TOKEN` route was built then removed: that token is CI-only; no human/agent should wield it. The freeze-correct on-demand alternative is an OpenFGA-gated `node.*` action (like `node.flight`), not a static bearer.
2. **Fork targets come from the `nodes` table, NOT the node registry.** `resolveNodeRegistry().listPublic()` exposes the **parent monorepo** (DB rows) or a **hardcoded `Cogni-DAO/<name>`** (showcase, incl. `operator → Cogni-DAO/cogni`). Enumerating it targets the **hub itself**. Targets are active `nodes` rows as `${NODE_MINT_OWNER}/<slug>` (forkFromTemplate's naming); that table already excludes operator/resy/template.

## Verify a sync

- **Loki:** event `node_template_fork_sync_complete` at the deployed buildSha — fields `forks`, `opened`, `noChanges`, `failed`, `prs[]`.
- **GitHub:** each target fork shows a `cogni-operator/sync-canonical-<sha>` branch + open PR titled `chore: sync canonical node-template files (<sha>)`.
- **forks: 0** is valid (no active child forks registered for the operator's env) — the trigger fired; there was nothing to mirror.

## If a fork didn't get the update

- The App must subscribe to **`push`** events and be installed on the fork's org (candidate-a App = `cogni-operator-test` on `cogni-test-org`; prod = `cogni-operator` on `Cogni-DAO`).
- The fork must be an **active** row in the operator's `nodes` table (wizard-spawned). Hand-created repos not in the table are not targeted.
- The changed file must be in `CANONICAL_FORK_SYNC_PATHS`; otherwise no diff → no PR (correct).

## Manual fallback

There is intentionally **no token route and no `scripts/ci/*.sh`** (the old `sync-node-template-fork-pr.sh` is retired — fragile partial-clone + blind merge). If you must trigger out-of-band, the home is the typed operator deploy plane (`syncCanonicalFilesToFork`), invoked via an authenticated, RBAC-gated operator action — never a curl with a shared secret.

## References

- Code: `src/app/_facades/deploy/canonical-fork-sync.server.ts`, `src/adapters/server/vcs/github-repo-write.ts` (`syncCanonicalFilesToFork`), `src/app/api/internal/webhooks/[source]/route.ts`.
- As-built contract: [`docs/spec/repo-sync-contract.md`](../../../docs/spec/repo-sync-contract.md) §v0.2.
- Hub knowledge: `node-template-fork-sync` (operator / infrastructure).
