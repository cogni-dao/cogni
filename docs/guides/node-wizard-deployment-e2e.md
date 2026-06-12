---
id: node-wizard-deployment-e2e-guide
type: guide
title: "Node Wizard → Deployed — E2E Lifecycle & cogni-operator App Actions"
status: draft
trust: draft
summary: The end-to-end map of a wizard-born node from dao_formed to running pods — every cogni-operator GitHub App action and gate at each stage, what's built vs not, and the lifecycle shortcomings (no CRUD, no management plane) that the OperatorDeployPlanePort closes next.
read_when: You need the whole-flow picture of where the cogni-operator App acts and gates across node formation → deployment, are debugging which stage a spawn stalled at, or are scoping node-lifecycle / management-plane work.
owner: derekg1729
created: 2026-06-12
verified: null
tags: [node, wizard, deployment, github-app, lifecycle, deploy-capability]
---

# Node Wizard → Deployed — E2E Lifecycle & cogni-operator App Actions

> **Scope.** This is the cross-cutting **map**: where every cogni-operator GitHub App
> action and gate sits on the wizard→deployed spine, and where the lifecycle is thin.
> For the sub-flows it ties together, see [`node-formation-guide.md`](./node-formation-guide.md)
> (DAO setup), [`create-node.md`](./create-node.md) (deploy matrix), the
> [node-ci-cd contract](../spec/node-ci-cd-contract.md) (forward deployment contract),
> and [`merge-authority.md`](../spec/merge-authority.md) (the merge chokepoint design).
> Operational App-auth detail lives in the [`git-app-expert`](../../.claude/skills/git-app-expert/SKILL.md) skill;
> live launch execution + proof in [`node-wizard-scorecard`](../../.claude/skills/node-wizard-scorecard/SKILL.md).

## The spine

```
USER WIZARD: dao_pending → dao_formed
     │
     ▼  POST /nodes/{id}/publish        ◄══ cogni-operator App (mint creds)
     │   ├─ check_capacity        ⛔ GATE ✅BUILT — countDeployedWizardNodes(parent catalog)   ← "WIZARD gate" (pre-mint)
     │   ├─ bootstrap_dolthub          App: create knowledge repo (DOLTHUB_OWNER org)
     │   ├─ fork_from_template         App: POST /forks + commit identity + enable Actions  → mints node repo
     │   └─ open_submodule_pr          App: commit catalog+overlay+appset+source_sha pin → opens FORMATION PR
     │   → node row = published
     ▼
NODE REPO CI (pr-build)               ◄══ NODE repo's own GITHUB_TOKEN — NOT the operator App
     │   → builds ghcr.io/<org>/<node>:sha-<sha>
     ▼
FORMATION PR review                   ◄══ review plane (prod: cogni-git-review · cand-a: cogni-operator-test)
     │   pull_request webhook → PrReviewWorkflow → review status   ⛔ REVIEW GATE ✅BUILT
     ▼
FORMATION PR merge → parent main      ◄══ cogni-operator App: VcsCapability.mergePr
     │   ⛔ MERGE GATE (allGreen ∧ capacity < ceiling)   🔴 NOT BUILT — merge-authority "next slice"
     │   (today: a human merges the formation PR)
     ▼  (catalog row now on parent main — the node is "registered")
CANDIDATE-A flight                    ◄══ cogni-operator App: ensureCatalogSourceSha (pin PR) + dispatchCandidateFlight (workflow_dispatch)
     │   candidate-flight.yml: resolve sha-<sha> → digest → deploy/candidate-a → ⛔ verify-buildsha   ✅BUILT
     ▼
NODE-MERGE → PREVIEW                  ◄══ cogni-operator App: bump catalog source_sha + auto/merge → flight-preview   🔴 IN FLIGHT (preview tie)
     ▼
Argo reconciles → PODS RUN (deployed)
```

## cogni-operator App actions (the GitHub App auth)

| Action                     | Where                        | What it does                                                                                 |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `countDeployedWizardNodes` | publish `check_capacity`     | reads parent `infra/catalog/` tree; counts `type:node` + `source_repo`                       |
| `forkFromTemplate`         | publish `fork_from_template` | `POST /forks` of `node-template`, commits `.cogni/repo-spec.yaml` identity, enables Actions  |
| `openNodeSubmodulePr`      | publish `open_submodule_pr`  | commits catalog row + overlays + AppSets + Caddy + `source_sha` pin → opens the formation PR |
| review webhooks            | formation PR + node PRs      | `pull_request` → `PrReviewWorkflow` (review plane)                                           |
| `mergePr`                  | formation PR merge           | 🔴 the merge-authority chokepoint — **not wired yet**                                        |
| `ensureCatalogSourceSha`   | candidate / preview          | one-line catalog `source_sha` pin PR                                                         |
| `dispatchCandidateFlight`  | candidate flight             | `workflow_dispatch` `candidate-flight.yml` (needs `actions:write`)                           |

