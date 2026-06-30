---
id: handoff.deploy-control-plane
type: handoff
work_item_id: ""
status: active
created: 2026-06-12
updated: 2026-06-12
branch: feat/deploy-promote-rbac
last_commit: 93f8db5587
---

# Handoff: Operator deploy control plane — prod-promote RBAC + e2e

## Mission

Pickup: you own the **operator deploy control plane** — landing **prod-promote RBAC** (#1653) and driving the node deploy e2e (candidate → preview → prod) to "well-defined flows + RBAC + API endpoints for external devs," toward Derek's north star: **the operator AI autonomously managing VMs + deployments + health**. The hard architecture call is already made (below) — your job is to finish + prove it, not re-litigate it.

## THE settled architecture (do not re-thrash this)

**`OperatorDeployPlanePort`** (`nodes/operator/app/src/ports/operator-deploy-plane.port.ts`, created by #1562/#1550/#1572) is **THE** operator deploy control plane:

- **operator-local by design** — deliberately kept **out of** the shared `@cogni/ai-tools` capabilities, because deploy dispatch is a **gated operator action**, not a freely-callable brain tool.
- owns **all deploy WRITES**: `dispatchNodeRefCandidateFlight` (flight→candidate) + `dispatchNodePromote` (promote→preview/prod). App-dispatched (operator GitHub App, not a personal `gh` token), with `prepareNodeRefCandidateFlight`'s artifact verify-gate.
- `DeployCapability` (`packages/ai-tools/src/capabilities/deploy.ts`) is **READ-ONLY** — env/node deploy-state awareness for brain/dashboard. **Never put writes there** (that was the drift; corrected in #1653).

The RBAC trust ladder (OpenFGA, `infra/openfga/rbac-model.json`, additive-only — never rename live relations):

```
developer → can_flight             (candidate-a)     [node.flight]
(ungated)  preview auto-promote     (continues spawn/flight trust — operator merge-hook path)
promoter  → can_promote_production  (production)      [node.promote_production]   ← #1653
(later)   → can_promote_preview     when MANUAL dev-driven preview promote arrives (additive)
```

## Goal / e2e proof

- Land #1653: the operator promotes a node to **production** via `POST /api/v1/deploy/promote`, gated `node.promote_production` — **no more "only Derek's personal gh creds."**
- **Proof (rbac-expert pattern):** on candidate-a, `POST /api/v1/deploy/promote {nodeId, env:"production"}` returns **`403 authz_denied`** before a `promoter` grant → flips to a downstream result after granting. **GOTCHA: prod + preview have NO OpenFGA store yet — the gate is only PROVABLE on candidate-a** (rbac-expert). Candidate-a slot is shared + was busy — **coordinate with Derek before flighting; flight once.**

## Start By Reading (skills first, they hold the durable model)

**Skills:** `rbac-expert` (OpenFGA model, can_flight/can_promote_production, the "no store on prod/preview → authz undefined" gotcha, the 403→flip proof) · `git-app-expert` (GitHub App, flight dispatch, VcsCapability) · `devops-expert` (the freeze policy — reads `cicd-platform-boundary.md` first) · `validate-candidate` (the deploy_verified loop) · `node-ci-cd-contract` knowledge · `promote` (preview/prod promotion mechanics + gotchas) · `tldr` (Derek's comms: ≤5 lines, 🔴🟡🟢, drive-to-done) · `review-implementation`.

**Specs (the e2e canon):**

- `docs/spec/node-ci-cd-contract.md` **§ Env-promotion progression** — THE ladder (candidate/preview/prod · trigger · authz · mechanism + invariants `TRUST_LADDER_IS_MONOTONIC`/`PROMOTION_RUNS_AS_THE_OPERATOR`/`ONE_PROMOTION_PRIMITIVE`). **Correct & authoritative.**
- `docs/spec/cicd-platform-boundary.md` — freeze + the typed control plane (home **corrected**; prose sweep pending, see below).
- `docs/spec/legacy-cicd-to-remove.md` — North Star: **one artifact contract, one promotion primitive.**
- `docs/spec/ci-cd.md` — 22 axioms (4 build-once-promote-digest, 6 Argo-owns-reconciliation, 16 CATALOG_IS_SSOT, 22 substrate-reconciled-before-promote).
- `docs/spec/node-submodule-retirement.md` (#1647) — the pin is now **catalog `source_sha`** (`CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN`), not a gitlink.
- `docs/spec/development-lifecycle.md` §8 — Operator Merge Authority (#1640) — operator-as-merge-authority + capacity gate (the preview-promote trigger home). [merged into development-lifecycle.md; was `docs/spec/merge-authority.md`]
- `docs/design/operator-managed-deployments.md` — human-simple SEE/DEPLOY/REMOVE (needs port correction, below).

**Guides:** `docs/guides/agent-api-validation.md` · `docs/guides/candidate-flight-v0.md`.

## Current State (facts)

- **#1653 (this branch, OPEN):** realignment DONE. `OperatorDeployPlanePort.dispatchNodePromote` (port + `GitHubRepoWriter` adapter `nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts`); `/api/v1/deploy/promote` route → the port, authz `node.promote_production` BEFORE dispatch; `can_promote_production`/`promoter` in `rbac-model.json`; `node.promote_production` action in `packages/authorization-core/src/index.ts`; `DeployCapability` reverted to read-only; duplicate `GitHubDeployAdapter` + `createDeployCapability` deleted. **`build(operator)` + `static` GREEN (typechecks); `unit` re-running after a prettier fix (`93f8db5587`).** NOT yet flighted/proven.
- **#1643 MERGED** — freeze policy + `DeployCapability` (read-only) + skills (devops-expert/git-app-expert cite the freeze).
- **#1647 MERGED (dev2)** — submodule → catalog `source_sha`.
- **#1640 (merge QUEUED)** — operator merge-authority + capacity. **Touches `github-repo-write.ts`** (same file #1653 edits) → **you must rebase #1653 onto main after it lands** (resolve the additive `dispatchNodePromote` vs their changes).
- **#1654 CLOSED** — old node-merge→preview (dev took Option A; re-cut onto OperatorDeployPlanePort + #1640's hook).
- Preview-promote work (other dev's lane): `work/handoffs/node-merge-to-preview.md` — **STALE: it says `DeployCapability.deployNode`; correct it to `OperatorDeployPlanePort` (writes are operator-local).**

## Next Actions / Risks

- [ ] **After #1640 merges:** `git fetch && git rebase origin/main` on `feat/deploy-promote-rbac`; resolve `github-repo-write.ts` (your `dispatchNodePromote` is additive). Push `--force-with-lease`.
- [ ] Confirm #1653 CI fully green (unit, after the format fix).
- [ ] **Prove on candidate-a** (coordinate w/ Derek — busy slot): flight #1653, then exercise `POST /api/v1/deploy/promote` → 403-before-grant → flip-after. Post a `validate-candidate` scorecard to the PR.
- [ ] **Doc sweep:** fix `node-merge-to-preview.md` (DeployCapability.deployNode → OperatorDeployPlanePort); finish `cicd-platform-boundary.md` prose (the ASCII diagram L184-191 + the "Prototype interfaces" block L198+ still show `DeployCapability.promote`); `operator-managed-deployments.md` (writes = OperatorDeployPlanePort).
- [ ] **Rename `vcs/flight` → `deploy/flight`** (Derek's original drift; Derek OK'd deprecating the route, "only me uses it"). Both flight+promote are now on `OperatorDeployPlanePort`, so it's a route move: `nodes/.../api/v1/vcs/flight/route.ts` → `deploy/flight`, move the contract test `nodes/operator/app/tests/contract/app/vcs.flight.test.ts`, update ~15 docs citing the route path. **Leave the AI tool `core__vcs_flight_candidate`** (pr-manager's path, not "only Derek" — separate follow-up).
- [ ] Land #1653: needs cross-review (the other dev) + CI green + candidate-a deploy_verified.
- Risk: never re-introduce personal-`gh` dispatch — the whole point is operator-App dispatch.
- Risk: OpenFGA model is immutable+hashed — **add** relations, never rename live ones.
- Risk: candidate-a is a shared slot — flight ONCE; don't burn it when busy.
- Risk: Derek's machine can't run heavy local builds; push + watch CI (`gh pr checks`). Local package dist can be stale — CI rebuilds packages, so trust CI over a local operator typecheck.

## Pointers

| File / Resource                                                   | Why                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `nodes/operator/app/src/ports/operator-deploy-plane.port.ts`      | THE deploy-write port (flight + promote)                                                                                           |
| `nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts` | `GitHubRepoWriter` impl (App dispatch) — **#1640 also edits this**                                                                 |
| `nodes/operator/app/src/app/api/v1/deploy/promote/route.ts`       | the RBAC-gated prod-promote route (#1653)                                                                                          |
| `nodes/operator/app/src/app/api/v1/vcs/flight/route.ts`           | flight route → rename to `deploy/flight`                                                                                           |
| `infra/openfga/rbac-model.json`                                   | `promoter` + `can_promote_production` (+ `developer`/`can_flight`)                                                                 |
| `packages/authorization-core/src/index.ts`                        | `node.promote_production` → `can_promote_production` action map                                                                    |
| `packages/ai-tools/src/capabilities/deploy.ts`                    | `DeployCapability` — READ-ONLY (do not add writes)                                                                                 |
| PRs                                                               | #1653 (mine, open) · #1643/#1647 (merged) · #1640 (queued, rebase trigger) · #1654 (closed) · #1550/#1562/#1572 (created the port) |
