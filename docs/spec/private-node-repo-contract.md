---
id: private-node-repo-contract-spec
type: spec
title: Private Node Repos & Sovereign node-template Contract
status: draft
spec_state: draft
trust: draft
summary: Phased plan for splitting nodes into private/sovereign repos. v0 forks Cogni's poly node into a private repo with its own VMs; the cogni monorepo is renamed; node-template becomes a real sovereign-fork quickstart.
read_when: Splitting a node into a private/sovereign repo, planning external-contributor onboarding, designing multi-tenant operator GH App, or evaluating shared-infra vs. own-VMs trade-offs for a node.
owner: derekg1729
created: 2026-05-07
last_updated: 2026-05-11
tags: [meta, deployment, sovereignty]
---

> **Status (2026-05-11):** Phase 0 substantially landed in a single day — see [As-Built §](#as-built-2026-05-11) below. The original spec was written when the operator monorepo was still named `Cogni-DAO/node-template`; that repo was renamed to `Cogni-DAO/cogni`, and a new public `Cogni-DAO/node-template` was created as the minimal quickstart fork. Where the prose below refers to "Cogni-DAO/cogni" you should read it as "the operator monorepo (post-rename)"; where it refers to the future minimal quickstart, that's now `Cogni-DAO/standalone-node`.
>
> **Update (2026-06-04):** the standalone quickstart was renamed `Cogni-DAO/node-template` → `Cogni-DAO/standalone-node`, freeing the `node-template` slug for a new **node-at-root submodule template** (a node minted via generate-from-template + added as a submodule into the operator). The Phase-0 history below still names the quickstart `node-template` — read those as `standalone-node`. See [node-ci-cd-contract](./node-ci-cd-contract.md) §Submodule-pinned nodes.

# Private Node Repos & Sovereign node-template Contract

## Context

Cogni's [Node vs Operator Contract](./node-operator-contract.md) defines node sovereignty as non-negotiable: a node must be forkable and runnable without any Cogni Operator account. Today the codebase ships in one repo (`Cogni-DAO/cogni`) which is misnamed — it IS the active multi-node monorepo (operator + resy + poly + a node-template fixture), not a template anyone would fork.

Two pressures force a structural change now:

1. **Cogni's poly node needs to go private.** Polymarket trading logic, target wallet research, and CLOB integrations are not appropriate for an open repo.
2. **External contributors need a real fork target.** "Cogni-DAO/cogni" implies a quickstart but currently delivers an entire multi-node monorepo with operator code, resy, and active development churn.

The current `single-node-scope` gate ([Node CI/CD Contract](./node-ci-cd-contract.md)) handles cross-domain PRs _within_ one repo. It does not address node-as-its-own-repo.

## Goal

Define a phased path from "single monorepo with all nodes" to "private/sovereign nodes can live in their own repos" that:

- Preserves [Node vs Operator Contract](./node-operator-contract.md) sovereignty invariants (FORK_FREEDOM, DEPLOY_INDEPENDENCE, WALLET_CUSTODY, etc.)
- Builds **zero new abstractions** in v0 — extracts no cross-repo deploy plane, no shared-k3s multi-tenancy, no multi-tenant GH App
- Surfaces real signal before designing the platform-grade abstractions of vNext
- Aligns Cogni's open-source + sovereignty story: forking `node-template` produces a complete, sovereign Cogni node — not a client of Cogni's operator service

## Core Invariants

1. **NODE_OWNS_OWN_BUILD**: A private/forked node's repo owns its own app + migrator image builds, schemas, and Dockerfile. The operator monorepo never reads a private node's source.
2. **NODE_OWNS_OWN_DEPLOY_STATE_v0**: In v0, a private/forked node owns its own k8s overlays, Argo CD, secrets, deploy branches, and VMs. No cross-repo deploy plane is built until Phase 3.
3. **NO_CROSS_REPO_INFRA_v0**: v0 builds zero new abstractions in `cogni` to support `cogni-poly` (no cross-repo dispatch lever, no shared k3s, no shared sops). Each repo is a complete, self-contained system.
4. **SOVEREIGN_FORK_QUICKSTART**: Forking `Cogni-DAO/cogni` produces a complete, sovereign Cogni node with its own VMs and infra — never a client of Cogni's hosted operator. Cogni Operator GH App is opt-in value-add (Phase 2+), not a runtime dependency.
5. **GHCR_IS_ORG_SCOPED**: `ghcr.io/cogni-dao/<image>` references survive repo rename. Image refs in overlays do not need updating when `node-template` → `cogni`.
6. **REPO_RENAME_SETTLES_BEFORE_REUSE**: `Cogni-DAO/cogni` cannot be recreated until GitHub releases the slug post-rename (~24h budget). Phase 0 sequences the new `node-template` quickstart fork after the settle window.
7. **OPERATOR_GH_APP_INSTALL_PER_REPO**: The same `cogni-node-template` GH App is installed on each repo it operates on (`cogni`, `cogni-poly`, future external nodes). Multi-tenant runtime support is Phase 2.

## Non-Goals

- **Multi-tenant operator GH App** — deferred to Phase 2. v0 keeps the operator agent single-tenant; a fork can hardcode its own repo identity if it wants its own AI engineering manager loop.
- **Operator-hosted node tenancy** (Railway-like) — deferred to Phase 3.
- **Per-node compute metering / billing** — deferred to Phase 4 (Akash north star).
- **Shared k3s + cross-repo deploy plane** — explicitly rejected for v0. v0 nodes that want privacy run their own VMs.
- **`packages/` extraction to a registry (npm / GH Packages)** — deferred. v0 vendors shared packages into the fork at fork time and accepts drift.

## Design

### Repo Topology

| Repo                          | Visibility | Contains                                                 | Forking it means                                                                                                       |
| ----------------------------- | ---------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **`Cogni-DAO/cogni`**         | Public     | Operator + resy + node-template fixture + all rails      | Active Cogni development. Self-host the entire Cogni platform.                                                         |
| **`Cogni-DAO/cogni-poly`**    | Private    | Poly only (single-node mono with full rails)             | Cogni's own production node — internal-only, sovereign of the open monorepo.                                           |
| **`Cogni-DAO/node-template`** | Public     | Minimal node skeleton + full rails (no operator, no biz) | "I want a sovereign Cogni node. My own VMs. My own secrets. Optionally opt into Cogni's AI engineering manager later." |

`Cogni-DAO/cogni` is the rename of the original `Cogni-DAO/node-template`. The `node-template` slug is then released by GitHub and reused for the new minimal quickstart fork.

### Onboarding Paths

| Path                                                 | When                                          | Sovereignty                                | Cost                              |
| ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------ | --------------------------------- |
| Add `nodes/<name>/` in `Cogni-DAO/cogni`             | Cogni-internal nodes, no privacy needs        | Shares Cogni's VMs, secrets, CI            | Lowest — default                  |
| Fork `Cogni-DAO/cogni`                               | External orgs / privacy-needing nodes         | Own VMs, own secrets, own CI               | 3 VMs (cand/preview/prod) + ops   |
| Fork `node-template` + install Cogni Operator GH App | Same as above, plus AI engineering management | Own infra, opt-in to operator capabilities | + GH App install (Phase 2 onward) |
| Cogni-hosted node tenancy                            | vNext (Phase 3)                               | None at infra layer                        | Pay Cogni                         |

### v0 Ownership Matrix (Cogni-poly)

| Asset                                | Owner                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Poly app + packages + schemas        | `cogni-poly` (private)                                                         |
| Poly app/migrator image builds       | `cogni-poly` CI → private GHCR (`ghcr.io/cogni-dao/cogni-poly-{app,migrator}`) |
| Poly k8s overlays + kustomize        | `cogni-poly`                                                                   |
| Poly runtime secrets (sops'd or env) | `cogni-poly`                                                                   |
| Poly deploy branches                 | `cogni-poly` (`deploy/<env>-poly` lives in its own repo)                       |
| Poly Argo CD                         | `cogni-poly`'s own k3s on `cogni-poly`'s own VMs                               |
| Poly's GH App (PR review etc.)       | Same `cogni-node-template` GH App, dual-installed on `cogni-poly` (Phase 1+)   |

**Each node is a complete, self-contained system.** No cross-repo deploy plane. No shared k3s. No shared sops.

### Why poly runs its own VMs in v0 (~$150-300/mo extra cost)

A shared-k3s, multi-source-Argo design would save the VM cost but requires building:

- A cross-repo dispatch lever (`cogni-poly` → `cogni`'s `promote-poly-digest.yml`)
- Cross-repo Argo creds (deploy keys for private repos on shared cluster)
- Secrets-sourced-from-elsewhere coupling (whose sops keys decrypt poly's secrets?)
- An operator-side abstraction for "deploy a remote node"

Building those for n=1 known node we control is premature. The right shape for that abstraction emerges only with n≥2 real consumers and a working multi-tenant GH App. v0's goal is decoupling, not optimization. Pay the VM cost; defer the design.

### Hardcoded Repo Identity (v0 simplification)

The operator agent today hardcodes one target repo (`Cogni-DAO/cogni`, soon `Cogni-DAO/cogni`). After fork, `cogni-poly` updates its own copy of those references to point at itself. Each repo's operator-agent instance manages its own repo. **No new "multi-repo operator" code in v0** — that's Phase 2.

### Phased Plan

#### Phase 0 — Decouple poly into private repo (THIS WORK)

| Step | Task                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1  | Land this spec                                                                                                                                                                                                 |
| 0.2  | Rename `Cogni-DAO/node-template` → `Cogni-DAO/cogni`                                                                                                                                                           |
| 0.3  | Update Argo `repoURL` in `infra/k8s/**/Application*.yaml`                                                                                                                                                      |
| 0.4  | Update hardcoded `Cogni-DAO/cogni` strings in scripts/docs (only where trivial)                                                                                                                                |
| 0.5  | Confirm GHCR refs unaffected (org-scoped — verified)                                                                                                                                                           |
| 0.6  | Wait for GH redirect to settle; create `Cogni-DAO/cogni-poly` (private, full history)                                                                                                                          |
| 0.7  | Strip `cogni-poly` to single-node: remove `nodes/{operator,resy,node-template}/`, prune root `packages/` to poly's transitive deps, vendor any cross-node packages, drop their catalog/overlay/secrets entries |
| 0.8  | Strip `cogni`: remove `nodes/poly/`, `infra/catalog/poly.yaml`, `infra/k8s/overlays/*/poly/`, `infra/k8s/secrets/*/poly*`, root `packages/poly-*` if any                                                       |
| 0.9  | Provision `cogni-poly`'s own VMs via existing `provision-test-vm.sh`                                                                                                                                           |
| 0.10 | Install `cogni-node-template` GH App on `cogni-poly`; set `GH_REVIEW_APP_*` env secrets in cogni-poly's environments                                                                                           |
| 0.11 | Wait for GH to release the `node-template` slug (~24h post-rename); create new `Cogni-DAO/node-template` (public, minimal fork of `cogni` stripped to node-template fixture + rails)                           |

Phase 0 is **decoupling, not platform-building.** Zero new platform code; the only edits are repo renames, file moves, and string updates.

#### Phase 1 — Validate the sovereign-fork model

- Document the fork-and-stand-up flow end-to-end using `cogni-poly` as the proof case
- Validate `node-template` quickstart: someone (Derek as proxy) forks it cleanly and stands up a working node from scratch
- Capture friction points; convert recurring ones into reusable workflows or scripts in `cogni`'s rails

#### Phase 2 — Multi-tenant operator GH App

- `operator_node_registrations` table + GH App installation webhook → auto-register
- Per-installation auth, per-node API keys, per-node DB tenancy
- Operator agent loop iterates registered installations rather than hardcoding one repo
- PR review + candidate-flight dispatch work cross-repo
- **Unblocks**: Cogni Operator becomes useful as an opt-in service for forked `node-template` users

#### Phase 3 — Operator-hosted node tenancy (Railway model)

- Multi-tenant k3s namespacing per registered `node_id`
- Self-service overlay scaffolding from a node repo's `node.yaml`
- Per-node secret-sync API (so external nodes aren't shipping secrets through Cogni's repo)
- **Unblocks**: External orgs can run nodes on Cogni-managed infra without self-hosting VMs

#### Phase 4 — Compute metering (Akash north star)

- Pod-level resource accounting per `node_id`
- Billing pipeline → `charge_receipts`
- Cogni-hosted nodes pay; sovereign-fork nodes don't

### As-Built (2026-05-11)

Phase 0 substantially landed in a single day. What follows captures actual outcomes vs the spec above, deviations, and decisions worth memorializing.

#### Phase 0 step-by-step outcomes

| Step | Outcome      | Notes                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1  | ✅ landed    | This spec, PR #1296.                                                                                                                                                                                                                                                                                                                           |
| 0.2  | ✅ done      | GitHub rename `Cogni-DAO/node-template` → `Cogni-DAO/cogni`.                                                                                                                                                                                                                                                                                   |
| 0.3  | ✅ done      | Argo `repoURL` updated to `cogni.git` (PR #1324).                                                                                                                                                                                                                                                                                              |
| 0.4  | ✅ done      | 103 files of slug-string rewrites in PR #1324; preview deploy verified post-merge.                                                                                                                                                                                                                                                             |
| 0.5  | ✅ verified  | GHCR refs survive rename; image names stayed `ghcr.io/cogni-dao/cogni-template` (legacy package name).                                                                                                                                                                                                                                         |
| 0.6  | ✅ done      | `Cogni-DAO/cogni-poly` created private, main pushed from cogni at SHA `e772342a`, tags included.                                                                                                                                                                                                                                               |
| 0.7  | ✅ done      | `Cogni-DAO/cogni-poly` PR #11 stripped non-poly nodes/services. PR #12 inlined `@cogni/node-template-knowledge` into `@cogni/poly-knowledge` (deviation from spec — see below). PR #13 was the post-strip cleanup pass.                                                                                                                        |
| 0.8  | ⏳ deferred  | Strip `nodes/poly` from `cogni`. **Blocked on data migration** (postgres + doltgres from cogni's prod VM → cogni-poly's new prod VM) **and DNS cutover** (`poly.cognidao.org`).                                                                                                                                                                |
| 0.9  | 🟡 in-flight | Provision `cogni-poly`'s own production VM. **Scope deviation:** spec said "all 3 envs"; v0 minimal does production only (preview + candidate-a deferred until needed).                                                                                                                                                                        |
| 0.10 | 🔴 skipped   | Install `cogni-node-template` GH App on `cogni-poly`. **Skipped for v0** — Derek decision: "we don't need the gh app right now; we won't really use the operator yet." Phase 2 work, not v0.                                                                                                                                                   |
| 0.11 | ✅ done      | `Cogni-DAO/node-template` created public. Initial mirror from cogni-poly was rerooted: node-template now forks `Cogni-DAO/cogni` directly (upstream = cogni) with strip + cleanup as a single commit. Lineage decision: cogni-poly stays totally independent + private; node-template has cogni as upstream and can `git merge upstream/main`. |

#### Deviations from spec

1. **No vendoring.** Spec step 0.7 said: "prune root `packages/` to poly's transitive deps, vendor any cross-node packages." We did the opposite — `cogni-poly` keeps ALL shared `packages/` as-is, no pruning, no vendoring. Derek directive: "no overengineering anything vendored." Drift between cogni's `packages/` and cogni-poly's `packages/` is accepted; the schema-drift mitigation is manual discipline (only ~190 lines of knowledge schema lives in the shared base).
2. **Inline pattern for the single cross-node shared package.** `@cogni/node-template-knowledge` lived under `nodes/node-template/packages/knowledge/` and was imported by poly. After the strip removed `nodes/node-template/`, the four imports were inlined into `@cogni/poly-knowledge` rather than carving out a new shared `packages/knowledge-base/`. Single-tenant repo doesn't need a shared base. Same pattern should NOT propagate to `cogni` (multi-node — operator + resy + node-template still share). Closed by [task.5047](https://cognidao.org/work/items/task.5047) (cogni PR #1335): `@cogni/node-template-knowledge` → `@cogni/knowledge-base` at `packages/knowledge-base/`.
3. **GitHub redirect settled in minutes, not 24h.** Spec budgeted 24h for the slug to be reusable. Empirically it was reusable same-day. Future renames can compress the schedule.
4. **node-template lineage = fork of cogni (not mirror of cogni-poly).** Two-commit history: a snapshot marker pointing at cogni's `17d0153f`, then a single "strip cogni → single-node node-template + post-strip cleanup" commit. `git merge upstream/main` from cogni works naturally because the only divergence is the stripped paths (`nodes/{operator,poly,resy}`, `services/scheduler-worker`).
5. **cogni-poly's CICD lives in cogni-poly.** No cross-repo dispatch. `cogni-poly`'s `pr-build`, `flight-preview`, etc. run on cogni-poly's own GitHub Actions and write deploy-branch commits back to cogni-poly's main. Argo CD on cogni-poly's own VMs reads cogni-poly's git. Zero cross-repo coupling — matches `NO_CROSS_REPO_INFRA_v0`.

#### Drift cliff observed

The day of the rename, a real poly trading fix landed in `cogni`'s main: `c08c95e8` "fix(poly): tighten mirror resting TTL 20 min → 2 min" (#1326). Because step 0.8 has not yet landed, `cogni` still owns a copy of `nodes/poly/`, and contributors continued working there. This required a manual forward-port to `cogni-poly` (cogni-poly PR #14). A drift-watcher task is open until step 0.8 lands and `cogni` no longer has any `nodes/poly/`.

#### v0 reality vs the "shared infra for private repos" intention

Today's v0 architecture is **per-repo independent VMs** for any private node. `cogni-poly` runs on its own production VM, its own postgres, its own doltgres, its own Argo CD, its own secrets — completely independent of `cogni`'s deployment plane. This is what the original spec described under "Why poly runs its own VMs in v0".

**This is NOT a permanent architectural ceiling.** Cogni's operator product vision FULLY intends to support external + private git repos consuming shared Cogni infrastructure as a hosted service. That's the Phase 2 + Phase 3 work below. Today the operator agent hardcodes a single target repo, so cross-repo operator features (PR review, candidate-flight dispatch, multi-tenant deploy plane) aren't yet possible — even though the codebase to do so exists in `cogni`.

If a future external operator-tenant arrives before Phase 2 ships, the bridge is independent VMs (the same v0 path `cogni-poly` is taking). Once Phase 2 (multi-tenant operator GH App) and Phase 3 (operator-hosted node tenancy) land, sovereignty-preserving external/private repos can opt into shared infra without the per-VM cost.

#### Lessons learned (for future strips)

1. **Dep-cruiser layer enforcement has a `nodes/operator/app` regex hardcode.** PR #13 hit a "blanket-pass for non-operator nodes" rule that meant poly inherited no enforcement after strip. Fix: tighten to `nodes/[^/]+/app` so any single-node repo gets uniform enforcement. node-template's reroot incorporated this fix.
2. **Build-order race in `tsc -b`.** When the inlined `@cogni/poly-knowledge` lived under `nodes/poly/packages/`, alphabetical processing meant `doltgres-schema` typechecked before `knowledge` emitted its `.d.ts`. Fix: explicit `references` array in the dependent's tsconfig. Doesn't recur in node-template (different alphabetical layout).
3. **Image identity rebrand is ~22 files** across workflows, k8s overlays, Argo, compose, Terraform, sonar, REUSE. Worth doing in one PR with a clear narrative; partial rebrands ship broken CI.
4. **Test fixtures coupled to deleted nodes' file paths must be deleted, not "fixed"**. cogni-poly's PR #13 deleted ~3 fixture-reading tests + 1 cross-node fixture rather than rewriting them — correct call, those tests were testing operator/multi-node behavior that doesn't apply.

### Repo-Rename Mechanics

GitHub auto-redirects all references from old → new slug after rename. The redirect occupies the old slug, but GitHub releases it after a brief settle period (empirically ~minutes to a few hours; budget 24h to be safe before reusing).

| Step | Action                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| R.1  | UI rename `Cogni-DAO/node-template` → `Cogni-DAO/cogni`                                                                                        |
| R.2  | PR in `cogni` updating Argo `Application.spec.source.repoURL` to `Cogni-DAO/cogni`                                                             |
| R.3  | Audit + update hardcoded `Cogni-DAO/cogni` strings in scripts, docs, env-config                                                                |
| R.4  | Update PR/branch references in any pinned GitHub Actions URLs                                                                                  |
| R.5  | Re-test candidate-flight + promote-and-deploy on `cogni`                                                                                       |
| R.6  | After settle, attempt to create `Cogni-DAO/node-template`. If blocked, escalate via GH support or use interim name `node-template-quickstart`. |

GHCR image refs are org-scoped (`ghcr.io/cogni-dao/<image>`), unaffected by repo rename. ✅

### Cross-references

- [Node vs Operator Contract](./node-operator-contract.md) — sovereignty invariants this spec preserves
- [Node CI/CD Contract](./node-ci-cd-contract.md) — `single-node-scope` gate applies within a single repo; this spec extends the model to single-node repos
- [VCS Integration spec](./vcs-integration.md) — `operator_node_registrations` schema referenced in Phase 2
- [Identity Model](./identity-model.md) — `node_id` semantics

## Acceptance Checks

**Phase 0 done when:**

- [x] `Cogni-DAO/cogni` exists; `Cogni-DAO/node-template` redirect was broken on purpose when the slug was reused for the new quickstart (acceptable: internal refs were updated in PR #1324)
- [x] `Cogni-DAO/cogni-poly` exists, private, full history, single-node mono
- [ ] `cogni-poly` has its own running VMs across all 3 envs; flighted at least one PR end-to-end _(in flight — production VM only for v0, preview + candidate-a deferred)_
- [ ] `cogni` no longer contains any `poly` directories or catalog/overlay/secret entries _(step 0.8, blocked on data migration)_
- [x] `cogni` candidate-flight + promote-and-deploy still green on a representative PR (verified by post-#1324 preview deploy)
- [x] New `Cogni-DAO/node-template` exists, public, minimal — quickstart README works for a clean fork

**Sovereignty preserved (manual):**

- [ ] `cogni-poly` runs `docker compose up` (or `provision-test-vm.sh` + Argo) without any reference to `cogni`'s infrastructure or accounts
- [ ] `cogni-poly`'s deploy state lives entirely within `cogni-poly`'s git
- [ ] `cogni-poly`'s runtime secrets are owned by `cogni-poly`'s GitHub Environments

## Open Questions

- **Vendoring strategy for shared `packages/`** — at fork time, which packages get vendored and which remain root-shared until vNext extraction? Proposal: any package poly's `nodes/poly/app` or `nodes/poly/graphs` imports gets vendored into `cogni-poly/packages/`. Resolves at fork-execution time.
- **Phase 2 GH App rename** — should `cogni-node-template` GH App be renamed to `cogni-operator` to match its actual role? Touches `appId` (no), `installationId` (no), but does touch UI displays + permission grants. Defer the rename to when Phase 2 ships.
- **`single-node-scope` gate semantics in single-node repos** — the gate becomes a no-op in `cogni-poly`. Either delete the workflow there or keep it as a self-validating check that the repo really is single-node. Lean: keep + simplify.

## Related

- [Node vs Operator Contract](./node-operator-contract.md)
- [Node CI/CD Contract](./node-ci-cd-contract.md)
- [VCS Integration](./vcs-integration.md)
