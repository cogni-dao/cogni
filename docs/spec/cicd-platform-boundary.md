---
id: spec.cicd-platform-boundary
type: spec
title: CI/CD Platform Boundary & Freeze Policy
status: active
trust: draft
summary: "Where new deployment/platform work goes and what stops growing. Classifies every CI/CD surface (scripts, workflows, OpenTofu, Kustomize, Argo, Compose, secrets) into leave-alone / freeze-expansion / future-home / danger-zone, gives a request→home routing table, the allowed-change policy that keeps the `.sh`+YAML pseudo-platform from accreting, and the typed `.ts` operator control plane (DeployCapability + ComputeResourcePort, Cherry→Akash) that the deploy brain migrates INTO."
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

| Plane                      | What it is                                                                                                                            | Freeze applies?                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator control plane** | This monorepo's deploy brain: `scripts/ci/**`, `.github/workflows/**` deploy/promote/provision logic, `infra/**`                      | **Yes.** New platform behavior routes to the substrate (Tofu/Argo/Kustomize/ESO/catalog), not to new bash/YAML.                                                                                                  |
| **Node sovereignty**       | A standalone node's own `.github/workflows/` + thin scripts that build & push its image (`BUILD_ONCE_PROMOTE_DIGEST`, `FORK_FREEDOM`) | **No.** External nodes keep GitHub Actions + `.sh` for portability. The node declares shape; the operator wires the env. This is a feature, not debt — see [`node-ci-cd-contract.md`](./node-ci-cd-contract.md). |

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

