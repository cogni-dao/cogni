---
id: spec.node-ci-cd-contract
type: spec
title: Node CI/CD Contract
status: active
trust: reviewed
summary: CI/CD sovereignty invariants, merge gate checks, workflow entrypoints, and file ownership classification
read_when: Modifying CI workflows, adding checks to merge gate, or planning multi-node CI extraction
implements: []
owner: cogni-dev
created: 2025-12-22
verified: 2026-04-28
tags:
  - ci-cd
  - deployment
---

# Node CI/CD Contract

## Context

Node sovereignty is non-negotiable. CI must run from repo with zero operator dependencies. This spec defines what checks are required, which files are node-owned vs rails-eligible, and the ownership split between orchestration and policy.

## Goal

Define the CI/CD invariants, merge gate, and file ownership boundaries that ensure every node can run its full pipeline independently.

## Non-Goals

- Reusable workflow extraction (see [proj.ci-cd-reusable](../../work/projects/proj.ci-cd-reusable.md))
- Jenkins migration (gated on Dolt CI/CD requirements)

---

## Core Invariants

1. **FORK_FREEDOM**: CI runs without secrets; CD (build/deploy) is gated and skippable on forks.

2. **POLICY_STAYS_LOCAL**: ESLint/depcruise/prettier/tsconfig never centralized.

3. **LOCAL_GATE_PARITY**: `pnpm check` runs same assertions as CI, different execution (sequential vs parallel).

4. **NO_RUNTIME_FETCHES**: Workflows never fetch config from outside repo.

5. **SCRIPTS_ARE_THE_API**: Workflows orchestrate by calling named pnpm scripts; no inline command duplication. Targets logic _duplicated across ≥2 workflows_ — that must live in `scripts/` to prevent drift. Gate-specific inline policy that is small, unique to one workflow, and pinned by a meta-test is allowed; the `single-node-scope` job in `ci.yaml` is the canonical example.

6. **BUILD_ONCE_PROMOTE_DIGEST**: Images build on canary. Staging and production deploy the exact same digests. No per-environment rebuilds.

7. **SINGLE_RESPONSIBILITY**: Each workflow file owns one concern (build, promote+deploy, E2E+release). No monoliths.

8. **SINGLE_DOMAIN_HARD_FAIL**: PRs may touch exactly one node's domain. Each non-operator node owns `nodes/<X>/`; the operator node owns `nodes/operator/` plus everything else in the repo (infra, packages, .github, docs, work, scripts, root configs) as one domain. Cross-domain PRs are rejected by the `single-node-scope` job in `ci.yaml`. Bounded ride-along whitelist: `pnpm-lock.yaml` (mechanical side-effect of node-level `package.json` changes), `work/**` (per-task work items, projects, charters; ride-along until task tracking moves to Dolt), and `docs/**` (cross-cutting prose that accompanies a node change) may ride a single non-operator node PR. See `## Single-Domain Scope` below.

---

## Single-Domain Scope

Every path in the repo belongs to **exactly one node domain**. A PR may touch exactly one domain. This invariant is enforced statically by the `single-node-scope` job in `ci.yaml` (task.0381), and at review-time by `PrReviewWorkflow` via `extractOwningNode` (resolver: task.0382; consumer: task.0410). The reviewer fetches per-node rule files from `<owningNode.path>/.cogni/rules/` (resolved via `resolveRulePath` — single source of truth in `@cogni/repo-spec`), refuses cross-domain PRs with a diagnostic comment + neutral check (no AI tokens spent), and emits a structured `review.routed` log. Both implementations consume the same set of fixtures and must agree.

> **Routing-vs-policy principle.** Review **routing** is shared infrastructure (`packages/temporal-workflows`, `@cogni/repo-spec`). Review **policy** — rules, prompts, model selection — is per-node (`nodes/<X>/.cogni/`). Routing code never special-cases a particular node by string compare; the operator domain ships its rules at `nodes/operator/.cogni/rules/` like every other node. New review knobs land per-node first; promotions to shared infra require a spec update.

### Domains

```
4 disjoint domains. PR scope = exactly 1 column.

  ┌─────────────────────────────────────────────────────────────┐
  │  poly         resy         node-template       operator     │
  │  ────         ────         ─────────────       ────────     │
  │  nodes/poly/  nodes/resy/  nodes/node-tmpl/    nodes/opr/   │
  │                                                  ∪          │
  │                                                EVERYTHING   │
  │                                                ELSE         │
  │                                                (packages/,  │
  │                                                 infra/,     │
  │                                                 .github/,   │
  │                                                 docs/, …)   │
  └─────────────────────────────────────────────────────────────┘
```

The operator node's domain is broader because the operator IS the control plane — it owns the substrate every other node consumes. But it is still **one** domain, not an exemption.

### Rule

```
domain(path) = X         if path matches  nodes/<X>/**  for X ∈ {poly, resy, node-template}
             = operator   otherwise   (i.e., nodes/operator/** OR anywhere outside nodes/)

PR passes iff |distinct domains touched| ≤ 1, with the bounded ride-along whitelist below.
```

The set of non-operator domains is derived from the `nodes/*` directory listing minus `operator` — meta-tested in `tests/ci-invariants/single-node-scope-meta.spec.ts`. The repo-spec `nodes` registry must mirror the same set (enforced at the resolver boundary; meta-test asserts both directions). Adding `nodes/<X>/` requires updating the workflow filter list AND the registry — both meta-tests fire until they agree.

The dorny step must set `predicate-quantifier: 'every'` so the operator filter's `**` + `!nodes/<X>/**` negations actually subtract; under the default `some` quantifier the rules are OR'd and the negations are dead, which silently misclassifies every non-operator-node-only PR as that node + operator. Pinned by `single-node-scope-meta.spec.ts`.

