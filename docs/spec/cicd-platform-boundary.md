---
id: spec.cicd-platform-boundary
type: spec
title: CI/CD Platform Boundary & Freeze Policy
status: active
trust: draft
summary: "Where new deployment/platform work goes and what stops growing. Classifies every CI/CD surface (scripts, workflows, OpenTofu, Kustomize, Argo, Compose, secrets) into leave-alone / freeze-expansion / future-home / danger-zone, gives a request→home routing table, the allowed-change policy that keeps the `.sh`+YAML pseudo-platform from accreting, and the typed `.ts` operator control plane (OperatorDeployPlanePort owns deploy writes; DeployCapability is read-only awareness; ComputeResourcePort for compute, Cherry→Akash) that the deploy brain migrates INTO."
read_when: "Before adding ANY new deployment, promotion, provisioning, secret, domain, or env-lifecycle behavior; reviewing a PR that touches scripts/ci/**, .github/workflows/**, infra/**, or deploy/*; or deciding whether a request is script work or platform work."
implements: []
owner: cogni-dev
created: 2026-06-11
verified: 2026-06-11
tags:
  - ci-cd
  - deployment
  - platform
  - governance
---

# CI/CD Platform Boundary & Freeze Policy

## Why this exists

The substrate is built. OpenTofu provisions VMs, Argo CD + Kustomize own k8s deploy state, ESO+OpenBao own secrets, `infra/catalog/*.yaml` is the SSOT for deployable shape. That platform is real and mostly correct.

The problem is not the substrate — it is that **deployment _behavior_ leaks into `scripts/ci/*.sh` and `.github/workflows/*.yml`** faster than it lands in the substrate. The clearest symptom: `scripts/ci/deploy-infra.sh` is **2,167 lines** carrying eight distinct responsibilities (SSH/rsync, DB superuser reconciliation, secret threading of 70+ values, Caddy edge render, OpenFGA bootstrap, Image-Updater bootstrap, k8s secret creation, Temporal password `ALTER`), every prod-mutating path running with minimal guards. This is an accidental pseudo-platform — a control plane expressed in bash and YAML instead of in Tofu/Argo/Kustomize/ESO.

This document does **not** order a rewrite. It draws the boundary: it classifies every surface, says where each future request type must land, and defines the growth policy that stops the bash/YAML control plane from getting bigger. It is the router that sits on top of the existing canon.

This refines, it does not duplicate:

- [`ci-cd.md`](./ci-cd.md) — the 22 Core Axioms + branch/deploy-state model. Line 29 already states the contract: _"workflows, scripts, and agent skills that diverge from it are bugs, not allowed drift."_ This doc operationalizes that for **new** work.
- [`legacy-cicd-to-remove.md`](./legacy-cicd-to-remove.md) — the artifact-identity legacy list ("One artifact contract. One promotion primitive."). This doc adds the missing sixth category (deploy-brain-in-shell) and the per-surface freeze.
- [`node-ci-cd-contract.md`](./node-ci-cd-contract.md) — node sovereignty invariants (the standalone-node carve-out below leans on these).
- [`node-baas-architecture.md`](./node-baas-architecture.md) — node declares shape; operator wires environment.

## Scope: two planes, one freeze

The freeze applies to the **operator control plane** only. It does **not** restrict a sovereign node's own CI.

| Plane                      | What it is                                                                                                                            | Freeze applies?                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator control plane** | This monorepo's deploy brain: `scripts/ci/**`, `.github/workflows/**` deploy/promote/provision logic, `infra/**`                      | **Yes.** New platform behavior routes to the substrate (Tofu/Argo/Kustomize/ESO/catalog), not to new bash/YAML.                                                                                                     |
| **Node sovereignty**       | A standalone node's own `.github/workflows/` + thin scripts that build & push its image (`BUILD_ONCE_PROMOTE_DIGEST`, `FORK_FREEDOM`) | **No.** Off-cluster nodes keep GitHub Actions + `.sh` for portability. The node declares shape; the operator wires the env. This is a feature, not debt — see [`node-ci-cd-contract.md`](./node-ci-cd-contract.md). |

GitHub Actions is **not** assumed to be the long-term OSS CI answer for the control plane. It is the current artifact-build host. Keeping deploy-brain out of it (below) is what makes a future CI swap a localized change instead of a platform migration.

## The four classifications

| Class                   | Meaning                                              | Rule                                                                                                  |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **🟢 LEAVE ALONE**      | Works; correct shape                                 | Do not refactor for aesthetics. Touch only for real bugs.                                             |
| **🟡 FREEZE EXPANSION** | Works; runs in prod; wrong long-term home            | May keep running. **No new platform logic added here.** Bug-fix patches only.                         |
| **🔵 FUTURE HOME**      | The correct place for new work of its kind           | Route new requests here.                                                                              |
| **🔴 DANGER ZONE**      | Can mutate prod / secrets / infra in surprising ways | Needs guardrails (review gate, dry-run, marker-ordering), **not** a rewrite. Every edit is high-risk. |

## Current-state ownership map

### Substrate (the future homes — already real)

