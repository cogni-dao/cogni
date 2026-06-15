---
id: handoff.node-merge-to-preview
type: handoff
work_item_id: ""
status: active
created: 2026-06-12
updated: 2026-06-12
branch: ""
last_commit: ""
---

# Handoff: Auto-promote a node to its preview on PR-merge

## Mission

Pickup: you own the **node-merge → preview** tie. Today a wizard-born node reaches **candidate-a** automatically (formation + flight) and can be **manually** promoted to preview by a human running `gh`. The missing system: when a node merges a PR to its main, its **preview** must update automatically — no human `gh`, no per-env hand-wiring. This is the last gap between "wizard spawns a node" and "node lives the operator's full lifecycle."

## Goal

- A node merges a customization PR → its **preview** advances to the new build with **zero human dispatch**.
- E2E signal: merge a habitat PR → within one operator action, `infra/catalog/habitat.yaml` `source_sha` updates to the new child SHA AND habitat serves that SHA on preview (`/version.buildSha` == new child main SHA), promoted **by the operator GitHub App**, not a personal `gh` token.
- Reuses the **one promotion primitive** (`promote-and-deploy.yml` reading catalog `source_sha`). No new promote path.

## Start By Reading

- `docs/spec/ci-cd.md` — North Star + axioms. Axiom 4 (build-once-promote-digest), Axiom 6 (Argo owns reconciliation). **Everything here is policy on top of the one primitive.**
- `docs/spec/legacy-cicd-to-remove.md` — "One artifact contract. One promotion primitive."
- `docs/spec/node-submodule-retirement.md` (#1647, MERGED) — **the pin is now `infra/catalog/<node>.yaml: source_sha` (`CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN`)**, not a gitlink.
- `docs/spec/merge-authority.md` (#1640, open) — operator-as-merge-authority via `VcsCapability.mergePr`; this is the shell the trigger lives in.
- `docs/spec/cicd-platform-boundary.md` + `nodes/operator/app/src/ports/operator-deploy-plane.port.ts` — `OperatorDeployPlanePort.dispatchNodePromote` is the home for the dispatch (operator-local, App-auth, OpenFGA-gated, not bash). `DeployCapability` (`@cogni/ai-tools`) is read-only — never put writes there.
- `.github/workflows/promote-and-deploy.yml` (`decide` job) + `flight-preview.yml` — the existing promote primitive + the **monorepo** on-merge trigger (push:main).

## Current State

- ✅ **#1647 merged**: catalog `source_sha` is the pin; `promote-and-deploy` resolves the node image from it.
- ✅ **Manual node preview promote WORKS** post-#1647 (verified 2026-06-12): `gh workflow run promote-and-deploy.yml -f environment=preview -f nodes=habitat` (no `source_sha` input) — `decide` passes; the child image resolves from catalog `source_sha`. (Passing a _child_ SHA as `source_sha` fails: it becomes the parent checkout ref → "not our ref". Don't.)
- 🔴 **No auto-trigger on node-main-merge.** `flight-preview.yml` fires on **monorepo** `push:main` only. A _node repo's_ main-merge triggers nothing in the operator.
- 🔴 **No operator dispatch path.** Promote fires only from a human's personal `gh` token; the operator App has no credential to dispatch it.
- 🟡 **Does NOT need a node merge queue.** A merge queue serializes many concurrent PRs against required checks — a monorepo problem. A single node at MVP has ~1 contributor; branch-protection (CI green) + operator-merge-on-green is sufficient. Defer per-node queues until a node has real concurrent contributors.

## Design / Implementation Target

1. **Operator merges the node PR (merge-authority, #1640) → on that merge, the operator writes the node's new `source_sha` into `infra/catalog/<node>.yaml` and dispatches the preview promote.** Because the operator did the merge, it already knows the new SHA — no webhook needed. (Webhook-on-node-push is the fallback only if a human merges outside the operator.)
2. **Reuse the one primitive.** The trigger updates catalog `source_sha` (the pin) and invokes `promote-and-deploy.yml` via `OperatorDeployPlanePort.dispatchNodePromote`. Do NOT invent a second promote path — North Star.
3. **Dispatch via the operator GitHub App, OpenFGA-gated** (`OperatorDeployPlanePort.dispatchNodePromote`), never a personal `gh` token. candidate-a/preview auto; **prod stays human/RBAC-gated** (`can_promote_production`, shipped #1653).
4. **No node merge queue** — branch protection + operator-merge-on-green. Don't build queue infra.

## Next Actions / Risks

- [ ] Confirm the manual habitat→preview run lands serving (this handoff's author left one in flight) — baseline the happy path.
- [ ] Wire the preview-promote consumer onto `OperatorDeployPlanePort.dispatchNodePromote`: write catalog `source_sha` + dispatch `promote-and-deploy` via the GitHub App.
- [ ] On operator merge of a node PR (merge-authority path): call `dispatchNodePromote(env=preview, node, sourceSha=<new child main sha>)`.
- [ ] OpenFGA gate: preview auto-promote is the ungated merge-hook path (continues spawn/flight trust); `can_promote_preview` is additive when MANUAL dev-driven preview promotes arrive. Prod = `can_promote_production` (#1653).
- [ ] E2E proof: merge a habitat PR → habitat preview serves the new SHA, dispatched by the App (check the run actor is the App, not a user).
- Risk: catalog `source_sha` edits are deploy-pin writes — they must be reviewable commits (not silent), per `INFRA_K8S_MAIN_DERIVED` discipline.
- Risk: preview is a shared env — scope promotes to `-f nodes=<node>`; never bulk-promote on a single node's merge.
- Risk: don't reintroduce a personal-token dispatch as a shortcut — that's the exact gap being closed.

## Pointers

| File / Resource                                       | Why it matters                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `infra/catalog/<node>.yaml` `source_sha`              | The deploy pin (post-#1647). The thing the trigger writes.                                                 |
| `.github/workflows/promote-and-deploy.yml` (`decide`) | The one promote primitive. Dispatch `-f environment=preview -f nodes=<node>`, no `source_sha`.             |
| `.github/workflows/flight-preview.yml`                | The monorepo's on-merge→preview trigger — the pattern to mirror for nodes (but operator-driven, not push). |
| `packages/ai-tools/src/capabilities/deploy.ts`        | `DeployCapability` — add `deployNode` here; adapter dispatches via the App.                                |
| `docs/spec/merge-authority.md` (#1640)                | Where the on-merge hook lives.                                                                             |
| `docs/spec/node-submodule-retirement.md` (#1647)      | Why the pin is a catalog field now.                                                                        |
