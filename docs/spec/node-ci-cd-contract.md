---
id: spec.node-ci-cd-contract
type: spec
title: Node CI/CD Contract
status: active
trust: reviewed
summary: CI/CD sovereignty invariants, artifact contracts, workflow entrypoints, and operator control-plane ownership
read_when: Modifying CI workflows, adding checks to merge gate, or planning multi-node CI extraction
implements: []
owner: cogni-dev
created: 2025-12-22
verified: 2026-06-08
tags:
  - ci-cd
  - deployment
---

# Node CI/CD Contract

## Context

Node sovereignty is non-negotiable. A source repo must run its own merge gate and build its own deployable artifacts without depending on the operator deploy plane. The operator may host and deploy those artifacts, but it must do so by validating a source revision and consuming an already-published artifact digest, not by rebuilding source.

This spec distinguishes two things that are easy to conflate:

- **Operator control-plane repo**: this repository's orchestration surface: operator app, catalog, overlays, AppSets, deploy branches, CI/CD scripts, docs, and templates.
- **Operator app artifact**: the deployable image for the operator app itself. It is one artifact among many and should follow the same sourceSha → digest promotion contract.

## Goal

Define the CI/CD invariants, artifact contract, and file ownership boundaries that ensure every deployable artifact is built by its source repo and can still be deployed by a shared operator.

The simplification target is one artifact contract and one promotion primitive. Everything else is policy: source repos decide how to build and gate; the operator decides who may deploy where; the deploy plane always consumes `{ target, source_repo, sourceSha, image_repository, digest }`.

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

6. **BUILD_ONCE_PROMOTE_DIGEST**: An artifact is built once for a source revision, resolved to an immutable digest, and promoted by digest. No environment rebuilds. The repo that owns the artifact builds; the operator deploy plane only resolves and deploys the digest.

7. **SINGLE_RESPONSIBILITY**: Each workflow file owns one concern (build, promote+deploy, E2E+release). No monoliths.

8. **SINGLE_DOMAIN_HARD_FAIL**: Source-code PRs happen in the source repo that owns the artifact. Parent repo PRs for hosted artifacts are operator control-plane changes: gitlink/pin acceptance, catalog rows, overlays, AppSets, DNS/provisioning wiring, and deploy-state machinery. Legacy in-tree node directories remain transitional and are still guarded by `single-node-scope`; they are not the future build model. See `## Single-Domain Scope` below.

9. **SOURCE_SHA_IS_DEPLOY_IDENTITY**: `sourceSha` is the deployment coordinate for every deployable artifact. Every flightable artifact for that source revision must be published as `<image_repository>:sha-<40-char-sourceSha>`. The operator resolves that tag to `image@sha256:<digest>` before writing deploy state.

10. **TARGET_SUBSTRATE_IS_ASSERTED_NOT_PROVISIONED**: App flights may verify
    the target substrate required by a catalog deployable, but they must not
    provision it. Missing substrate fails the flight with an explicit handoff to
    `provision-env.yml`, `candidate-flight-infra.yml`, or the preview/prod
    infra lane that owns the mutation.

---

## Single-Domain Scope

Every path in the operator control-plane repo belongs to **exactly one review domain**. A PR may touch exactly one domain unless a migration work item explicitly declares a broader scope. This invariant is enforced statically by the `single-node-scope` job in `ci.yaml` (task.0381), and at review-time by `PrReviewWorkflow` via `extractOwningNode` (resolver: task.0382; consumer: task.0410). The reviewer fetches per-domain rule files from the owning repo/path (resolved via `resolveRulePath` — single source of truth in `@cogni/repo-spec`), refuses accidental cross-domain PRs with a diagnostic comment + neutral check (no AI tokens spent), and emits a structured `review.routed` log. Both implementations consume the same set of fixtures and must agree.

> **Routing-vs-policy principle.** Review **routing** is shared infrastructure (`packages/temporal-workflows`, `@cogni/repo-spec`). Review **policy** — rules, prompts, model selection — is per-node (`nodes/<X>/.cogni/`). Routing code never special-cases a particular node by string compare; the operator domain ships its rules at `nodes/operator/.cogni/rules/` like every other node. New review knobs land per-node first; promotions to shared infra require a spec update.