| Surface                                                                                                           | Owns                                                                                                                                   | Class                                |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `infra/catalog/*.yaml` + `_schema.json`                                                                           | SSOT for deployable shape: ports, branches, image tags, node identity (`CATALOG_IS_SSOT`, Axiom 16). Adding a node = one catalog drop. | 🔵 FUTURE HOME                       |
| `infra/k8s/base/` + `infra/k8s/overlays/<env>/<node>/`                                                            | Declarative k8s desired state. Base = app shape; overlay = per-env config (URLs, nodePort, ExternalName).                              | 🔵 FUTURE HOME (base/overlays)       |
| `infra/k8s/argocd/` (per-`(env,node)` ApplicationSets, image-updater, ksops, ESO, OpenBao, Reloader as Argo Apps) | Deploy reconciliation + promotion state. `Argo owns reconciliation` (Axiom 6).                                                         | 🔵 FUTURE HOME                       |
| `infra/provision/cherry/{base,k3s}/*.tf`                                                                          | Cloud infra: Cherry VM, SSH keys, VM lifecycle.                                                                                        | 🔵 FUTURE HOME (cloud infra)         |
| `infra/secrets-catalog.yaml` + `nodes/<node>/.cogni/secrets-catalog.yaml`                                         | Declarative secret SSOT (tier, source, routing, generate-kind).                                                                        | 🔵 FUTURE HOME (secret declarations) |
| `scripts/lib/secrets-catalog-loader.ts`                                                                           | Pure Zod parse of the secret catalog. New generator kinds land here.                                                                   | 🟡 FREEZE EXPANSION                  |
| ESO `ClusterSecretStore` + per-node `ExternalSecret` + Reloader                                                   | OpenBao→k8s Secret sync + rollout-on-rotate. The secret delivery plane.                                                                | 🟢 LEAVE ALONE                       |

### Pure CI (the only long-term GitHub-Actions job shape)

| Surface                                                                                                                      | Owns                                                                                                   | Class          |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------- |
| `pr-build.yml`                                                                                                               | Affected-only image build+push. Pure artifact, zero deploy logic. Handoff via build-manifest artifact. | 🟢 LEAVE ALONE |
| `ci.yaml`, `pr-lint.yaml`, `stack-test.yml`                                                                                  | Test/lint/typecheck gates. No infra mutation.                                                          | 🟢 LEAVE ALONE |
| `build-and-push-images.sh`, `detect-affected.sh`, `merge-build-fragments.sh`, `write-build-manifest.sh`, `lib/image-tags.sh` | Catalog-driven build/tag resolution. Idempotent; no state mutation beyond GHCR.                        | 🟢 LEAVE ALONE |
| `sync-drift-detector.yml`, `archive-feature-history.yml`, `require-pinned-release-prs-to-main.yml`, `release.yml`            | Read-only observability + release-PR plumbing.                                                         | 🟢 LEAVE ALONE |

### Generators (catalog → committed desired state)

| Surface                                                                                                    | Owns                                                                                                                                                 | Class                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `render-node-appset.sh`, `render-node-overlays.sh`, `render-caddyfile.sh`, `node-applicationset.yaml.tmpl` | Render Argo AppSets / Kustomize overlays / Caddyfile from catalog. Drift-gated, byte-exact twin of the operator's TS scaffolder (`gens/overlay.ts`). | 🟡 FREEZE EXPANSION (three code paths → drift risk; converge, don't extend) |

### Deploy brain (frozen — runs in prod, wrong home)