### Ride-along exceptions

If `|S| = 2`, `operator ∈ S`, and **every** path matched by the operator filter is in the ride-along whitelist, the operator paths inherit the other domain and the PR passes.

Whitelist (must mirror `RIDE_ALONG_PATTERNS` in `tests/ci-invariants/classify.ts` and the inline `run:` block in `ci.yaml#single-node-scope`):

| Pattern          | Why                                                                                         | Long-term fix                                                             |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm-lock.yaml` | Mechanical side-effect of node-level `package.json` intent — not intent itself.             | Per-node lockfiles via pnpm `shared-workspace-lockfile=false`.            |
| `work/**`        | Per-task work items + projects + charters + auto-regenerated `_index.md`; high churn today. | Move task tracking to Dolt; `work/` empties out and exits the list.       |
| `docs/**`        | Cross-cutting prose that accompanies a node change (spec touch-ups, guide pointers).        | Migrate node-scoped docs into `nodes/<X>/docs/`; only operator docs left. |

Each entry has an explicit long-term fix that ends the ride-along. The whitelist is a v0 unblock, not a permanent carve-out — adding to it weakens the gate, so do so deliberately and pair the addition with the exit plan that drains the entry.

**Operator paths NOT in the whitelist (`.github`, `packages`, `infra`, `scripts`, root configs) do not ride along.** They are intent. A `poly` PR that needs an operator-spec change is two PRs, not one — that's the design.

### Why Reading A (operator-is-a-domain) over Reading B (operator-is-an-exemption)

The early flood of "node X needs operator change Y" PRs is the **substrate-request signal**, not noise. Each rejection by the gate is a row in operator's prioritization queue ("which seams are load-bearing? which need first-class APIs?"). Weakening the gate to absorb the friction loses that signal — operator never learns which substrates contributors actually push on. Same framing as the noisy-neighbor / attribution thesis: the boundary is where the test happens, not where the test is suppressed.

Sovereignty contracts only hold when the false-positive cost is accepted. Carving "reasonable exceptions" for the common case is the standard failure mode — within a year the boundary is theater. The ride-along whitelist is bounded specifically because each entry covers mechanical side-effects or transitional storage that is migrating out (work items → Dolt), not intent that belongs in operator's domain.

### Rejected — Reading B (operator-is-an-exemption)

`nodes/operator/**` and `packages/**`, `.github/**`, etc. classify as "infra" that rides along any single sovereign node. Rejected because **operator paths are intent, not side-effect; intent doesn't ride along.** A `poly` PR that needs an operator change is two PRs, not one — that's the design.

### Diagnostic contract — when the gate fires

Cross-domain rejections must do half the contributor's work in the failure annotation:

1. **Name the conflicting domains** explicitly (e.g., `poly + operator`, not just "scope error").
2. **Name the operator-territory paths** that triggered the operator domain match, when operator is one of the conflicting domains. The contributor needs to know which file they touched is "operator's intent."
3. **Suggest the split**: "file an operator PR with `<paths>` first; rebase your `<other-domain>` PR on it."
4. **Link the substrate-request convention** so the rejected change becomes a roadmap input rather than dropped friction. (Convention TBD; until it lands, link this spec section.)

Each gate firing is a feedback loop, not a barrier. Future: rejections logged structurally (Loki, work-item, attribution surface) so operator's roadmap-building agent reads the queue.

---

## Submodule-pinned nodes (new-node births)

New nodes are born as **git submodules** at `nodes/<slug>` — a node-template fork the operator pins by SHA — not inline-copied into the monorepo. **New nodes only**: `operator`, `resy`, `poly`, `node-template` stay inline. At scale (50+ nodes) inline-copy is ~1100 files/node of clone bloat; the submodule boundary lets a node dev clone only their node repo as its own Conductor Project while the operator clones the thin parent and selectively inits the one node it operates on. Full rationale + the keeper-vs-tax decomposition of the inline wizard (#1462) live in knowledge conclusion `submodule-node-birth-design` — not restated here.

### Plain-English authority model

The model is good only if the boundary stays this simple:

| Plane                   | Owner                                                      | Must not do                                                                                       |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Node repo**           | Node developer / node agents                               | Own shared-operator VM state, Argo, DNS, preview/prod promotion, or operator deploy branches      |
| **Operator monorepo**   | Operator                                                   | Rebuild submodule-node source, invent node policy, or use GitHub repo permissions as product auth |
| **GitHub App identity** | Environment-scoped automation credential                   | Decide who is allowed to flight; it only proves the operator has the mechanical ability to act    |
| **Operator API / DB**   | Authorization boundary for flight/publish/promote requests | Delegate authorization to "who can push to a GitHub repo"                                         |

So: node-template repos carry **CI + image build**, not hosted flight/deploy
workflows. Hosted flight is an operator action because it mutates operator-owned
environment state: deploy branches, Argo applications, DNS, OpenBao/ESO, and
candidate/preview/production provenance. A node repo may include a small
"request flight" client or documentation, but not the workflow that performs
the flight against a shared operator environment.

This keeps Cogni an OSS foundation instead of a platform trap: node repos remain
portable and self-verifying; the shared operator is just one deploy host. A node
that wants to own its deploy plane uses `standalone-node`, not the submodule
template.

### Flight permission model

Do **not** use GitHub repository permission as the product authorization model.
GitHub permissions answer "can this App/API token do the mechanical GitHub
operation?" They do not answer "should this agent be allowed to mutate this
Cogni environment?"

Flight authorization is operator-local:

1. Caller authenticates to the operator API as a human/session or bearer agent.
2. Operator checks a Cogni capability, not GitHub membership. v0 can be a narrow
   allowlist/capability row: `principal -> node_slug -> environment -> action`
   with TTL. v1 can become org membership/RBAC.
3. Operator verifies objective gates before dispatch:
   - node exists in the operator registry/catalog;
   - requested `sourceSha` exists in the registered node repo;
   - child `.cogni/repo-spec.yaml` at that SHA matches the node identity;
   - GHCR has `image_repository:sha-<sourceSha>`;
   - requested env is allowed for that principal (`candidate-a` first;
     preview/prod require stronger gates).
4. Operator dispatches with its environment GitHub App. The App is a capability
   executor, not an authorization oracle.

Until real RBAC lands, the safe Pareto default is: any registered agent may
request **candidate/test** flight for the node/work item it owns; preview/prod
remain human-approved operator actions. This avoids relying on GitHub repo
permissions while still stopping arbitrary agents from mutating arbitrary
environments.

### SUBMODULE_GITLINK_IS_OPERATOR_PIN

A change to a `nodes/<slug>` **submodule gitlink** (the pinned-commit pointer) classifies as **operator-domain**, not node-domain. The pointer is the control plane's _pin_; the node's _code_ was reviewed in the node repo's own PR queue. So the deploy PR — gitlink bump + the node's catalog/overlay/appset rows — is **one operator-domain change**, not a cross-domain rejection. Without this rule the bump touches `nodes/<slug>` (node) + `infra/` (operator) → `|S| = 2` → rejected by the gate. The operator filter's `!nodes/<slug>/**` negation must **not** subtract a submodule gitlink — only a real in-tree node directory is node-domain.

This holds **structurally** in `classify.ts`: a bare `nodes/<slug>` gitlink has no trailing path segment (`slash > 0` is false), so it falls through to operator-domain — and so do its catalog/overlay/appset rows, because a submodule slug is a gitlink, not an inline `nodes/*` directory, hence absent from the non-operator-node set. Pinned by the `single-node-scope` parity fixture `19-submodule-gitlink-operator-pin.json` (gitlink + `.gitmodules` + catalog + overlays×3 + appset → one operator domain, `pass: true`). The regression guard is a comment on the `slash > 0` branch in `classify.ts`.

### Two CI models — do not conflate

| Concern                            | Inline node                                  | Submodule node                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge gate (unit/component/static) | operator monorepo CI, shared root configs    | the node repo's **own** `ci.yaml` (node-template fork — `FORK_FREEDOM` + `setup-main-branch.sh` apply)                                                                                                                                                                                                                                                                                                                                                                     |
| `POLICY_STAYS_LOCAL`               | shared root policy                           | own policy copies — drift is by-design sovereignty                                                                                                                                                                                                                                                                                                                                                                                                                         |
| operator's job                     | full gate + `single-node-scope` split        | pointer-validate + provision + flight + promote                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ci.yaml` scope filter             | `nodes/<X>/**` entry + operator `!` negation | **no** scope filter — `render-scope-filters.sh` skips submodule slugs (keyed off `.gitmodules`). A generated `nodes/<slug>/**` filter is **not** harmless: picomatch's globstar matches the bare gitlink `nodes/<slug>`, so the pin misclassifies as node-domain (`MATCHED: ["<slug>", "operator"]` → false cross-domain reject). With no filter, the gitlink falls to operator's `**`. The `nodes/*` ↔ filter mirror meta-test applies the same `.gitmodules` exclusion. |

### The node is a sovereign repo, not operator-built content (two views)

The node has **its own `.github/workflows/` and runs its own CI** — _and_ it is **`nodes/<slug>` only** from the operator. Both are true; they are two views of one object, not a contradiction:

- **Node-repo view (the node-dev's clone).** A submodule node is a _full standalone repo_ with the node **at its root**: `app/`, `graphs/`, `k8s/`, `packages/`, plus its **own** `.github/workflows/ci.yaml`, biome/tsconfig/Dockerfile, and the `setup-main-branch.sh` gate. The node-dev clones _only_ this repo, runs the full merge gate there, and **builds + pushes its own image** to GHCR (`FORK_FREEDOM`). This sovereignty is the entire reason the submodule model exists. For the product/package shape of that root-level node repo, see [Node Backend-as-a-Service Architecture](./node-baas-architecture.md).
- **Operator view (the monorepo).** The operator sees a `nodes/<slug>` **gitlink — a pointer**, not content. Even after `git submodule update --init nodes/<slug>`, the node's root `.github/workflows/` lands at `nodes/<slug>/.github/workflows/`, which **GitHub never executes** (only _repo-root_ `.github/workflows/` run). So the operator monorepo **never runs the node's workflows and never builds the node** — its job is exactly the table above: pointer-validate + provision + flight + promote the node's _pre-built_ image.

**Corollary that breaks today's pin-PR (P0).** Because the node builds itself, the operator's `detect-affected.sh` must **exclude the gitlink from build targets** — a `build (<slug>)` leg on the parent is always wrong. The operator consumes the node's image by **digest** (catalog `repo`+`ref` pin), never by rebuilding source.

> **Rejected — "content-only nodes built by the operator" (`nodes/<slug>/*` with no workflows).** That collapses sovereignty: the operator would have to check out + build every node, re-coupling to node code and forfeiting independent per-node CI — exactly the inline tax (#1462) the submodule model removes. The node's code lives _and is built_ in its own git boundary; the operator carries a pointer + a catalog row, nothing more.

### Public + private node repos

The model works for both; only the **clone/pull credentials** differ — never the topology.

- **Public node repo.** Submodule init + image pull need no auth.
- **Private node repo.** Two credentialed paths, both already satisfied because the operator App **minted** the repo (and is installed all-repositories on the mint org):
  1. **Selective submodule init** (the `nodes/<slug>/.cogni/` walks: provisioning, `secrets-catalog-loader.ts`, the review router) authenticates with the operator App's installation token (`contents:read` on the node repo) over the HTTPS `.gitmodules` URL — never an anonymous clone.
  2. **Image pull** for deploy uses GHCR pull creds for the node's package, independent of git. Deploy needs the _image_, not the source, so a private node never requires the operator to check out its tree at deploy time (discovery stays metadata-driven via the catalog row).

The node's **own** CI (private repo) builds + pushes with its repo-scoped `GITHUB_TOKEN` → its private GHCR package; no cross-repo secret sharing. The single invariant: whatever org holds private node repos, the operator App is installed there with `contents:read` — which the mint flow already guarantees.

### Discovery is metadata-driven, not filesystem-driven

A submodule node's app tree is absent from the operator build/runtime image (the runtime ships only the operator's own `.cogni`; no `infra/catalog`), so it can never be discovered by walking `nodes/*`. It registers exactly like an inline node: its **catalog row** — committed in the operator pin PR, present even when the submodule is not checked out — projects to the operator `nodes` table and renders via **`NodeRegistryPort`** ([proj.agent-registry](../../work/projects/proj.agent-registry.md), #1492). **Submodule-ness is a catalog/CI concern** (a `repo` + `ref` pin on the catalog row), invisible to `NodeRegistryPort` consumers; a submodule node is still `NodeSummary.kind: full-app`. The #1492 v0 static `nodes.data.ts` adapter is itself a per-node manual-step tax and does not scale — submodule births at scale depend on the v0.1 DB-projection adapter landing behind the same port.

### Template taxonomy — three repos by integration model (not by node kind)

A node's **integration model** (how it attaches to the operator) picks its template repo; its `NodeRegistryPort` kind is orthogonal.

| Template repo                                              | Integration                                                                       | `NodeSummary.kind` | Status               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------ | -------------------- |
| `Cogni-DAO/standalone-node` (renamed from `node-template`) | fork the whole near-monorepo → run your own sovereign Cogni                       | `full-app`         | live (sync artifact) |
| new node-at-root submodule template                        | `generate` → `submodule add` at `nodes/<slug>` in the shared operator             | `full-app`         | this design          |
| agent-scope template (langgraph + dolt only)               | submodule within the registry node; "launch an AI dev in a fresh scope-only repo" | `agent-scope`      | vFuture              |

Two `full-app` templates differ **only by integration** (fork-whole vs submodule); `agent-scope` is a third, minimal template (no Next.js app, just agent packages + Dolt migrations). Submodule-ness stays invisible to `NodeRegistryPort` consumers (a catalog `repo` + `ref` pin) — discovery is metadata-driven (above). The renamed `standalone-node` is **not** the submodule template: a fork-whole repo nests the node at `nodes/node-template/`, but a submodule must expose the node **at its root** so it lands at `nodes/<slug>/app`. That layout difference is why the submodule template is a distinct repo, not a reuse.

### Where the line is between the three repos — the deploy/infra plane

All three repos carry the node **app + its merge-gate CI + image build**. They differ on **one axis: how much of the deploy/infra plane they carry.**

| Repo                                        | Node app                                  | Node CI (merge-gate + build→GHCR)    | Deploy/infra plane¹      | Who deploys it                                           |
| ------------------------------------------- | ----------------------------------------- | ------------------------------------ | ------------------------ | -------------------------------------------------------- |
| **cogni monorepo**                          | operator + inline nodes (`nodes/poly`, …) | yes (shared root configs)            | **owns it — every node** | itself                                                   |
| **standalone-node** (fork-whole)            | node nested at `nodes/node-template/`     | yes                                  | **yes — you self-host**  | itself (you _are_ an operator)                           |
| **node-template** (submodule, node-at-root) | node at repo root                         | **yes — own `ci.yaml` + build→GHCR** | **no**                   | the shared operator (pin → provision → flight → promote) |

¹ Deploy/infra plane = `provision-env`, Argo AppSets + k8s overlays, `deploy-infra`, `candidate-flight`, OpenBao/ESO substrate, the operator app, `infra/catalog`, root monorepo tooling.

**The line is the deploy/infra plane.** `standalone-node` has it (it runs its own Cogni); `node-template` does **not** (the shared operator runs its node). Both keep node-level CI — non-negotiable: a submodule node **builds its own image in its own repo** (`FORK_FREEDOM` / P2 above). A `node-template` with _no_ CI would force the operator to build node code — the rejected content-only model. So `node-template` is **standalone-node minus the deploy/infra plane**, re-rooted so the node sits at repo root.

**What `node-template` carries vs. omits:**

| Carries (node-level, sovereign)                                                                                                  | Omits (the operator owns these)                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `app/ graphs/ packages/` + `k8s/` **base** manifests (the node's own Deployment/Service)                                         | per-env **overlays + AppSets + catalog row** — generated into the operator monorepo by the pin-PR |
| `.github/workflows/ci.yaml` (merge gate) + the build→GHCR workflow                                                               | `provision-env`, `deploy-infra`, `candidate-flight`, Argo, OpenBao/ESO substrate                  |
| **`.cogni/rules/` + the review gate** (so a PR in the node repo routes + reviews via the node's own rules — **born-reviewable**) | the operator app, `infra/catalog`, root monorepo tooling                                          |
| `biome/ tsconfig/ Dockerfile / .dependency-cruiser.cjs` + `setup-main-branch.sh` (`POLICY_STAYS_LOCAL`)                          | —                                                                                                 |

> **Born-reviewable (the `ay` gap).** A minted node must ship its own `.cogni/rules/` + review gate, or a PR in it routes to _nothing_ — the failure observed on the first mint (`cogni-test-org/ay`), where the review bot triggered but had no node-local rules to apply. The P1 projection must carry these from the canonical node, not just `app/`.

**Derivation (this is P1).** `node-template` = the canonical node source in the cogni monorepo (`nodes/node-template/{app,graphs,k8s,packages}`) **projected to repo root**, plus the node-level CI/policy, **minus the deploy/infra plane**. The projection is path-identical (the sync feature `detect-sync-drift.mjs` lacks; #1366); the omit-column above _is_ the projection's exclusion list. This keeps `node-template` in lockstep with the canonical node without ever shipping it the operator's plane.

### Node-dev vs operator split — adding a secret or service to a submodule node

A submodule node-dev carries CI but **not** the deploy/infra plane, so the monorepo guides ([create-service](../guides/create-service.md), [secrets-add-new](../guides/secrets-add-new.md)) split into a **node-dev half (declare _shape_ in your repo)** and an **operator half (the plane _provisions_ it)**. The node-dev never edits `infra/catalog`, runs `provision-env`, or touches Argo — those are the operator's. `node-template` ships a node-scoped `AGENTS.md` pointing at exactly the node-dev half below; the full guides stay the operator's reference.

| Task              | Node-dev does (in their repo, their CI)                                                                                                                                            | Operator's plane does                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add a secret**  | Declare the key's _shape_ in `.cogni/secrets-catalog.yaml` (node-domain). Consume it via typed env in app code (fail-fast if missing).                                             | Selective-init reads the catalog → generates the ExternalSecret + OpenBao path. **Value** is set with `pnpm secrets:set <env> <slug> <KEY>` by whoever holds that env's OpenBao writer role — the env owner (a self-host node-dev on their own env; the operator on an operator-hosted env, or a node-dev granted the env-writer role). |
| **Add a service** | App code + `Dockerfile` + k8s **base** manifest (Deployment/Service) + a catalog entry + the **build→GHCR** workflow leg, all in the node repo. Node CI builds + pushes the image. | The pin-PR / provision generates the per-env **overlay + AppSet + catalog row** referencing the pushed digest; Argo deploys it.                                                                                                                                                                                                         |

**Invariant: the node-dev declares shape in-repo; the operator's plane consumes it.** A new secret or service is **one edit in the node's own repo + its own CI** — never a monorepo PR. The value-set + deploy wiring belong to whoever owns the env. This keeps `secrets-add-new` / `create-service` correct verbatim for a **self-host** node (it owns its plane) and cleanly halved for a **submodule** node (operator owns the plane half).

### Forward path to deployment (Pareto-ordered)

The submodule **birth** is as-built (#1506): the wizard mints the node repo as a named fork of node-template (`GitHubRepoWriter.forkFromTemplate` → direct identity commit to the new repo's `main`, no PR there) and the operator authors **one** pin-PR (`openNodeSubmodulePr` — a `160000` gitlink at `nodes/<slug>` + `.gitmodules` + the `gens/` footprint **minus the lockfile importer**, the only inline-only tax a submodule node sheds). The fork preserves a shared merge base with node-template, so spawned nodes can fetch and merge future template updates instead of manually porting unrelated histories. Proven E2E on candidate-a (2026-06-04): wizard Publish → minted node repo + pin-PR into the operator monorepo + review-bot trigger. What remains to carry a born node through **deploy → preview/prod** is the ordered list below. **P0 + P1 are the critical ~20%** — without them nothing merges or builds; **P2–P4 ride the existing inline-node rails** and only need recognition of the submodule seam, not new pipelines.

- **P0 — A submodule node's catalog row must be excluded from parent build targets.** The pin-PR adds `infra/catalog/<slug>.yaml` (the row that makes the node deployable). Because the **catalog is the build SSOT** (`CATALOG_IS_SSOT`: `image-tags.sh` derives `NODE_TARGETS` from `infra/catalog/*.yaml`, and `detect-affected.sh`'s `catalog_target_from_path` schedules a leg for any changed `infra/catalog/*.yaml`), `<slug>` enters the build matrix → `build (<slug>)` runs → **fails**: the node's app tree is a bare gitlink, not checked out, so there is no Docker context. **The trigger is the catalog row, not the gitlink** — `detect-affected` is gitlink-blind, and the `nodes/*`↔filter mirror meta-test stays **green** (the `nodes/<slug>` gitlink _is_ in the `nodes/*` listing the filter generates from). `SUBMODULE_GITLINK_IS_OPERATOR_PIN` (#1495) fixes domain _classification_, not _build-target_ derivation. **Fix:** a submodule catalog row carries its `repo`+`ref` pin; `image-tags.sh` / `detect-affected.sh` / `build-and-push-images.sh` read that pin and **skip it as a parent build target** — the node builds its image in its own repo's CI, never the parent. **Hard stop: the pin-PR cannot merge until this lands.** (Observed on `cogni-test-org/cogni-monorepo#1`.)

- **P1 — the node-template mint source must be a drift-synced fork of canonical `Cogni-DAO/node-template`.** Today the mint template is a hand-seeded standalone; a faithful **node-at-root** fork (`app/`, `graphs/`, `k8s/`, `packages/` + its own `ci.yaml`/biome/tsconfig at repo root — _not_ nested under `nodes/node-template/` the way the fork-whole `standalone-node` is) is the prerequisite for minted nodes to carry working self-contained CI so they build their own image. Needs the **sub-tree-projection sync** `detect-sync-drift.mjs` lacks (path-identical model; [repo-sync-contract](./repo-sync-contract.md), #1366). bug.5086 Part D rides here: strip node-template's baseline `.cogni/secrets-catalog.yaml` at **mint** time (not rsync) to dodge the ~57-name `NO_NAME_COLLISIONS` throw.

- **P2 — node builds + pushes its own image (`FORK_FREEDOM`).** Inherited ~free once P1 lands: the node repo's own CI builds + pushes its app image to GHCR; the operator references the digest via the catalog `repo`+`ref` pin and never builds node code. _Decide once:_ the node's GHCR namespace + the Argo image reference for a submodule node (differs from the monorepo's namespace) — P3/P4 fall out of this choice.

- **P3 — operator deploys the pinned node on candidate-a.** Selective `git submodule update --init nodes/<slug>` before any `nodes/*` walk (provisioning, `scripts/lib/secrets-catalog-loader.ts`, the review router, overlay/appset render) — **never** blanket `--recursive` (rebuilds the giant clone). Then the catalog row → per-`(env,node)` AppSet (#1465) → Argo deploys the node pod. Discovery is metadata-driven (not an fs-walk) **via the catalog→`nodes`-table feeder behind `NodeRegistryPort` — which is still unbuilt (#1507); a hard dependency of P3, not a present capability.** Until it lands, a submodule node's row does not project to the operator `nodes` table (the same gap that 500s `extractOwningNode` on the review path).

- **P4 — promote node digest preview→prod.** The gitlink pin + catalog/overlay/appset advance through the deploy branches; build-once-promote-digest applies (the candidate-a-proven image promotes, never rebuilds).

**Identity/config prerequisite (per-env, proven on candidate-a).** Minting authenticates as an env-scoped GitHub App that must (a) be installed **all-repositories** on the mint org and (b) hold **`workflows:write`** — the pin-PR commit edits `.github/workflows/ci.yaml`, which GitHub 403s without it. Mint target, template owner, and submodule-pin-PR parent are env config (`NODE_MINT_OWNER` / `NODE_TEMPLATE_OWNER` / `NODE_SUBMODULE_PARENT_{OWNER,REPO}`), fail-closed (mint) / fail-open (parent → `getGithubRepo()`), so a candidate/test operator has **zero access to the production org** (candidate-a mints into the disposable `cogni-test-org`, pin-PRs into a cogni-shaped fork there).

> **Correction (live repro `cogni-test-org/cogni-monorepo#1`): the `.gitmodules` subtraction _is_ needed — the parent-CI build + scope planes must exclude submodule slugs.** The earlier "dead-but-harmless" reasoning was wrong on two counts: (1) **scope** — the generated dorny filter `nodes/<slug>/**` _does_ match the bare gitlink (picomatch's globstar matches the parent path), so the pin classifies as node-domain and `single-node-scope` false-fails `["<slug>", "operator"]`; (2) **build** — the catalog row puts the slug in `ALL_TARGETS`, so `detect-affected.sh` fans a build over the gitlink, which has no app tree (`lstat nodes/<slug>/app: no such file`). `classify.ts` _is_ correct (a bare gitlink routes to operator); the divergence is that the runtime dorny filter and the build-target list are derived independently and didn't know about gitlinks. **Fix:** `render-scope-filters.sh` + `single-node-scope-meta.spec.ts` skip submodule slugs (no filter generated → gitlink falls to operator's `**`); `image-tags.sh::is_submodule_node` + `detect-affected.sh` drop them from build/flight targets — all keyed off `.gitmodules` (the gitlink is the SSOT). `.gitmodules` is also added to `check-root-layout.ts`'s root allowlist. A submodule node is built **and** flighted by its own repo's CI; the parent only pins, scopes-as-operator, and (next P0) deploys its pre-built image.

---

## Node-owned packages

The single-node-scope rule classifies any path outside `nodes/<X>/**` as `operator`. So a "shared" package at root that is in fact only consumed by one node turns every change to it into an `operator` PR — even though no operator code is touched. Carving such packages under `nodes/<X>/packages/` makes their domain match their actual ownership.

### Rule

A package is **node-owned** iff its only in-repo importer is `nodes/<X>/app`, `nodes/<X>/graphs`, or another `nodes/<X>/packages/<...>` package. Node-owned packages live at:

```
nodes/<X>/packages/<bare-name>/
```

Cross-node packages — anything imported by two or more nodes' `app`/`graphs` — stay at root `packages/`. If a package starts node-owned and later attracts a cross-node consumer, move it back to root in a single carve-back PR.

### Naming convention

Folder is the bare name (no `<node>-` prefix in the path); package name is `@cogni/<node>-<bare-name>`:

| Folder                                 | Package name                  |
| -------------------------------------- | ----------------------------- |
| `nodes/poly/packages/wallet/`          | `@cogni/poly-wallet`          |
| `nodes/poly/packages/market-provider/` | `@cogni/poly-market-provider` |
| `nodes/poly/packages/node-contracts/`  | `@cogni/poly-node-contracts`  |
| `nodes/poly/packages/ai-tools/`        | `@cogni/poly-ai-tools`        |

The `<node>-` prefix on the package name is what makes ownership visible in `package.json` / lockfile / npm registry views; the path makes it visible in grep / file tree. Both signals point the same way.

### Workspace plumbing

Already wired:

- `pnpm-workspace.yaml` globs `nodes/*/packages/*`.
- `vitest.workspace.ts` includes `./nodes/*/packages/*/vitest.config.ts`.
- `pnpm packages:build` builds every `nodes/*/packages/*` and asserts each emits `dist/index.d.ts` (35 packages green as of task.0421).
- pnpm symlinks resolve `@cogni/*` automatically — no `tsconfig.json` `paths` aliases needed.

What a new node-owned package must do:

1. `package.json` — name `@cogni/<node>-<bare-name>`, same shape as existing peers (`exports`, `tsup`/`typecheck` scripts, `dist/` in `files`).
2. `tsconfig.json` — `composite: true`, `references` to any imported sibling packages (use `../../../../packages/<x>` or `../<sibling>` paths).
3. Add a `{ "path": "./nodes/<node>/packages/<bare-name>" }` entry to root `tsconfig.json` `references`.
4. Add the package to `biome/base.json` if it has any non-Biome-default config files (e.g. `tsup.config.ts`).
5. `AGENTS.md` mirroring the shared-package shape (Owners, Status, Boundaries JSON block, Public Surface, Responsibilities, Notes) — `pnpm check:docs` validates.

### Carve-out playbook

When moving an existing root package under a node:

1. Audit who imports it. `grep -rln "@cogni/<old-name>" --include="*.ts" --include="*.tsx" --include="*.json"`. If any non-target-node `app/package.json` declares it _without any code import_, that's a stale dep — drop it as a drive-by.
2. `git mv packages/<old-name> nodes/<node>/packages/<bare-name>`.
3. Rename the package: `package.json` `"name"` → `@cogni/<node>-<bare-name>`. Bulk find-replace the import name across the repo.
4. **Audit overlapping seds.** If you do two find-replaces whose results contain each other's targets (e.g. `s|packages/foo/|nodes/poly/packages/foo/|` after `s|../packages/foo/|../nodes/poly/packages/foo/|`), the second one re-prefixes the first's output. Always `grep -rln "nodes/<node>/nodes/<node>"` after a multi-sed pass.
5. **Audit fixture-relative paths in tests.** Tests that read `__dirname`-relative fixtures via `../../../docs/...` need extra `../` levels for the new depth. `pnpm exec vitest run nodes/<node>/packages/<bare-name>` catches these.
6. Update root `tsconfig.json` `references`, `biome/base.json` lint scopes, `.dependency-cruiser.cjs` rule paths.
7. **Importers with mixed symbols.** If splitting a package whose moved subset shares an `index.ts` with what stays behind, build the symbol allowlist from the moved files' actual exports — not from a name prefix. Files that import a mix get split into two `import { ... } from "@cogni/..."` statements.
8. **Re-exports too, not just imports.** `export { ... } from "<pkg>"` re-exports must also be redirected. Greppable with `from "@cogni/<old>"`.
9. `pnpm install` → `pnpm packages:build` → targeted `pnpm --filter @cogni/<new-name> typecheck` + targeted vitest run for the package and its consumers.
10. Drive-by stale-dep cleanup: drop `@cogni/<old-name>` declarations from any `app/package.json` that has no actual code importer.

### Drive-by-rule

When carving a package out, also remove its declaration from any `package.json` that doesn't actually import it. Stale workspace deps are silent landmines: they make `single-node-scope` think a node still consumes the package, and they make refactor-tooling slower for no reason.

### Per-node dep-cruiser is intentionally separate

This standard does not split `.dependency-cruiser.cjs` per node. That's a separate question (root-rules vs node-rules composition) tracked in [task.0422](../../work/items/task.0422.dep-cruiser-inter-intra-node-design.md) — pre-requires this carve-out so paths are stable before the dep-cruiser split lands.

---

## Design

### Merge Gate (Required for PR Merge)

| Check                                  | Local | CI                    |
| -------------------------------------- | ----- | --------------------- |
| `pnpm typecheck`                       | yes   | static job            |
| `pnpm lint`                            | yes   | static job            |
| `pnpm format:check`                    | yes   | unit job              |
| `pnpm test:ci` (unit/contract/meta)    | yes   | unit job              |
| `pnpm arch:check`                      | yes   | unit job              |
| `pnpm test:component`                  | yes   | component job         |
| **SINGLE_DOMAIN_HARD_FAIL** (PR scope) | no    | single-node-scope job |

**Optional** (not blocking): coverage upload, SonarCloud scan.

**Not a PR gate:** `pnpm test:stack:docker` (full-stack vitest) is **not** in `ci.yaml` and does **not** block PR merge. It lives in `stack-test.yml`, which is `workflow_dispatch`-only — too slow/flaky for per-PR runs. Run it ad-hoc per node: `gh workflow run stack-test.yml -f node=<node>` (empty `node` = every node with a `vitest.stack.config.mts`). Per-node integration coverage otherwise comes from candidate-a validation. (Note: `auto-merge-release-prs.yml` still lists `stack-test` as a required check for `release/*` PRs — a known stale gate, since the workflow never auto-fires.)

### Workflow Entrypoints

| File                     | Type | Secrets            | Trigger                                  | Concern                                           |
| ------------------------ | ---- | ------------------ | ---------------------------------------- | ------------------------------------------------- |
| `ci.yaml`                | CI   | No                 | PR; push main                            | typecheck, lint, unit, component (no stack-test)  |
| `stack-test.yml`         | CI   | No                 | workflow_dispatch                        | Per-node full-stack vitest (matrix over nodes)    |
| `build-multi-node.yml`   | CD   | Yes (GHCR)         | push canary                              | Build + push images                               |
| `promote-and-deploy.yml` | CD   | Yes (SSH, secrets) | workflow_run on build; workflow_dispatch | Promote overlays + deploy infra + verify          |
| `e2e.yml`                | CD   | Yes (PAT)          | workflow_run on promote-and-deploy       | E2E smoke + canary→staging promotion + release PR |
| `build-prod.yml`         | CD   | Yes (GHCR)         | push main                                | Build production images (legacy)                  |
| `deploy-production.yml`  | CD   | Yes (SSH, secrets) | workflow_run on build-prod               | Deploy to production (legacy)                     |

### Local Gates

| Command               | Script                        | Purpose                                                                  |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `pnpm check:fast`     | `scripts/check-fast.sh`       | Strict iteration gate (pre-push): verify-only, fails on any drift        |
| `pnpm check:fast:fix` | `scripts/check-fast.sh --fix` | Auto-fix variant: rewrites lint/format, fails if drift persists          |
| `pnpm check`          | `scripts/check-all.sh`        | Pre-commit gate: typecheck + lint + format + unit/contract + docs + arch |
| `pnpm check:full`     | `scripts/check-full.sh`       | CI parity: Docker build + stack + all test suites (~20 min)              |

### File Ownership Classification

**Node-Owned (Never Centralize):**

| Path                           | Why                         |
| ------------------------------ | --------------------------- |
| `.dependency-cruiser.cjs`      | Hex architecture boundaries |
| `eslint.config.mjs`, `eslint/` | UI/chain governance rules   |
| `biome.json`, `biome/`         | Lint rules                  |
| `.prettierrc`                  | Formatting                  |
| `tsconfig*.json`               | Path aliases                |
| `scripts/check-*.sh`           | Local gate definitions      |
| `nodes/*/app/Dockerfile`       | Image definition            |

**Rails-Eligible (future extraction candidates):**

| Path                                 | Purpose               |
| ------------------------------------ | --------------------- |
| `.github/actions/loki-ci-telemetry/` | CI telemetry capture  |
| `.github/actions/loki-push/`         | Loki push             |
| `scripts/ci/build.sh`                | Docker build          |
| `scripts/ci/push.sh`                 | GHCR push             |
| `scripts/ci/test-image.sh`           | Image liveness test   |
| `scripts/ci/promote-k8s-image.sh`    | Overlay digest update |
| `scripts/ci/deploy-infra.sh`         | Compose infra deploy  |

**Ownership split:** Nodes own scripts and policy configs. Kit owns invocation conventions (when to call, how to parallelize, what to cache).

### Key Decisions

#### 1. Why Canary-First

Canary replaces staging as the primary integration branch. Benefits: multi-node testing from day one, k8s/Argo deployment model, build-once-promote-digest. Staging receives promoted digests, not fresh builds.

#### 2. Why In-Repo Seam First

Extracting to external repo too early causes version pinning overhead, false abstraction boundaries, and reduced iteration speed.

#### 3. Why Policy Stays Node-Owned

Centralizing lint/depcruise configs causes fork friction, policy fights, and loss of sovereignty. Rails kit provides orchestration defaults, not policy mandates.

### File Pointers

| File                                       | Purpose                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yaml`                | CI entrypoint                                                                                  |
| `.github/workflows/build-multi-node.yml`   | Image build                                                                                    |
| `.github/workflows/promote-and-deploy.yml` | Promote + deploy + verify                                                                      |
| `.github/workflows/e2e.yml`                | E2E + promotion chain                                                                          |
| `scripts/check-fast.sh`                    | `pnpm check:fast` implementation                                                               |
| `scripts/check-all.sh`                     | `pnpm check` implementation                                                                    |
| `scripts/check-full.sh`                    | `pnpm check:full` implementation                                                               |
| `tests/ci-invariants/`                     | Static pins on workflow shape, action SHA-pins, single-node-scope classifier fixtures          |
| `infra/github/`                            | Canonical `main`-branch GH config (branch protection + merge queue) — see § Repo Setup Fixture |