| Surface                                                                                               | Owns                                                                                                        | Class                                            |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `promote-k8s-image.sh`, `promote-build-payload.sh`, `update-source-sha-map.sh`, `aggregate-rollup.sh` | Write digests + provenance into overlays/deploy branches. `sed`-based YAML edits, git push to `deploy/*`.   | 🔴 DANGER ZONE                                   |
| `candidate-flight.yml`, `promote-and-deploy.yml`                                                      | App-digest promotion orchestration. ~1,100 + ~1,000 lines; 3-way inline digest-resolution trees; SSH to VM. | 🔴 DANGER ZONE                                   |
| `candidate-flight-infra.yml`, `provision-env.yml`                                                     | Infra/Compose lever + cold-start provisioning. Mutate VM + secrets + Cloudflare.                            | 🔴 DANGER ZONE                                   |
| `wait-for-argocd.sh`, `verify-buildsha.sh`, `aggregate-decide-outcome.sh`, `resolve-cell-state.sh`    | Deployment gates (Axioms 14/15/19). Read + assert only.                                                     | 🟡 FREEZE EXPANSION (load-bearing; don't extend) |
| `flight-preview.yml`, `auto-merge-release-prs.yml`, `promote-preview-digest-seed.yml`                 | Preview-lease + release contract boundaries. Hardcoded check-name lists; main-merge side-effects.           | 🟡 FREEZE EXPANSION                              |

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

| Request                      | Build it in                                                                                                                                  | Not in                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| New Node app deployment      | `infra/catalog/<node>.yaml` row → generators render AppSet + overlay → existing flight                                                       | a new workflow or `deploy-infra` branch                |
| Preview environment          | Kustomize overlay + Argo Application (already per-`(env,node)`)                                                                              | new YAML                                               |
| Prod promotion               | Digest carry-forward through `promote-and-deploy.yml` (frozen) — same digest proven on candidate→preview                                     | a rebuild or a new promote path                        |
| Rollback                     | `git revert` on the `deploy/<env>-<node>` branch; Argo reconciles                                                                            | an SSH/`kubectl` rollback script                       |
| Domain routing               | catalog `node_port` + `render-caddyfile.sh` (catalog-driven). Forward: Ingress + cert-manager                                                | hand-edited Caddyfile or `deploy-infra` edge logic     |
| Env / secret wiring          | `infra/secrets-catalog.yaml` declaration → ESO `ExternalSecret` → Reloader                                                                   | a new secret threaded through `deploy-infra.sh` `.env` |
| Image tagging                | `scripts/ci/lib/image-tags.sh` (one-file edit)                                                                                               | hardcoded target lists in workflows                    |
| App bootstrap                | `infra/k8s/base/node-app/` + overlay patch                                                                                                   | imperative VM steps                                    |
| Tenant / app provisioning    | catalog row + per-node AppSet + substrate-readiness lane (Axiom 22)                                                                          | bespoke provisioning logic                             |
| Health / readiness           | k8s probes in base + `verify-buildsha.sh` `/version.buildSha` contract (Axiom 19)                                                            | `/readyz`-as-rollout-proof                             |
| Resource sizing              | Kustomize overlay `resources:` patch                                                                                                         | VM-side edits                                          |
| Database setup               | node declares `packages/postgres` schema; operator provisions per-node DB via the substrate lane (`materialize → reconcile`, Axiom 22) + ESO | a new DB path in `deploy-infra.sh`                     |
| Operator convenience command | thin wrapper that calls the above; **zero** platform logic of its own                                                                        | a script that grows its own promotion/secret/env brain |

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

Two layers, one first-class today:

| Layer                 | Port                  | Owns                                                                    | Provider-coupling                                                              | Status                             |
| --------------------- | --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| **App deploy**        | `DeployCapability`    | read deploy state + (later) promote/rollback/scale                      | **agnostic** — speaks Argo/k8s, so it doesn't care what's underneath           | **v0 now** (read-only)             |
| **Compute substrate** | `ComputeResourcePort` | provision/release a cluster, report capacity + cost, **settle payment** | **pluggable** — Cherry (OpenTofu) → Akash (Cosmos multisig + SDL, crypto-paid) | **deferred** until Akash is funded |

`DeployCapability` is the sibling of the existing `VcsCapability` — same `CAPABILITY_INJECTION` + `ADAPTER_SWAPPABLE` shape, same file layout (interface in `packages/ai-tools/src/capabilities/`, runtime adapter in `nodes/operator/app/src/adapters/server/`). It does **not** create a second control plane: it reads live Argo/catalog state and, for promotion, wraps the existing `dispatchCandidateFlight` seam. Argo stays the reconciler; git stays the deploy-state truth (Axioms 4 & 6).

```
   OPERATOR APP (.ts)                          THE SUBSTRATE (declarative)
   ─────────────────                           ───────────────────────────
   AI brain + humans + dashboard               catalog · overlays · Argo · ESO
        │  (typed control + viz)                        ▲  (desired state in git)
        ▼                                               │
   DeployCapability  ──reads Argo state──────────────►  │  Argo reconciles → cluster
        │           ──promote = dispatchCandidateFlight─┘
        ▼
   ComputeResourcePort ──provision/pay──► Cherry (Tofu)  →  Akash (crypto, decentralized)
                                          ▲ MVP stopgap      ▲ the real target
```

### Prototype interfaces

The read-only `DeployCapability` v0 ships in this PR as a real interface at
[`packages/ai-tools/src/capabilities/deploy.ts`](../../packages/ai-tools/src/capabilities/deploy.ts)
(type-only, exported from the `@cogni/ai-tools` barrel alongside `VcsCapability` — no runtime yet).
`ComputeResourcePort` below stays a sketch until Akash is funded.

```ts
// packages/ai-tools/src/capabilities/deploy.ts  — sibling to vcs.ts (SHIPPED in this PR, read-only v0)
//   Invariants: CAPABILITY_INJECTION, ADAPTER_SWAPPABLE, ARGO_IS_TRUTH (read; never a parallel control plane)
export interface DeployCapability {
  // v0 — READ-ONLY (powers the per-node deployment view + brain awareness)
  listEnvironments(): Promise<readonly EnvSummary[]>;
  getDeployState(p: { env: string; node: string }): Promise<NodeDeployState>; // sourceSha, digest, health, replicas
}
// Phase-1 control verbs (deployNode wraps flight · retractNode = git-revert · scaleNode = overlay patch)
// are NOT on the v0 interface — an interface only its own spec implements is speculation. They land
// when the read path ships + an adapter exists. Their shape is the phase table below.

// @cogni/compute-control (DEFERRED — only when Akash is funded)
//   Payment/settlement lives ONLY here; DeployCapability never sees it.
export interface ComputeResourcePort {
  provision(p: {
    env: string;
    spec: ResourceCapacity;
  }): Promise<ProvisionOutput>; // → ClusterEndpoint, cost, leaseId
  release(p: { leaseId: string }): Promise<void>;
  capacity(p: { leaseId: string }): Promise<ResourceCapacity>; // uniform vCPU/mem/storage units, not provider units
  settle(p: { leaseId: string }): Promise<SettlementResult>; // async side-effect; Cosmos key via ConnectionBrokerPort
}
```

The provider seam is a **1:1 adapter swap** in the operator bootstrap — `CherryComputeAdapter` → `AkashComputeAdapter`, no change to `DeployCapability` or any port signature. The leak to avoid: never let Akash specifics (SDL, Cosmos, `pending_bid`, USDC) escape `ComputeResourcePort` into the deploy plane or the dashboard. Cluster endpoints, capacity, and cost are expressed in **provider-agnostic** types; the adapter converts.

### Phased rollout (no throwaway, MVP-disciplined)

| Phase  | Build                                                                                                                                                                                   | Defer                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **v0** | read-only `DeployCapability` over live Argo state + a dashboard view; AI tools `deploy_get_state` / `deploy_observe` next to the `vcs_*` tools                                          | the registry table, control verbs, `ComputeResourcePort` |
| **P1** | control verbs (`deployNode` wraps flight; `retractNode` = git-revert); `compute_resources` registry table (mirrors `mcp_deployments`) as the dashboard read-cache                       | multi-provider                                           |
| **P2** | `ComputeResourcePort` + `AkashComputeAdapter` (Cosmos multisig, axlUSDC Stable Payments per `infra/provision/akash/FUTURE_AKASH_INTEGRATION.md`); Cherry becomes one adapter among many | —                                                        |

**Prior art:** the Argo-GitOps foundation this builds on is [PR #628](https://github.com/Cogni-DAO/cogni/pull/628) (`task.0149`, open since 2026-03-25, superseded piecemeal by per-node flighting). The registry/adapter-swap pattern is proven in [`mcp-control-plane.md`](./mcp-control-plane.md). The decentralized-compute target is `infra/provision/akash/FUTURE_AKASH_INTEGRATION.md`. **Cherry Servers is the explicit MVP stopgap; Akash is the crypto-native end state.**

## Enforcement

This policy lands with three teeth:

1. **Reviewer skills cite it.** [`devops-expert`](../../.claude/skills/devops-expert/SKILL.md) and [`git-app-expert`](../../.claude/skills/git-app-expert/SKILL.md) read this doc first and flag any PR that grows the frozen deploy brain instead of routing to the substrate or `DeployCapability`. `devops-expert` is already a required reviewer on `scripts/ci/**`, `.github/workflows/**`, `infra/**`, `deploy/*`.
2. **The seam exists.** The read-only `DeployCapability` ships here, so "route it into the `.ts` control plane" is a real destination, not a promise.

The remaining tooth — a **machine-checked growth ratchet** — is the smallest next PR: a check (added to the existing `static`/`unit` job, not a new workflow) that fails when `scripts/ci/deploy-infra.sh` exceeds its current line count, or when a net-new infra/secret-mutating `.sh` lands under `scripts/ci/` without a `platform-waiver` label. Deferred to its own PR so it can be tuned without false-failing in-flight bug-fix PRs that legitimately touch `deploy-infra.sh`.

## Explicit — what NOT to build yet

- **No `deploy-infra.sh` rewrite / decomposition.** It works in prod. Freeze it; migrate responsibilities out one at a time only when an independent reason (the k8s/Compose-tier move, Axiom 22 convergence) pulls them — never as a standalone refactor.
- **No new Kubernetes CRDs or controllers.** The substrate is ESO + Argo + Kustomize. A custom operator/controller is not justified by current pain.
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