| Surface                                                                                               | Owns                                                                                                             | Class                                            |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `promote-k8s-image.sh`, `promote-build-payload.sh`, `update-source-sha-map.sh`, `aggregate-rollup.sh` | Write digests + provenance into overlays/deploy branches. `sed`-based YAML edits, git push to `deploy/*`.        | 🔴 DANGER ZONE                                   |
| `candidate-flight.yml`, `promote-and-deploy.yml`                                                      | App-digest promotion orchestration. ~1,100 + ~1,000 lines; 3-way inline digest-resolution trees; SSH to VM.      | 🔴 DANGER ZONE                                   |
| `candidate-flight-infra.yml`, `provision-env.yml`                                                     | Infra/Compose lever + cold-start provisioning. Mutate VM + secrets + Cloudflare.                                 | 🔴 DANGER ZONE                                   |
| `wait-for-argocd.sh`, `verify-buildsha.sh`, `aggregate-decide-outcome.sh`, `resolve-cell-state.sh`    | Deployment gates (Axioms 14/15/19). Read + assert only.                                                          | 🟡 FREEZE EXPANSION (load-bearing; don't extend) |
| `flight-preview.yml`, `auto-merge-release-prs.yml`, `promote-preview-digest-seed.yml`                 | Preview-flight (latest-wins) + release contract boundaries. Hardcoded check-name lists; main-merge side-effects. | 🟡 FREEZE EXPANSION                              |

### The behemoth

| Surface                                                                                                               | Owns                                                                                                                                                                                                                                                                                                                                        | Class          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `scripts/ci/deploy-infra.sh` (2,167 lines)                                                                            | SSH/rsync Compose; `.env` assembly (70+ secrets via `printf %q`); Postgres/Doltgres/Temporal superuser reconciliation incl. live `ALTER USER ... PASSWORD`; per-node k8s secret creation; OpenFGA store bootstrap; Argo Image-Updater bootstrap; Caddy edge render; systemd backup timer. Touches candidate-a, **preview, and production**. | 🔴 DANGER ZONE |
| `provision-env-vm.sh`, `bootstrap.sh`, `reconcile-env-substrate.sh`, cloud-init `bootstrap.yaml`/`bootstrap-k3s.yaml` | Cold-start orchestration: Tofu apply + git `deploy/*` seed + `kubectl apply`, three state surfaces, no transaction semantics. k3s/Argo installed imperatively (not image-baked, not GitOps-managed).                                                                                                                                        | 🔴 DANGER ZONE |

`deploy-infra.sh` is already named in `ci-cd.md` as transitional: it "is NOT a DB-credential writer" (line 243) and its preview/prod Compose `.env` rendering is "the remaining transitional copy," with the stated alignment target being to **move the VM/Compose tier into k8s** (Ingress + cert-manager + ESO + a DB-provision Job; line 326). This doc freezes its growth in the meantime.

## Freeze list — what stops growing now

1. **`deploy-infra.sh`** — no new responsibility. No new secret, service, DB role, or `kubectl`/`ALTER` path. Bug-fix patches to existing paths only. Its line count is a **ratchet**: PRs may not increase it (see Smallest Next PR).
2. **`candidate-flight.yml` / `promote-and-deploy.yml`** — no new inline decision logic in `run:` blocks. New per-node behavior goes into the catalog + a `scripts/ci/lib/*.sh` function called by the workflow, never a fresh inline `case`/`if` tree.
3. **New `.github/workflows/*.yml` deploy/promote/provision workflows** — do not add one. The lanes are fixed: PR safety lane + main promotion lane + the levers (`ci-cd.md` "Workflow Design Targets," rule 1 & 4). A new environment or node does **not** earn a new workflow.
4. **New `scripts/ci/*.sh` that mutates infra/secrets/prod** — do not add one. Extend an existing primitive (`promote-k8s-image.sh`, `secret-materialize.sh`, `reconcile-node-substrate.sh`) or, better, express the intent declaratively in catalog/overlay/ESO.
5. **PR-shaped artifact identity** (`pr-*`, `mq-*`, `preview-*` tags) — frozen per [`legacy-cicd-to-remove.md`](./legacy-cicd-to-remove.md); migrate toward `image_repository:sha-<sourceSha>`, do not deepen.
6. **Imperative cloud-init provisioning** (`bootstrap.yaml` get.docker.com / get.k3s.io) — no new install steps. The forward direction is a golden image (Packer) — `bootstrap.yaml:127` already tracks this.

## Allowed-change policy for existing `.sh` and CI YAML

A four-question gate. If a change to a 🟡/🔴 file is none of the first three, it is platform work and routes per the table below — it does **not** land as more bash/YAML.

| Change is…                                                                                                         | Allowed in place?                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A **bug fix** to an existing path (correctness, a guard, an injection fix, a failing gate)                         | ✅ Yes — minimal patch.                                                                                                                         |
| A **catalog-driven** edit (new node/service via `infra/catalog/*.yaml`, picked up by existing loops)               | ✅ Yes — that is the design (`CATALOG_IS_SSOT`).                                                                                                |
| **Tightening a guard** (fail-closed instead of fail-soft, marker-ordering, dry-run, a redaction)                   | ✅ Yes — strictly improves a DANGER ZONE.                                                                                                       |
| **New branching logic, env policy, promotion semantics, secret handling, domain rules, or app-lifecycle behavior** | ❌ No — this is platform work. Express it as a catalog field, an overlay/AppSet, an ESO declaration, or a stable invariant in `ci-cd.md` first. |

Heuristic: _if the request needs a new `if`, a new env var threaded through SSH, or a new "when X then deploy Y" rule, it is platform work, not script work._

## Future-request routing table — "if the request is X, build it in Y"

| Request                                                                                 | Build it in                                                                                                                                                                                                                      | Not in                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New Node app deployment                                                                 | `infra/catalog/<node>.yaml` row → generators render AppSet + overlay → existing flight                                                                                                                                           | a new workflow or `deploy-infra` branch                                                                                                                                                                                                                                        |
| Preview environment                                                                     | Kustomize overlay + Argo Application (already per-`(env,node)`)                                                                                                                                                                  | new YAML                                                                                                                                                                                                                                                                       |
| Prod promotion                                                                          | Digest carry-forward through `promote-and-deploy.yml` (frozen) — same digest proven on candidate→preview                                                                                                                         | a rebuild or a new promote path                                                                                                                                                                                                                                                |
| Rollback                                                                                | `git revert` on the `deploy/<env>-<node>` branch; Argo reconciles                                                                                                                                                                | an SSH/`kubectl` rollback script                                                                                                                                                                                                                                               |
| Domain routing                                                                          | catalog `node_port` + `render-caddyfile.sh` (catalog-driven). Forward: Ingress + cert-manager                                                                                                                                    | hand-edited Caddyfile or `deploy-infra` edge logic                                                                                                                                                                                                                             |
| Env / secret wiring                                                                     | `infra/secrets-catalog.yaml` declaration → ESO `ExternalSecret` → Reloader                                                                                                                                                       | a new secret threaded through `deploy-infra.sh` `.env`                                                                                                                                                                                                                         |
| Image tagging                                                                           | `scripts/ci/lib/image-tags.sh` (one-file edit)                                                                                                                                                                                   | hardcoded target lists in workflows                                                                                                                                                                                                                                            |
| App bootstrap                                                                           | `infra/k8s/base/node-app/` + overlay patch                                                                                                                                                                                       | imperative VM steps                                                                                                                                                                                                                                                            |
| Tenant / app provisioning                                                               | catalog row + per-node AppSet + substrate-readiness lane (Axiom 22)                                                                                                                                                              | bespoke provisioning logic                                                                                                                                                                                                                                                     |
| Health / readiness                                                                      | k8s probes in base + `verify-buildsha.sh` `/version.buildSha` contract (Axiom 19); off-cluster workloads use the dedicated `ComputeWorkload` status controller                                                                   | `/readyz`-as-rollout-proof or a request-lifecycle/background-timer reconciler                                                                                                                                                                                                  |
| Resource sizing                                                                         | Kustomize overlay `resources:` patch                                                                                                                                                                                             | VM-side edits                                                                                                                                                                                                                                                                  |
| Database setup                                                                          | node declares `packages/postgres` schema; operator provisions per-node DB via the substrate lane (`materialize → reconcile`, Axiom 22) + ESO                                                                                     | a new DB path in `deploy-infra.sh`                                                                                                                                                                                                                                             |
| Operator resolves a node (list / id→slug / id→internal URL)                             | operator app reads its **DB registry** (`resolveNodeRegistry` / `listRoutableNodes`) + the `http://<slug>-node-app:3000` convention (`internalNodeAppUrl`)                                                                       | a static `COGNI_NODE_ENDPOINTS` map on the operator app, or splicing a configmap at node-formation. The static map is **worker-only** (the DB-less `scheduler-worker` must consume a catalog-rendered CSV)                                                                     |
| Any Cherry-resident caller addresses a node (`PLACEMENT_DECIDES_THE_ADDRESS`, bug.5094) | resolve the row's `deployment_provider.<env>` (default `k3s`): `k3s` → the in-cluster Service convention, `akash` → the node's public canonical URL, the same `host_for_node`/`hostForNode` host its `ComputeWorkload` publishes | assuming `http://<slug>-node-app:3000` unconditionally — a node placed off-cluster has no Service, so the caller dies on NXDOMAIN while the node is healthy on its public URL. Also wrong: a second list of "the akash nodes" anywhere; placement is declared once, on the row |
| Operator convenience command                                                            | thin wrapper that calls the above; **zero** platform logic of its own                                                                                                                                                            | a script that grows its own promotion/secret/env brain                                                                                                                                                                                                                         |

Routing target definitions (the consultant's seven homes, mapped to this repo):

- **OpenTofu** (`infra/provision/cherry/`) — cloud infra, VMs, IAM/keys, persistent infra. (DNS is still imperative Cloudflare curl — a known gap, see below.)
- **Kustomize** (`infra/k8s/base` + `overlays`) — manifests + env overlays.
- **Argo CD** (`infra/k8s/argocd`) — reconciliation + promotion state.
- **ESO + OpenBao** (`infra/secrets-catalog.yaml` + `infra/k8s/secrets`) — secret declaration + sync. (SOPS/ksops exists but age keys are still placeholders — `task.0284`.)
- **CI** (`pr-build.yml`, `ci.yaml`) — test/build/push artifact only; no deploy brain.
- **Scripts** (`scripts/ci/lib/*.sh`, `scripts/ops/*`) — thin operator/CI wrappers only.
- **Platform contract** (`infra/catalog/*.yaml`, `.cogni/node.yaml`) — reusable deployment-intent declaration.

## Minimal platform contract for a Node app deployment

The golden path already exists; this names it so future work targets it instead of inventing a parallel one. A node is deployable when, and only when:

```
infra/catalog/<node>.yaml           # declares: type:node, node_port, source_repo, image_repository, deploy branches, envs
  → render-node-appset.sh           # → infra/k8s/argocd/<env>-<node>-applicationset.yaml   (drift-gated)
  → render-node-overlays.sh         # → infra/k8s/overlays/<env>/<node>/kustomization.yaml  (drift-gated)
  → secrets-catalog.yaml            # → OpenBao paths + ESO ExternalSecret leaf
  → deploy/<env>-<node> branch      # digest written by promote-k8s-image.sh; Argo reconciles
  → /version.buildSha == sourceSha  # the contract proof (Axiom 19)
```

The node owns the left edge (catalog row + schema + secret declaration). The operator owns the rendering + reconciliation. **No step requires editing `deploy-infra.sh` or adding a workflow.** When a future request can't be satisfied without touching those, that gap is the platform's next real unit of work — name it, don't paper over it in bash.

## The next layer: a typed operator control plane

The freeze stops the bleak. This is where the deploy brain **goes instead**: into the `.ts` operator app, as a hexagonal capability the operator (and its AI brain) own — not bash, not `workflow_dispatch`. The model is Railway: the operator declares intent and sees live state; the substrate executes. The operator already mints overlays in TypeScript (`gens/overlay.ts`) — this extends that proven seam from _birth_ to _full deploy lifecycle_. For the human-simple "how does this actually work" walkthrough — the SEE / DEPLOY / REMOVE flows, the node-page console, and the auth model (in-cluster read-only ServiceAccount + git writes, no VPS/SSH) — see [Operator-Managed Deployments](../design/operator-managed-deployments.md).

**One control plane, one port per substrate boundary — NOT one God-port.** The
ports below look like four interfaces; they are one control plane expressed
hexagonally — **one adapter boundary each** (Argo/GitHub · OpenBao · Cherry/Akash),
because merging distinct substrates into a single interface is the actual
anti-pattern. What makes them a _family_ and not sprawl is an **identical
contract shape**, enforced by review, not inheritance:

> **`OPERATOR_PLANE_CONTRACT`** — every control-plane write is `(node_id, env)`-scoped,
> resolves the node **once** via the shared registry, gates on OpenFGA `node:<id>`,
> executes with the **operator's own** in-cluster identity, and the caller holds
> **only an API key** (no kube/vault/compute cred). Reads (`DeployCapability`) are
> the freely-callable CQRS half — never carry a gated write. The umbrella is this
> shape + the operator composition root, **and** a shared `withNodeRbac(action)`
> route helper (the node-resolve + authz gate is currently copy-pasted across the
> secrets/logs/flight routes — that duplication is the DRY debt to retire, not the
> port split).

**Write vs read are different homes** (this corrects the earlier draft):

| Layer                 | Port                                            | Substrate      | Owns                                                                                                                                                           | Status                                                                                                                                                                          |
| --------------------- | ----------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deploy WRITES**     | **`OperatorDeployPlanePort`** (operator-LOCAL)  | Argo / GitHub  | `flight` + app `promote` + operator-only production `infra reconcile` (+ later `rollback`/`scale`) — App-dispatched, RBAC-gated, with the artifact verify-gate | flight ✅ · promote ✅ · infra reconcile ✅                                                                                                                                     |
| **Secret WRITES**     | **`OperatorSecretsPlanePort`** (operator-LOCAL) | OpenBao        | node-owner `source:human` secret **values** (`writeSecret({nodeId, env, key})`) — `can_manage_secrets`-gated, env-param (D1), per-env OpenBao policy           | candidate-a ✅ (proven 200) · prod 503 (`bug.5007`)                                                                                                                             |
| **Deploy READS**      | `DeployCapability` (`@cogni/ai-tools`)          | Argo (read)    | env/node deploy-state awareness for the brain + dashboard. **Read-only — no writes.**                                                                          | v0 read-only                                                                                                                                                                    |
| **Compute substrate** | `ComputeResourcePort`                           | Cherry → Akash | provision/release a cluster, report capacity + cost, **settle payment**                                                                                        | **READ-NOW / SETTLE-LATER** — balance/cost reads shipped (Cherry); writes (`provision`/`release`/`settle`) deferred — only `settle()` (Cosmos/axlUSDC) is genuinely Akash-gated |

`OperatorSecretsPlanePort` is the **secrets row of the same plane**: operator-local
(a gated write, not a brain tool — like `OperatorDeployPlanePort`), env-parameterized
(D1, mirroring `dispatchNodePromote({env})`), resolving the node via the same
runtime registry the node UI + RBAC use (`resolveNodeRegistry`, keyed by `node_id`),
gated by OpenFGA `node.manage_secrets`. It is the one control-plane write that cannot
be git-declarative (a secret value can't transit git/`workflow_dispatch`), so it
self-logins to OpenBao with the operator pod's own projected SA token rather than
dispatching a workflow — the only mechanism difference from the deploy port.
Design: [`node-self-serve-secrets.md`](../design/node-self-serve-secrets.md).

**`OperatorDeployPlanePort`** (`nodes/operator/app/src/ports/deploy-plane.port.ts`, created #1562/#1550/#1572) is **the** operator deploy control plane: operator-local _by design_, deliberately kept **out of** the shared AI-tool capabilities because deploy dispatch is a gated operator action, not a freely-callable brain tool. Its deploy writes are `dispatchNodeRefCandidateFlight`, app promotion, and `reconcileNodeInfra` — all App-dispatched; flight retains `prepareNodeRefCandidateFlight`'s artifact verify-gate. The infra verb is deliberately narrower than a generic workflow dispatcher: production only, operator-node only, fixed `full` mode, and the adapter resolves the existing production source pin so the caller cannot select a workflow/ref/SHA or advance the app. **Environment-scoped parent identity is mandatory:** candidate-a's test App targets only `NODE_SUBMODULE_PARENT_{OWNER,REPO}` in `cogni-test-org`; production targets `Cogni-DAO/cogni`. V0 temporarily reuses `node.promote_production` as a two-phase bootstrap bridge because this same infra lever must first deploy the OpenFGA model that can express a dedicated permission. The least-privilege destination is a separate `production_infra_promoter → can_reconcile_production_infra` grant, after the first reconcile removes that bootstrap dependency ([story.5028](https://cognidao.org/work/items/story.5028)). It does **not** create a second control plane: it dispatches the existing `candidate-flight.yml` / `promote-and-deploy.yml` workflows. Argo stays the reconciler; git stays the deploy-state truth (Axioms 4 & 6).

`DeployCapability` (`@cogni/ai-tools`) is **read-only** — env-visibility for the brain/dashboard. (An earlier draft of this doc wrongly put deploy writes here, duplicating `OperatorDeployPlanePort`; that was corrected — writes are operator-local.)

```
   OPERATOR APP (.ts)                          THE SUBSTRATE (declarative)
   ─────────────────                           ───────────────────────────
   AI brain + humans + dashboard               catalog · overlays · Argo · ESO
        │  (typed control + viz)                        ▲  (desired state in git)
        ▼                                               │
   OperatorDeployPlanePort ──flight + promote + infra──►│  Argo reconciles → cluster
        │  (App-dispatched, RBAC-gated WRITES)          │
   OperatorSecretsPlanePort ─writeSecret({node,env})──► OpenBao (self-login; the one
        │  (RBAC-gated; NOT git-declarative)             non-git-declarative write) → ESO
   DeployCapability  ──reads Argo state──────────────►  │
        ▼
   ComputeResourcePort ──provision/pay──► Cherry (Tofu)  →  Akash (crypto, decentralized)
                                          ▲ MVP stopgap      ▲ the real target
```

### Prototype interfaces

The read-only `DeployCapability` v0 ships in this PR as a real interface at
[`packages/ai-tools/src/capabilities/deploy.ts`](../../packages/ai-tools/src/capabilities/deploy.ts)
(type-only, exported from the `@cogni/ai-tools` barrel alongside `VcsCapability` — no runtime yet).

**`ComputeResourcePort` is NOT Akash-gated — the deferral was over-broad.** Its READ half (cost/balance)
is provider-agnostic and ships now: a real interface at
[`packages/ai-tools/src/capabilities/compute.ts`](../../packages/ai-tools/src/capabilities/compute.ts)
(`balances(): Promise<readonly ComputeBalance[]>`), a runtime `CherryComputeAdapter`, and an **on-demand**
session/RBAC-gated read (`GET /api/v1/compute/balances`) — the pull surface for the dashboard fleet view and
agents. A balance read is a pure recomputable read, so it is **not** wrapped in a Temporal scheduled job (that
would be the over-engineering the [temporal-patterns](./temporal-patterns.md) boundary rule warns against, and a
Loki/metrics sink made it invisible). This closes the spend-awareness gap that silently took preview down on
2026-06-19 (story.5011); the dashboard fleet view + per-env/per-VM consumption breakdown + unattended alerting
are the next slice (story.5013). Only the WRITE verbs (`provision`/`release`/`settle`) stay deferred, and only
`settle()` (Cosmos multisig / axlUSDC) is genuinely Akash-shaped — Cherry has its own provision (OpenTofu) and
pay paths. The sketch below shows the full port; the read half is built, the writes are not.

```ts
// packages/ai-tools/src/capabilities/deploy.ts  — sibling to vcs.ts (SHIPPED in this PR, read-only v0)
//   Invariants: CAPABILITY_INJECTION, ADAPTER_SWAPPABLE, ARGO_IS_TRUTH (read; never a parallel control plane)
export interface DeployCapability {
  // v0 — READ-ONLY (powers the per-node deployment view + brain awareness)
  listEnvironments(): Promise<readonly EnvSummary[]>;
  getDeployState(p: { env: string; node: string }): Promise<NodeDeployState>; // sourceSha, digest, health, replicas
}
// Control verbs (flight · promote · later rollback/scale) are NOT on DeployCapability — they live on
// OperatorDeployPlanePort (operator-local, App-dispatched, RBAC-gated). DeployCapability stays read-only:
// a freely-callable brain tool must never carry a gated deploy write. Reads here, writes on the port.

// READ half SHIPPED in @cogni/ai-tools/capabilities/compute.ts (provider-agnostic balance awareness).
// WRITE half DEFERRED; only settle() is genuinely Akash-gated (Cosmos/axlUSDC).
//   Payment/settlement lives ONLY here; DeployCapability never sees it.
export interface ComputeResourcePort {
  // --- read half (BUILT, not Akash-gated) ---
  balances(): Promise<readonly ComputeBalance[]>; // provider-agnostic remaining/currency per account
  capacity(p: { leaseId: string }): Promise<ResourceCapacity>; // uniform vCPU/mem/storage units, not provider units
  // --- write half (DEFERRED) ---
  provision(p: {
    env: string;
    spec: ResourceCapacity;
  }): Promise<ProvisionOutput>; // → ClusterEndpoint, cost, leaseId
  release(p: { leaseId: string }): Promise<void>;
  settle(p: { leaseId: string }): Promise<SettlementResult>; // async side-effect; Cosmos key via ConnectionBrokerPort — the one genuinely Akash-gated verb
}
```

The provider seam is a **1:1 adapter swap** in the operator bootstrap — `CherryComputeAdapter` → `AkashComputeAdapter`, no change to `DeployCapability` or any port signature. The leak to avoid: never let Akash specifics (SDL, Cosmos, `pending_bid`, USDC) escape `ComputeResourcePort` into the deploy plane or the dashboard. Cluster endpoints, capacity, and cost are expressed in **provider-agnostic** types; the adapter converts.

### Phased rollout (no throwaway, MVP-disciplined)

| Phase                                    | Build                                                                                                                                                                                                                                                                                        | Defer                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **v0**                                   | read-only `DeployCapability` over live Argo state + a dashboard view; AI tools `deploy_get_state` / `deploy_observe` next to the `vcs_*` tools; **`ComputeResourcePort` read half** (`balances()` + `CherryComputeAdapter` + on-demand RBAC read `GET /api/v1/compute/balances`, story.5011) | the registry table, control verbs, `ComputeResourcePort` **write** verbs |
| **P1**                                   | `OperatorDeployPlanePort` write verbs (`dispatchNodeRefCandidateFlight` ✅ · `dispatchNodePromote` ✅ · later rollback/scale); `compute_resources` registry table (mirrors `mcp_deployments`) as the dashboard read-cache                                                                    | multi-provider                                                           |
| **P2 — ADAPTER SHIPPED / ROUTE RETIRED** | `ComputeResourcePort` write half + `AkashComputeAdapter` exist, but imperative `POST /api/v1/compute/deployments` is tombstoned. A deploy-branch `ComputeWorkload` is the sole desired-state seam; the dedicated controller owns lifecycle/status/finalization.                              | story.5016 integration renderer + pre-merge candidate E2E proof          |

### P3 — Crossplane owns reconciliation; Cogni owns the transaction (task.5095)

The legacy ComputeWorkload controller has been **RETIRED** (story.5016 — deleted from the tree; no
environment deploys it; its Console key is revoked). Its responsibilities are now split along one
line: _generic lifecycle machinery is bought, the Akash transaction is built._

| Concern                                                                                                              | Owner                                                                             | Why                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watches, retries, backoff, status/conditions, finalizers, composition, deletion policy                               | **Crossplane** (provider-http + functions, installed dormant in task.5094)        | Battle-tested OSS reconciliation; nothing Cogni-specific lives here.                                                                                                              |
| Akash Console transaction mapping, SDL construction, provider screening, wallet custody, durable allocation receipts | **Cogni's private Akash transaction actuator** (`src/features/compute/akash-tx/`) | An Akash transaction can succeed while its response is lost; only a Cogni-owned pre-transaction receipt makes the resulting paid lease recoverable. No OSS controller knows this. |

The actuator is a **service, not a controller**: a private ClusterIP HTTP surface with four typed logical
operations (`observe` / `create` / `update` / `delete`), each one bounded attempt, and no watch, timer,
finalizer, retry loop, or leader election. Its irreducible behaviours are:

1. **Wallet-global serialization** — at most one `preparing` allocation per wallet scope, enforced by a
   partial unique index in Postgres (`akash_tx_allocations`), held only for the unrecoverable window
   between reading the pre-transaction cursor and durably recording the allocated handle.
2. **Provider screening** — audited/online/uptime/blacklist screening stays in `AkashComputeAdapter`; the
   actuator never sees a bid, a dseq, or an escrow figure.
3. **SDL construction** — `buildAkashSdl` remains the single place Akash's deployment language exists.
4. **Post-response-loss recovery** — the cursor is durable _before_ the Console POST, so a lost response is
   resolved by adopting the unique post-baseline allocation, or it fails closed. It is never healed by a
   fresh create, and no timer ever releases an unresolved slot.
5. **Migration as a release step, NEVER a payment precondition** (task.5135, superseding bug.5140) — bug.5116
   wanted a freshly born node to have its schemas, and bug.5140 implemented that want as a precondition of
   every paid transaction. That was the wrong seam. Node `toks5` proved it in production: a valid XR in
   `cogni-production` with a valid image digest whose migration never ran, so the actuator was NEVER CALLED,
   `akash-lease` reported "not yet ready" **1044 times**, and the node never existed in any environment —
   silent, unbounded, and with no alarm, while the same actuator minted happily for five other nodes.

   Renting compute proves nothing about a database. The per-digest migration now rides on the actuator's
   UNPAID `observe` tick as `AkashTxMigrationStep`, together with the `workload` + `environment` that say
   whose database it is (the actuator refuses to infer either — inferring them is how "which environment's
   DB?" became a payment-plane question at all). Its phase is REPORTED on the observation and surfaced as
   `status.migration.phase`; a `failed` phase becomes `status.failure.reason: MigrationFailed`. `create` and
   `update` carry no migration, cannot be refused by one, and need no database-adjacent capability. The
   runner is still the same `ComputeWorkloadMigrationPort` the frozen controller used — including its
   reclassification of a `DeadlineExceeded` Job with no failed migrate container as an infrastructure retry
   — so the two lanes cannot disagree about whether a digest has migrated.

   _What bounds a bad schema now:_ the workload gets its lease, cannot serve its exact SHA, and trips
   `bootPolicy.bootDeadlineSeconds` (`BOOT_SLO_OR_CLOSE`). Loud and bounded, instead of never created.

   _Why still in the actuator process and not a composed resource:_ a Composition cannot compose the
   migration Job. The installed package set is provider-http + go-templating + auto-ready, and
   `provider-kubernetes` v0.18.0 still ships no namespaced `.m.crossplane.io` types. Co-hosting it behind an
   unpaid seam is the decoupling; relocating the process is the follow-up.

6. **Node-bound spend receipts** — the same receipt that survives a lost response also says WHO consumed
   the infrastructure (task.5103). `node_id`, `environment`, the composite `uid`/`generation` and the
   `cogniKey` are NOT NULL columns written by the INSERT that opens the wallet slot, so a paid lease that
   nothing can attribute is unreachable rather than merely discouraged. Identity arrives **explicitly** on
   the wire (`identity` is required on `create` and `update`; omitting it is a 400) and is never derived:
   `cogniKey` is an idempotence token, the workload slug is renameable, and the Console credential says who
   PAID, not who CONSUMED. Those are separate facts — `node_id` (consumption, the sole cost-grouping key),
   `wallet_scope` (custody), and the `billing_account_id` / `dao_address` / `user_id` a Cogni-sponsored v0
   deliberately does not carry. A key whose receipt binds a different node or environment is a terminal
   `identity_conflict` (422), never a re-binding.

Refusals are observable by construction: every refusal emits a structured log marker
(`akash_tx_wallet_allocation_blocked`, `akash_tx_allocation_unresolved`, `akash_tx_allocation_recovered`,
`akash_tx_identity_conflict`, `akash_tx_receipt_absent`)
_before_ it answers. Writing a refusal only into CR status is what made a fleet-wide wallet deadlock
invisible (bug.5115). The release step is not a refusal but is held to the same rule: every phase emits
`akash_tx_migration_{succeeded,running,failed,unavailable}` or
`akash_tx_migration_capability_missing` before it is reported.

**ONE_WALLET_ONE_WRITER is a precondition, not a convention.** Wallet-global serialization only
recovers a lost response if exactly one process spends from the wallet — a second writer's lease is
indistinguishable from the actuator's own.

**Centralized managed account, one ACTIVE writer per wallet — v0** (story.5016, BINDING;
supersedes the earlier dedicated-Console-account-per-environment activation prerequisite).
candidate-a pins the managed test account/credential; preview pins NO wallet (its control plane is
installed but dormant/unfunded, so it lands no ComputeWorkload and never actuates); production
remains on its isolated dedicated account. Each wallet therefore has exactly one active writer —
because the single-writer index is per-database, two envs sharing one wallet could not be
serialized, so preview deliberately stays unfunded rather than becoming a second writer on the
candidate-a test wallet. Every writing environment structurally disables its legacy ComputeWorkload
controller before enabling its actuator, stores the credential only under that environment's
dedicated actuator OpenBao path, and forbids Console/manual writes. A manual or second writer on a
wallet invalidates cursor recovery. Distinct funded accounts per funded environment remain later
hardening, not an activation prerequisite; this deliberate v0 trade removes account setup from the
path to proving the full candidate → preview → production ladder.

`features/compute/akash-tx/akash-tx-wallet.ts` enforces what remains checkable at wiring time:
`AKASH_ACTUATOR_CONSOLE_API_KEY` is required with no fallback, and the **non-secret** pinned
`AKASH_ACTUATOR_ACCOUNT_ID` (plain Deployment config — a public on-chain address, never an OpenBao
key) must be present and must match the account the live Console read reports, or the process exits
before it listens. **The actuator never possesses `AKASH_CONSOLE_API_KEY`**: task.5095 projected it
purely to byte-compare, which made the actuator hold the very wallet it claimed isolation from, and
still only proved "different bytes" rather than "the right wallet". The ledger scope is
`akash-console:<environment>`, derived from the environment rather than the secret so rotation cannot
orphan in-flight receipts. Each environment's durable ledger serializes its local actuator and
recovers its own lost responses; the shared-account v0 depends on the no-manual-write and
one-local-actuator rules above. `docs/spec/ci-cd.md` Axiom 26 is the authority for the current
cross-environment account model.

Custody is OpenBao under a **dedicated service boundary**, not the broad operator bucket. The catalog
declares `tier: A1, service: akash-tx-actuator` for both `AKASH_ACTUATOR_CONSOLE_API_KEY` and
`AKASH_TX_ACTUATOR_TOKEN`, so they land at `cogni/<env>/akash-tx-actuator/*` and are projected by the
actuator's **own** ExternalSecret into `akash-tx-actuator-env-secrets`, which only the actuator pod
mounts (an explicit least-privilege `items:` list, never `envFrom`). This is load-bearing: the public
operator app consumes the **entire** `cogni/<env>/operator` bucket via `dataFrom: extract` →
`operator-env-secrets` → `envFrom`, so a credential parked there is readable by the internet-facing
process and an operator-app compromise would steal the wallet. The operator Deployment has no
ExternalSecret, `envFrom`, or volume naming the actuator's path or Secret. Only `DATABASE_URL` is
projected from the operator bucket, because the receipts table lives in the operator's own Postgres.
`AKASH_TX_ACTUATOR_TOKEN` is `source: agent` with an existing `generate: {kind: hex, bytes: 32}` —
minted idempotently by `scripts/ci/secret-materialize.sh`, **never hand-typed** (the killer rule).
Git, workflows, Crossplane resources, and VM `.env` files carry the **name** only — never the value.
The receipts table itself (`akash_tx_allocations`) is operator-local schema
(`@shared/db/akash-tx-allocations`), deliberately not in `@cogni/db-schema` and never in Doltgres: it
is system-of-record evidence that money may have been spent.

**Prior art:** the Argo-GitOps foundation this builds on is [PR #628](https://github.com/Cogni-DAO/cogni/pull/628) (`task.0149`, open since 2026-03-25, superseded piecemeal by per-node flighting). The registry/adapter-swap pattern is proven in [`mcp-control-plane.md`](./mcp-control-plane.md). The decentralized-compute target is `infra/provision/akash/FUTURE_AKASH_INTEGRATION.md`. **Cherry Servers is the explicit MVP stopgap; Akash is the crypto-native end state.**

## Enforcement

This policy lands with three teeth:

1. **Reviewer skills cite it.** [`devops-expert`](../../.claude/skills/devops-expert/SKILL.md) and [`git-app-expert`](../../.claude/skills/git-app-expert/SKILL.md) read this doc first and flag any PR that grows the frozen deploy brain instead of routing to the substrate or `DeployCapability`. `devops-expert` is already a required reviewer on `scripts/ci/**`, `.github/workflows/**`, `infra/**`, `deploy/*`.
2. **The seam exists.** The read-only `DeployCapability` ships here, so "route it into the `.ts` control plane" is a real destination, not a promise.

The remaining tooth — a **machine-checked growth ratchet** — is the smallest next PR: a check (added to the existing `static`/`unit` job, not a new workflow) that fails when `scripts/ci/deploy-infra.sh` exceeds its current line count, or when a net-new infra/secret-mutating `.sh` lands under `scripts/ci/` without a `platform-waiver` label. Deferred to its own PR so it can be tuned without false-failing in-flight bug-fix PRs that legitimately touch `deploy-infra.sh`.

## Explicit — what NOT to build yet

- **No `deploy-infra.sh` rewrite / decomposition.** It works in prod. Freeze it; migrate responsibilities out one at a time only when an independent reason (the k8s/Compose-tier move, Axiom 22 convergence) pulls them — never as a standalone refactor.
- **No general-purpose Kubernetes CRDs or controllers.** The one named exception is
  `compute.cogni.io/ComputeWorkload` (Kubernetes cannot natively observe or finalize a
  provider-hosted workload). Git/Argo owns desired `spec`; reconciliation is now **Crossplane**
  (the `XComputeWorkload` composite) calling the private **`akash-tx-actuator`** for the bounded
  observe/create/update/delete transaction, finalization, and provenance in `status` — the
  bespoke leader-elected `compute-workload-controller` process (task.5064) that once owned this
  was RETIRED, story.5016. It is not a Crossplane-like framework and may not grow provider
  vocabulary, workflow logic, or a second desired-state registry.
- **No remote Tofu backend / Cloudflare-as-Tofu-resource migration** as speculative cleanup. Real gaps (ephemeral Tofu state, imperative DNS) are logged; fix them when a provisioning incident demands it, not preemptively.
- **No new flags/options for theoretical flexibility.** `--k8s-secrets-only` is already legacy (ESO supersedes it). Don't add siblings.
- **No second CI system** to "replace GitHub Actions." Keeping deploy-brain out of CI (above) is what makes that swap cheap later; doing the swap now is not the constraint.
- **No golden-image (Packer) build yet** — it is the right direction for cloud-init, but it is a provisioning-speed improvement, not a freeze blocker. Track it; don't gate on it.

## Known gaps this policy makes visible (not new work orders)

These are surfaced so they route correctly when touched — they are not a decomposition backlog:

- **Cloudflare DNS is the only proprietary lock-in** in an otherwise all-OSS stack (OpenTofu/k3s/Argo/Kustomize/Caddy/OpenBao+ESO), and the only non-declarative path (imperative API curl in `provision-env-vm.sh`; won't self-heal on UI drift). OSS target: **`external-dns` (CNCF)** + cert-manager + Let's Encrypt — declarative, multi-provider, drops the bespoke curl. Same Phase-3 "move ingress into k8s" move that retires the `deploy-infra.sh` edge/Caddy responsibility.
- ksops/SOPS age keys are placeholders (`task.0284`); secrets-at-rest encryption is not yet end-to-end.
- Tofu state is ephemeral on the runner; re-run idempotency leans on `tofu import` lists.
- Three byte-exact render paths (shell CI, operator TS mint, CLI scaffold) — converge to one renderer; do not add a fourth.
- `deploy-infra.sh` is only exercised on preview/prod, never candidate-a (`ci-cd.md` Known Unknowns) — a regression is invisible until a promote. The k8s/Compose-tier move closes this.