## Repo Setup Fixture

Every Cogni node-template fork (and `node-template` itself) shares the same `main`-branch GitHub configuration: classic branch protection with a narrow required-status-checks set + GitHub Merge Queue. The canonical fixture lives in `infra/github/` and is applied via a single command:

```bash
bash infra/github/setup-main-branch.sh                      # current repo
bash infra/github/setup-main-branch.sh my-org/my-fork       # explicit repo
```

What the fixture establishes:

| Layer               | Source of truth                          | Apply mechanism                                                                                                                                              |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repo merge settings | `setup-main-branch.sh` step 1            | `gh api PATCH /repos/{repo}` — squash-only, auto-merge on, delete-branch-on-merge                                                                            |
| Branch protection   | `infra/github/branch-protection.json`    | `gh api PUT /repos/{repo}/branches/main/protection` — required checks: `unit`, `component`, `static`, `manifest`                                             |
| Merge queue toggle  | `infra/github/merge-queue.json` (values) | **UI-only**: Settings → Branches → main → "Require merge queue" + form values. REST silently drops `required_merge_queue` (verified empirically 2026-04-28). |

The required-status-checks set is constrained by an empirical GitHub Merge Queue behavior: the queue waits forever for required checks whose workflows lack a `merge_group:` trigger. Full design + rationale in [`merge-queue-config.md`](./merge-queue-config.md), validated against `Cogni-DAO/test-repo` PR #53.

External-node-formation impact: a fresh fork clones, runs `setup-main-branch.sh`, clicks once in Settings → Branches, and is in lock-step with `Cogni-DAO/cogni`'s gate. No spelunking through Settings; no ad-hoc divergence.

## Acceptance Checks

**Automated:**

- `pnpm check` — local gate parity with CI
- Fork PRs pass CI without secrets

**Manual:**

1. Verify `ci.yaml` calls only pnpm scripts (no inline commands)
2. Verify CD workflows skip gracefully when secrets are missing (fork mode)
3. Verify canary E2E success triggers staging promotion without manual intervention

## Related

- [ci-cd.md](./ci-cd.md) — CI/CD pipeline specification
- [check-full.md](./check-full.md) — check:full CI-parity gate
- [merge-queue-config.md](./merge-queue-config.md) — required-status-checks policy + empirical merge-queue constraints + GitLab vFuture mapping
- [infra/github/](../../infra/github/) — canonical `main`-branch GH config fixture
- [Project: Reusable CI/CD Rails](../../work/projects/proj.ci-cd-reusable.md)