### Transitional domains

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

The broad `operator` domain is the control plane, not the operator app artifact. It owns the substrate every hosted artifact consumes. The operator app image is just one deployable artifact within that control plane and should not be used as the mental model for every operator-owned file.

Future node source changes happen in child repos, not in `nodes/<X>/**` inside this repo. The in-tree `poly`, `resy`, and `node-template` domains are legacy migration surfaces. New hosted node PRs in this repo should be pin/deploy-state/control-plane changes and therefore route as operator-domain work.

### Rule

```
domain(path) = X         if path matches  nodes/<X>/**  for legacy in-tree node X
             = operator   otherwise   (i.e., nodes/operator/** OR anywhere outside nodes/)

PR passes iff |distinct domains touched| ≤ 1, with the bounded ride-along whitelist below.
```

The set of legacy non-operator domains is derived from the `nodes/*` directory listing minus `operator` and minus submodule gitlinks — meta-tested in `tests/ci-invariants/single-node-scope-meta.spec.ts`. The repo-spec `nodes` registry must mirror the same set (enforced at the resolver boundary; meta-test asserts both directions). Adding a hosted node as a submodule must not add a new parent-repo build domain; its source-code domain lives in the child repo.

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

## Operator-hosted artifacts

The target model is artifact-first. A hosted node's source lives in the repo that owns it, and that repo publishes the artifact the operator deploys. A git submodule at `nodes/<slug>` is only the current approval-pin mechanism: a node-template fork the operator pins by SHA. It is not a build context, not a workflow execution surface, and not the long-term identity model.

Legacy in-tree nodes (`resy`, `poly`, `node-template`, and any remaining similar rows) are transitional. They should be migrated toward the same `source_repo + image_repository + sourceSha + digest` contract instead of being preserved as a parallel first-class model.

### Plain-English authority model

The model is good only if the boundary stays this simple:

| Plane                           | Owner                                                      | Must not do                                                                                               |
| ------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Artifact source repo**        | Artifact developer / node agents                           | Own shared-operator VM state, Argo, DNS, preview/prod promotion, or operator deploy branches              |
| **Operator control-plane repo** | Operator                                                   | Rebuild hosted artifact source, invent source-repo policy, or use GitHub repo permissions as product auth |
| **Operator app artifact**       | Operator app source repo                                   | Stand in for the whole control plane; it is just one deployable image                                     |
| **GitHub App identity**         | Environment-scoped automation credential                   | Decide who is allowed to flight; it only proves the operator has the mechanical ability to act            |
| **Operator API / DB**           | Authorization boundary for flight/publish/promote requests | Delegate authorization to "who can push to a GitHub repo"                                                 |

So: artifact source repos carry **CI + image build**, not hosted flight/deploy
workflows. Hosted flight is an operator action because it mutates operator-owned
environment state: deploy branches, Argo applications, DNS, OpenBao/ESO, and
candidate/preview/production provenance. A source repo may include a small
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

### Artifact contract

Deployable catalog rows are artifact records. Build ownership may differ by source repo; promotion does not. The operator's deploy plane consumes four stable facts:

| Fact               | Source of truth                                  | Purpose                                                   |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------- |
| `source_repo`      | `infra/catalog/<slug>.yaml` in the operator repo | Where the artifact source revision lives                  |
| `sourceSha`        | Flight request + optional parent gitlink         | The exact source commit accepted for deployment           |
| `image_repository` | `infra/catalog/<slug>.yaml` in the operator repo | The deployable artifact repository for this catalog row   |
| digest             | Registry lookup of `image_repository:sha-*`      | The immutable image reference written to k8s deploy state |

The required publish contract is:

```text
<image_repository>:sha-<40-char-sourceSha>
```

This tag is only a lookup key. It must be treated as immutable, but k8s receives the resolved digest:

```text
<image_repository>@sha256:<digest>
```