**Not the App:** the node repo's own `pr-build` builds its image with the repo-local `GITHUB_TOKEN` + `packages: write` — a separate plane (`BUILD_ONCE_PROMOTE_DIGEST`, fork sovereignty).

## Gates — built vs not

| Gate                                 | Stage                | Status                                                               |
| ------------------------------------ | -------------------- | -------------------------------------------------------------------- |
| `check_capacity` (pre-mint)          | publish              | ✅ built — counts catalog `type:node`+`source_repo` on parent `main` |
| review                               | formation PR         | ✅ built — `PrReviewWorkflow`                                        |
| `verify-buildsha`                    | candidate-a flight   | ✅ built — `/version.buildSha == sourceSha`                          |
| **merge gate** (allGreen ∧ capacity) | formation PR merge   | 🔴 not built — operator does not merge yet; a human does             |
| preview promote                      | node-merge → preview | 🔴 in flight                                                         |

## Shortcomings of the node lifecycle (read this before assuming a node is "managed")

Today a node is **created, gitops'd, and forgotten** — there is **no CRUD and no management plane**. The pieces are disjoint:

- **Three sources of truth that don't reconcile.** The operator `nodes` DB row (wizard working state, `status` from `dao_pending` to `active`), the parent **catalog** (`infra/catalog/*.yaml` on `main` = deploy registration), and the **running pods** (Argo) are independent. A `nodes` row says `published` whether or not the catalog row ever merged or any pod runs. The catalog count (capacity) measures registered/merged nodes — not what the DB thinks exists, not what's actually serving.
- **No update.** Once minted, there is no operator verb to rename, re-pin, re-scope envs, or change a node's identity through a management plane — it's hand-edited catalog/overlay PRs.
- **No delete / retract.** Closing a formation PR leaves an **orphaned mint**: the forked repo, the DoltHub knowledge repo, and the `nodes` DB row all persist, unregistered and undeployed, with no cleanup. There is no "decommission a node" path.
- **No list / status / health as data.** "Which nodes are deployed to which envs, at which SHA, healthy?" is reconstructed by hand from GitHub + GHCR + `/version` + Argo, not read from one place.
- **"Create + PR gitops + forget + pray."** The operator mints + opens the formation PR, then stops. A **human** holds the rest together: merges the PR, dispatches the flight, watches the rollout, and cleans up abandons. There is no autonomous owner of the node _after birth_.

### What closes this (direction, not a backlog)

The operator-local typed control plane — **`OperatorDeployPlanePort`** (`nodes/operator/app/src/ports/`, already on `main`; it owns candidate-flight dispatch today) — is the seam the management plane grows into. (An earlier read-only `DeployCapability` in `packages/ai-tools` is being consolidated into this one operator-local port, not kept as a second plane.)

- **Now:** flight dispatch (`prepareNodeRefCandidateFlight` / `dispatchNodeRefCandidateFlight`) + read state — the first place deploy actions are typed, not shell.
- **Next:** control verbs on the port — `promote` (prod, RBAC-gated `node.promote_production`), `promoteNodeToPreview` (the node-merge→preview tie), `retractNode` (git-revert the catalog row + clean the orphaned mint), `scaleNode` (overlay patch) — plus the **merge gate** moving onto `VcsCapability.mergePr` (merge-authority) so the operator owns the merge, not a human.
- **Then:** the three SSOTs converge onto one node-registry membership read, and the operator gains _awareness_ (health/status) so a node has an owner for its whole life, not just its birth.

Until those land, treat a wizard-born node as **born, not managed** — and expect to hold the post-birth steps by hand.

## See also

- [`node-wizard-expert`](../../.claude/skills/node-wizard-expert/SKILL.md) — orientation for wizard / formation work
- [`node-wizard-scorecard`](../../.claude/skills/node-wizard-scorecard/SKILL.md) — live launch execution + E2E proof
- [`node-ci-cd-contract.md`](../spec/node-ci-cd-contract.md) — the forward deployment contract (digest-addressed promotion)
- [`merge-authority.md`](../spec/merge-authority.md) — the operator-as-merge-authority design (the 🔴 merge gate)
- [`cicd-platform-boundary.md`](../spec/cicd-platform-boundary.md) — the deploy-brain freeze/route policy (typed control plane = `OperatorDeployPlanePort`)
- [`OperatorDeployPlanePort`](../../nodes/operator/app/src/ports/operator-deploy-plane.port.ts) — the operator-local typed deploy control plane