The source repo SHOULD also stamp OCI metadata (`org.opencontainers.image.source` and
`org.opencontainers.image.revision`) so the registry artifact carries its source
provenance. The operator still validates provenance independently through
`source_repo`, `sourceSha`, `.cogni/repo-spec.yaml`, and digest resolution.

PR-shaped tags such as `pr-<number>-<sha>` are allowed only as node-repo CI/debug
aliases. They are not accepted by `nodeRef` flight because PR number is review
metadata, not deployment identity.

Artifact repository names describe deployables, not ontology. Prefer:

```text
ghcr.io/<owner>/<repo>          # one primary deployable
ghcr.io/<owner>/<repo>-app      # primary app when disambiguation is needed
ghcr.io/<owner>/<repo>-worker   # additional worker
ghcr.io/<owner>/<repo>-webhook  # additional webhook
```

Avoid default `-node`: it says who owns the artifact, not what is deployed. Do
not add catalog types for this. `type: node | service | infra` is only the
current deploy-shape taxonomy for routing and Argo/VM behavior; build and
promotion logic should key on artifact fields (`source_repo`,
`image_repository`, `sourceSha`, digest), not on node ontology.

### Target substrate assertion contract

The unit of readiness is the catalog target, not the node. `infra/catalog/$TARGET.yaml`
declares the deploy shape through `.type`, and `candidate-flight.yml` may run a
read-only substrate gate before writing app deploy state. The gate reads the
catalog row and dispatches by type:

| `type`    | Assertion owner today                                                                                                                                                                                                                                                               | App-flight behavior                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`    | `scripts/ci/assert-target-substrate.sh` checks the node-shaped substrate: VM/k3s/Argo reachability, namespace, per-target AppSet/Application, local catalog/overlay/AppSet, scoped DNS, edge/Caddy route, Service NodePort, Deployment-consumed Secret/ExternalSecret, and node DB. | Fail loud when missing; do not run `deploy-infra.sh`.                                                                                                      |
| `service` | Service-specific contract TBD. It must assert Deployment/Service plus declared Secret/ExternalSecret/ConfigMap dependencies without inheriting node DNS, Caddy, NodePort, or node-DB assumptions.                                                                                   | Fail explicitly until the service contract exists. `scheduler-worker` is the reference service shape, not a node.                                          |
| `infra`   | Compose-on-VM or infra-lane assertion. `litellm` is currently Compose-owned, not Argo-owned.                                                                                                                                                                                        | Fail explicitly in app flight; use `candidate-flight-infra.yml`, `provision-env.yml`, or preview/prod infra reconcile unless a Compose assertion is built. |

This keeps `node` as one implementation branch under a target-shaped gate. A
future OpenFGA or scheduler-worker deployable should extend the `service`
branch rather than unwind node-specific assumptions from the generic flight
path.

### SUBMODULE_GITLINK_IS_OPERATOR_PIN

A change to a `nodes/<slug>` **submodule gitlink** (the pinned-commit pointer) classifies as **operator-domain**, not node-domain. The pointer is the control plane's _pin_; the node's _code_ was reviewed in the node repo's own PR queue. So the deploy PR — gitlink bump + the node's catalog/overlay/appset rows — is **one operator-domain change**, not a cross-domain rejection. Without this rule the bump touches `nodes/<slug>` (node) + `infra/` (operator) → `|S| = 2` → rejected by the gate. The operator filter's `!nodes/<slug>/**` negation must **not** subtract a submodule gitlink — only a real in-tree node directory is node-domain.

This holds **structurally** in `classify.ts`: a bare `nodes/<slug>` gitlink has no trailing path segment (`slash > 0` is false), so it falls through to operator-domain — and so do its catalog/overlay/appset rows, because a submodule slug is a gitlink, not an inline `nodes/*` directory, hence absent from the non-operator-node set. Pinned by the `single-node-scope` parity fixture `19-submodule-gitlink-operator-pin.json` (gitlink + `.gitmodules` + catalog + overlays×3 + appset → one operator domain, `pass: true`). The regression guard is a comment on the `slash > 0` branch in `classify.ts`.

### Legacy inline CI vs artifact-owned CI

Inline node CI exists because this repo historically carried several node apps as source content. That is not the target architecture. The target is artifact-owned CI: the source repo that owns the artifact gates and builds it; the operator control-plane repo validates pins, resolves digests, and deploys.

| Concern                            | Legacy inline node                           | Artifact-owned source repo                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge gate (unit/component/static) | operator monorepo CI, shared root configs    | the source repo's **own** CI (node-template fork — `FORK_FREEDOM` + `setup-main-branch.sh` apply for node artifacts)                                                                                                                                                                                                                                                                                                                                                                     |
| `POLICY_STAYS_LOCAL`               | shared root policy                           | own policy copies — drift is by-design sovereignty                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| operator's job                     | full gate + `single-node-scope` split        | source-validate + optional pointer-validate + provision + flight + promote                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ci.yaml` scope filter             | `nodes/<X>/**` entry + operator `!` negation | **no parent build-domain filter** — `render-scope-filters.sh` skips submodule slugs (keyed off `.gitmodules`). A generated `nodes/<slug>/**` filter is **not** harmless: picomatch's globstar matches the bare gitlink `nodes/<slug>`, so the pin misclassifies as node-domain (`MATCHED: ["<slug>", "operator"]` → false cross-domain reject). With no filter, the gitlink falls to operator's `**`. The `nodes/*` ↔ filter mirror meta-test applies the same `.gitmodules` exclusion. |

### The node is a sovereign repo, not operator-built content (two views)

The node has **its own `.github/workflows/` and runs its own CI** — _and_ it is **`nodes/<slug>` only** from the operator. Both are true; they are two views of one object, not a contradiction:

- **Node-repo view (the node-dev's clone).** A submodule node is a _full standalone repo_ with the node **at its root**: `app/`, `graphs/`, `k8s/`, `packages/`, plus its **own** `.github/workflows/pr-build.yml`, biome/tsconfig/Dockerfile, and the `setup-main-branch.sh` gate. The node-dev clones _only_ this repo, runs the full merge gate there, and **builds + pushes its own image** to GHCR (`FORK_FREEDOM`). This sovereignty is the entire reason the submodule model exists. For the product/package shape of that root-level node repo, see [Node Backend-as-a-Service Architecture](./node-baas-architecture.md).
- **Operator view (the monorepo).** The operator sees a `nodes/<slug>` **gitlink — a pointer**, not content. Even after `git submodule update --init nodes/<slug>`, the node's root `.github/workflows/` lands at `nodes/<slug>/.github/workflows/`, which **GitHub never executes** (only _repo-root_ `.github/workflows/` run). So the operator monorepo **never runs the node's workflows and never builds the node** — its job is exactly the table above: pointer-validate + provision + flight + promote the node's _pre-built_ image.

**Corollary that breaks today's pin-PR (P0).** Because the node builds itself, the operator's `detect-affected.sh` must **exclude the gitlink from build targets** — a `build (<slug>)` leg on the parent is always wrong. The operator consumes the artifact by **digest** resolved from catalog `image_repository` + requested `sourceSha`, never by rebuilding source.

> **Rejected — "content-only nodes built by the operator" (`nodes/<slug>/*` with no workflows).** That collapses sovereignty: the operator would have to check out + build every node, re-coupling to node code and forfeiting independent per-node CI — exactly the inline tax (#1462) the submodule model removes. The node's code lives _and is built_ in its own git boundary; the operator carries a pointer + a catalog row, nothing more.

### Public + private node repos

The model works for both; only the **clone/pull credentials** differ — never the topology.

- **Public node repo.** Submodule init + image pull need no auth.
- **Private node repo.** Two credentialed paths, both already satisfied because the operator App **minted** the repo (and is installed all-repositories on the mint org):
  1. **Selective submodule init** (the `nodes/<slug>/.cogni/` walks: provisioning, `secrets-catalog-loader.ts`, the review router) authenticates with the operator App's installation token (`contents:read` on the node repo) over the HTTPS `.gitmodules` URL — never an anonymous clone.
  2. **Image pull** for deploy uses GHCR pull creds for the node's package, independent of git. Deploy needs the _image_, not the source, so a private node never requires the operator to check out its tree at deploy time (discovery stays metadata-driven via the catalog row).

The node's **own** CI (private repo) builds + pushes with its repo-scoped `GITHUB_TOKEN` → its private GHCR package; no cross-repo secret sharing. The single invariant: whatever org holds private node repos, the operator App is installed there with `contents:read` — which the mint flow already guarantees.

### Discovery is metadata-driven, not filesystem-driven

A submodule node's app tree is absent from the operator build/runtime image (the runtime ships only the operator's own `.cogni`; no `infra/catalog`), so it can never be discovered by walking `nodes/*`. It registers exactly like an inline node: its **catalog row** — committed in the operator pin PR, present even when the submodule is not checked out — projects to the operator `nodes` table and renders via **`NodeRegistryPort`** ([proj.agent-registry](../../work/projects/proj.agent-registry.md), #1492). **Submodule-ness is a catalog/CI concern** (`source_repo` + `image_repository` plus a gitlink pin), invisible to `NodeRegistryPort` consumers; a submodule node is still `NodeSummary.kind: full-app`. The #1492 v0 static `nodes.data.ts` adapter is itself a per-node manual-step tax and does not scale — submodule births at scale depend on the v0.1 DB-projection adapter landing behind the same port.

### Template taxonomy — three repos by integration model (not by node kind)

A node's **integration model** (how it attaches to the operator) picks its template repo; its `NodeRegistryPort` kind is orthogonal.

| Template repo                                              | Integration                                                                       | `NodeSummary.kind` | Status               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------ | -------------------- |
| `Cogni-DAO/standalone-node` (renamed from `node-template`) | fork the whole near-monorepo → run your own sovereign Cogni                       | `full-app`         | live (sync artifact) |
| new node-at-root submodule template                        | `generate` → `submodule add` at `nodes/<slug>` in the shared operator             | `full-app`         | this design          |
| agent-scope template (langgraph + dolt only)               | submodule within the registry node; "launch an AI dev in a fresh scope-only repo" | `agent-scope`      | vFuture              |

Two `full-app` templates differ **only by integration** (fork-whole vs submodule); `agent-scope` is a third, minimal template (no Next.js app, just agent packages + Dolt migrations). Submodule-ness stays invisible to `NodeRegistryPort` consumers (catalog metadata + gitlink pin) — discovery is metadata-driven (above). The renamed `standalone-node` is **not** the submodule template: a fork-whole repo nests the node at `nodes/node-template/`, but a submodule must expose the node **at its root** so it lands at `nodes/<slug>/app`. That layout difference is why the submodule template is a distinct repo, not a reuse.

### Where the line is between the three repos — the deploy/infra plane

All three repos carry the node **app + its merge-gate CI + image build**. They differ on **one axis: how much of the deploy/infra plane they carry.**

| Repo                                        | Node app                                  | Node CI (merge-gate + build→GHCR)         | Deploy/infra plane¹      | Who deploys it                                           |
| ------------------------------------------- | ----------------------------------------- | ----------------------------------------- | ------------------------ | -------------------------------------------------------- |
| **cogni monorepo**                          | operator + inline nodes (`nodes/poly`, …) | yes (shared root configs)                 | **owns it — every node** | itself                                                   |
| **standalone-node** (fork-whole)            | node nested at `nodes/node-template/`     | yes                                       | **yes — you self-host**  | itself (you _are_ an operator)                           |
| **node-template** (submodule, node-at-root) | node at repo root                         | **yes — own `pr-build.yml` + build→GHCR** | **no**                   | the shared operator (pin → provision → flight → promote) |

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

| Task              | Node-dev does (in their repo, their CI)                                                                                                                                                      | Operator's plane does                                                                                                                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add a secret**  | Declare the key's _shape_ in `.cogni/secrets-catalog.yaml` (node-domain). Consume it via typed env in app code (fail-fast if missing).                                                       | Selective-init reads the catalog → generates the ExternalSecret + OpenBao path. **Value** is set with `pnpm secrets:set <env> <slug> <KEY>` by whoever holds that env's OpenBao writer role — the env owner (a self-host node-dev on their own env; the operator on an operator-hosted env, or a node-dev granted the env-writer role). |
| **Add a service** | App/service code + `Dockerfile` + k8s **base** manifest (Deployment/Service) + artifact metadata + the **build→GHCR** workflow leg, all in the node repo. Node CI builds + pushes the image. | The operator-hosted plane owns the `infra/catalog` row, per-env overlay, and AppSet for that deployable, all referencing the pushed digest. Argo deploys it.                                                                                                                                                                            |

**Invariant: the node-dev declares shape in-repo; the operator's plane consumes it.** A new secret or service is **one edit in the node's own repo + its own CI** — never a monorepo PR. The value-set + deploy wiring belong to whoever owns the env. This keeps `secrets-add-new` / `create-service` correct verbatim for a **self-host** node (it owns its plane) and cleanly halved for a **submodule** node (operator owns the plane half).

### Forward path to deployment

The submodule **birth** is as-built (#1506): the wizard mints the node repo as a named fork of `node-template` (`GitHubRepoWriter.forkFromTemplate` → direct identity commit to the new repo's `main`, no PR there) and the operator authors **one** pin PR (`openNodeSubmodulePr` — a `160000` gitlink at `nodes/<slug>` + `.gitmodules` + the operator-owned footprint). The fork preserves a shared merge base with `node-template`, so spawned nodes can fetch and merge future template updates instead of manually porting unrelated histories.

The forward deployment contract is:

1. **Parent CI builds only artifacts whose source repo is this repo.** `.gitmodules` still identifies current submodule slugs for parent-domain routing, but build selection keys on artifact build ownership: a catalog row whose `source_repo` is another repo is a deploy input, not a parent build leg. A parent `build (<slug>)` leg is always wrong for a remote-source submodule node.
2. **The submodule template is node-at-root and self-building.** A minted node repo contains `app/`, `graphs/`, `k8s/`, `packages/`, node-local rules, and its own merge gate/build workflow at repo root. It publishes every flightable deployable to GHCR as `sha-<sourceSha>`.
3. **Candidate flight is source-addressed.** The operator API accepts `nodeRef { nodeId, sourceSha }`, verifies the catalog, verifies the child commit exists, verifies `.cogni/repo-spec.yaml` identity at that commit, verifies `image_repository:sha-<sourceSha>` exists, ensures the parent gitlink pins that commit, then dispatches `candidate-flight.yml`.
4. **Deploy state is digest-addressed.** `candidate-flight.yml` resolves `image_repository:sha-<sourceSha>` to `image_repository@sha256:<digest>`, writes only deploy-state branches, and verifies `/version.buildSha == sourceSha`.
5. **Substrate is asserted before app rollout.** For target shapes enabled in app flight today, `candidate-flight.yml` reconciles the per-target AppSet/DNS prerequisites, then runs the target substrate gate. The gate is read-only; missing VM, Argo objects, DNS, edge route, consumed Secret/ExternalSecret, Service NodePort, or DB stops the app flight and points to the explicit infra/substrate lane.
6. **Promotion preserves the digest.** Preview and production promote the candidate-proven digest. The operator never rebuilds child source and never substitutes a PR tag.

**Identity/config prerequisite (per-env, proven on candidate-a).** Minting authenticates as an env-scoped GitHub App that must (a) be installed **all-repositories** on the mint org and (b) hold **`workflows:write`** — the seed/pin flow edits `.github/workflows/pr-build.yml`, which GitHub 403s without it. Mint target, template owner, and submodule-pin-PR parent are env config (`NODE_MINT_OWNER` / `NODE_TEMPLATE_OWNER` / `NODE_SUBMODULE_PARENT_{OWNER,REPO}`), fail-closed (mint) / fail-open (parent → `getGithubRepo()`), so a candidate/test operator has **zero access to the production org** (candidate-a mints into the disposable `cogni-test-org`, pin-PRs into a cogni-shaped fork there).

> **Correction (live repro `cogni-test-org/cogni-monorepo#1`): gitlink-aware scope routing is still needed while submodules remain.** A generated dorny filter `nodes/<slug>/**` matches the bare gitlink, so submodule pins must route as operator-domain work. Build exclusion should not depend on submodule ontology: it follows artifact source ownership. The child repo remains the build plane because its `source_repo` is not this repo.

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

| File                              | Type | Secrets                   | Trigger                      | Concern                                                                                        |
| --------------------------------- | ---- | ------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `ci.yaml`                         | CI   | No                        | PR; push main                | Typecheck, lint, unit, component, docs, architecture, scope                                    |
| `stack-test.yml`                  | CI   | No                        | workflow_dispatch            | Per-node full-stack vitest                                                                     |
| `pr-build.yml`                    | CI   | GHCR write                | pull_request; merge_group    | Transitional in-repo artifact build aliases (`pr-*` / `mq-*`)                                  |
| `candidate-flight.yml`            | CD   | GHCR read; deploy         | workflow_dispatch            | Candidate-a target substrate assertion + digest flight from `image_repository:sha-<sourceSha>` |
| `candidate-flight-infra.yml`      | CD   | SSH/secrets               | workflow_dispatch            | Candidate-a VM compose substrate only                                                          |
| `flight-preview.yml`              | CD   | GHCR read/write           | push main; workflow_dispatch | Preview dispatch/queue control; any re-tagging is transitional lookup plumbing                 |
| `promote-and-deploy.yml`          | CD   | SSH/secrets; deploy       | workflow_dispatch            | Preview/production digest promotion, infra reconcile, verify, e2e                              |
| `promote-preview-digest-seed.yml` | CD   | GHCR read; contents write | workflow_run                 | Maintains preview digest seed pins on `main` after dispatched preview flights                  |

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

#### 1. Why source repos build their own artifacts

Operator-hosted does not mean operator-built. If the parent repo builds hosted source, the artifact owner loses independent CI, local policy control, and fork freedom. The operator's job is to validate source identity, accept a pin when pins are still used, resolve published artifacts to digests, and mutate deploy state.

#### 2. Why submodules remain narrow

The submodule gitlink is an approval pin in the operator repo. It is not a build context, discovery mechanism, or workflow execution surface. If future catalog/deploy state can carry the same accepted `source_repo + sourceSha + digest` record without a gitlink, the submodule can be retired without changing the artifact contract.

#### 3. Why policy stays node-owned

Centralizing lint/depcruise configs causes fork friction, policy fights, and loss of sovereignty. Rails kit provides orchestration defaults, not policy mandates.

#### 4. Why artifact names are deployable-shaped

`image_repository` names what is deployed. Default `-node` image names are rejected because they describe ownership rather than artifact role. Use the repo package for a single primary artifact, or suffixes like `-app`, `-worker`, and `-webhook` when one source repo publishes multiple deployables.

### File Pointers

| File                                       | Purpose                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yaml`                | CI entrypoint                                                                                  |
| `.github/workflows/pr-build.yml`           | Transitional in-repo artifact build aliases                                                    |
| `.github/workflows/candidate-flight.yml`   | Candidate-a digest flight for artifact source SHAs                                             |
| `.github/workflows/promote-and-deploy.yml` | Promote + deploy + verify                                                                      |
| `scripts/ci/assert-target-substrate.sh`    | Read-only catalog-target substrate gate used before selected app flights                       |
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
3. Verify artifact flight refuses missing `image_repository:sha-<sourceSha>` and deploys only the resolved digest when present
4. Verify app flight refuses missing target substrate without running `deploy-infra.sh`
5. Verify preview/production promotion preserves the candidate-proven digest without rebuilding
6. Verify every future `type: node` deployable has `source_repo` + `image_repository`; remaining legacy rows are either migrated to the artifact contract or reclassified out of node deployables

## Related

- [ci-cd.md](./ci-cd.md) — CI/CD pipeline specification
- [check-full.md](./check-full.md) — check:full CI-parity gate
- [merge-queue-config.md](./merge-queue-config.md) — required-status-checks policy + empirical merge-queue constraints + GitLab vFuture mapping
- [infra/github/](../../infra/github/) — canonical `main`-branch GH config fixture
- [Project: Reusable CI/CD Rails](../../work/projects/proj.ci-cd-reusable.md)
