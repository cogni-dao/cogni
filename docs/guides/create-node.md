---
id: create-node-guide
type: guide
title: Create a New Node (Deploy)
status: draft
trust: draft
summary: Step-by-step checklist for taking a node app (nodes/<node>/) live across the full deploy matrix — candidate-a, preview, production — from catalog entry through overlays, ApplicationSets, deploy branches, and per-env provisioning.
read_when: Enabling a nodes/<node> app to deploy on candidate-a/preview/production, or automating that flow in the node wizard.
owner: derekg1729
created: 2026-05-30
verified: null
tags: [deployment, infra, node, argo, kustomize]
---

# Create a New Node (Deploy)

## When to Use This

You have a node app under `nodes/<node>/app` (a Next.js node) and you want it to **deploy across the environment matrix**: `candidate-a`, `preview`, `production`.

**Do NOT use this guide for:**

- **Services** (`services/` — Temporal workers, queue consumers, utility HTTP) → [`create-service.md`](./create-service.md).
- **On-chain DAO formation** (the wizard that deploys the DAO + token + repo-spec) → [`node-formation-guide.md`](./node-formation-guide.md). This guide is the infra-deploy slice that follows its **§8 "Deploy Infrastructure (Post-Formation)"**.

## The Governing Principle — `CATALOG_IS_SSOT`

`infra/catalog/<node>.yaml` with `type: node` is the **single declaration site** ([ci-cd.md](../spec/ci-cd.md) axiom 16). `scripts/ci/lib/image-tags.sh` derives `NODE_TARGETS` from **every** `type: node` catalog entry, and every environment's machinery follows from it:

- the PR build matrix (`detect-affected.sh`, `build-and-push-images.sh`),
- the Argo `ApplicationSet` generators (one per node per env),
- `promote-preview-seed-main.sh`, which `sha256sum`s `infra/k8s/overlays/preview/<node>/kustomization.yaml` **for every `NODE_TARGET`**.

> ⚠️ **The candidate-a-only trap (learned from #1369 / node-template).** Declaring a node in the catalog but only authoring the **candidate-a** overlay leaves the preview + production machinery expecting overlays that don't exist. Result: `Promote Preview Digest Seed` fails on `main` (`sha256sum: …/overlays/preview/<node>/kustomization.yaml: No such file or directory`) for _everyone_, and the node never reaches preview/prod.
>
> **A node is `type: node` in all three envs or none.** Enable the full matrix in one PR. The provisioning (secrets/DB/DNS, Step 6) can land after — but the overlays + AppSet entries must be complete and consistent.

## Preconditions

- [ ] `nodes/<node>/app` exists and builds (its own `Dockerfile`, Next.js app).
- [ ] DAO formed + `.cogni/repo-spec.yaml` written (`node_id`, `scope_id`) per [`node-formation-guide.md`](./node-formation-guide.md).
- [ ] A **unique `nodePort`** allocated. Current map: `operator 30000`, `node-template 30200`, `resy 30300`. Pick the next free `302xx`/`303xx` and keep it identical across all three env overlays.

## Steps

### 1. Catalog entry — `infra/catalog/<node>.yaml`

The one declaration that makes the node a build target **and** a `NODE_TARGET`. Copy `infra/catalog/operator.yaml`:

```yaml
name: <node>
type: node # MUST be "node" (drives NODE_TARGETS)
port: 3200
dockerfile: nodes/<node>/app/Dockerfile
node_id: "<uuidv4>" # real UUID, not the 000…0 placeholder
image_tag_suffix: "-<node>"
migrator_tag_suffix: "-<node>-migrate"
candidate_a_branch: deploy/candidate-a-<node>
preview_branch: deploy/preview-<node>
production_branch: deploy/production-<node>
path_prefix: nodes/<node>/
```

### 2. Wire the build matrix

`image-tags.sh` is catalog-driven (no edit), but the build/affected scripts still carry per-target cases (until task.5079 makes `build_target()` catalog-driven):

- [ ] `scripts/ci/detect-affected.sh` — add to `ALL_TARGETS` + a `nodes/<node>/*)` path case.
- [ ] `scripts/ci/build-and-push-images.sh` — `resolve_tag()` + `build_target()` cases.
- [ ] `scripts/ci/resolve-pr-build-images.sh` — mirror the `resolve_tag` case.

**Verify:** touch a file under `nodes/<node>/` → `TURBO_SCM_BASE=origin/main TURBO_SCM_HEAD=HEAD scripts/ci/detect-affected.sh` lists `<node>`.

### 3. Per-env overlays × 3 — the core

Create `infra/k8s/overlays/{candidate-a,preview,production}/<node>/kustomization.yaml`. Derive all three from an existing node (`operator` is the reference). There are exactly **two axes** — get them right and the overlays are mechanical:

| Axis              | Same across all 3 envs                                                                                                                                                                                                       | Differs per env                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node identity** | `namePrefix: <node>-`, `NODE_NAME`, `app.kubernetes.io/instance: <node>` labels/selectors, `secretRef: <node>-node-app-secrets`, `nodePort`, `containerPort`/`targetPort`, the **doltgres `migrate-doltgres` initContainer** | —                                                                                                                                                                     |
| **Environment**   | —                                                                                                                                                                                                                            | `namespace: cogni-<env>`, `TEMPORAL_NAMESPACE`, ExternalName host (`<env>.vm.cognidao.org`; candidate-a uses `cogni-candidate-a.vm…`), `NEXTAUTH_URL`, image `digest` |

Each overlay must include:

- **ConfigMap `node-app-config` patch:** `NODE_NAME`, `TEMPORAL_NAMESPACE`, `LITELLM_BASE_URL` (`http://<node>-litellm-external:4000`), `TEMPORAL_ADDRESS` (`<node>-temporal-external:7233`), `REDIS_URL` (`redis://<node>-redis-external:6379`), `NEXTAUTH_URL`.
- **Service `node-app` patch:** `nodePort` + `app.kubernetes.io/instance: <node>` on the selector (without the instance label, `namePrefix` does _not_ rename selectors and every Service round-robins across all node pods).
- **Deployment `node-app` patch:** `<node>-node-app-secrets` secret refs + instance labels on `matchLabels` and pod template.
- **`migrate-doltgres` initContainer** appended to the Deployment (knowledge-plane migrator; `DATABASE_URL` ← `DOLTGRES_URL` secret).
- **bug.0295 VM-DNS:** convert base headless `*-external` Services → `ExternalName` (`<env>.vm.cognidao.org`) and `$patch: delete` the matching `EndpointSlice`s.
- **`images:` digest** — a placeholder (`sha256:000…0`) is fine: candidate-a is overwritten by candidate-flight on acquisition, preview is auto-seeded (`promote-preview-digest-seed.yml`, task.0349), production is human-gated (`promote-and-deploy.yml`).

**Verify:** `kustomize build infra/k8s/overlays/<env>/<node>` for **all three** envs.

### 4. ApplicationSet generators × 3

Add a `git` generator for the node to each of `infra/k8s/argocd/{candidate-a,preview,production}-applicationset.yaml` (mirror the existing `operator`/`resy`/`scheduler-worker` blocks):

```yaml
- git:
    repoURL: https://github.com/cogni-dao/cogni.git
    revision: deploy/<env>-<node>
    files:
      - path: "infra/catalog/<node>.yaml"
```

The AppSet template renders `path: infra/k8s/overlays/<env>/{{.name}}`. **This is inert until the deploy branch exists** — the git generator finds no files on a non-existent `revision`, so no Application is generated (and nothing crashloops).

### 5. Deploy branches

`deploy/<env>-<node>` branches **auto-bootstrap** on the first promote (candidate-flight cold-start, task.5013). `promote-and-deploy.yml` rsyncs `infra/k8s/` from `main` → each deploy branch (invariant `INFRA_K8S_MAIN_DERIVED`, bug.0334 — **never hand-edit overlays on deploy branches**; edit `main`).

### 6. Per-env provisioning — required before the node actually serves

Steps 1–5 land the rails; the node only becomes Healthy once each target env has:

- [ ] **Secrets** — `<node>-node-app-secrets` in `cogni-<env>` (`scripts/ci/deploy-infra.sh` seeds from GitHub environment secrets; a new node needs its own DB creds + `DOLTGRES_URL`). Ties into the OpenBao/ESO secrets substrate.
- [ ] **Databases** — per-namespace Postgres + Doltgres for the node.
- [ ] **DNS** — `<node>-test` / `<node>-preview` / `<node>` `.cognidao.org` → the env VM IP, via the [`/dns-ops`](../../.claude/skills/dns-ops/SKILL.md) skill. Must match the overlay `NEXTAUTH_URL`.
- [ ] **Externals** — LiteLLM / Temporal / Redis reachable at the VM host (the ExternalName targets from Step 3).

### 7. Flight gating — `wait-for-argocd.sh`

- [ ] If the node is **critical** (a flight should fail if it can't reach Healthy), add `<node>` to `scripts/ci/wait-for-argocd.sh` `APPS=(…)`. If it is **optional / in-flight**, leave it out so it doesn't block flights (bug.0312).

### 8. Flight + validate

- [ ] Flight: `POST /api/v1/vcs/flight { prNumber }` (dispatches `candidate-flight.yml` once the PR is green).
- [ ] Confirm `https://<node>-test.cognidao.org/version` `buildSha` == PR head SHA.
- [ ] [`/validate-candidate`](../../.claude/skills/validate-candidate/SKILL.md) with captured auth (`.local-auth/candidate-a-<node>.storageState.json`).

## What the Node Wizard (#1381) Automates

**Today (#1381):** the wizard deploys the web3 contracts (DAO + GovernanceERC20 + CogniSignal) and then auto-drafts a **repo-spec-only PR** — just `.cogni/repo-spec.yaml` (node identity). It stops at identity; the node is not yet a build target and has no deploy footprint.

**vNext:** the wizard spawns a full **node-app PR** that scaffolds `nodes/<node>/app` plus Steps **1, 3, 4, 5** of this guide — catalog entry, overlays × 3, AppSet generators × 3, deploy branches — so a newly-formed node starts life already wired for **test → preview → prod**. Those four steps are pure functions of the `type: node` catalog declaration, which is what makes the candidate-a-only trap structurally impossible to repeat. Step **6** (secrets/DB/DNS) stays imperative — the side-effecting half the wizard's "Deploy Infrastructure" stage drives after the PR merges. Steps **2, 7** shrink to nothing once `build_target()` and `APPS` become catalog-driven (task.5079).

> **Contract for the vNext wizard:** `formation(web3 + repo-spec)` → `node-app PR { nodes/<node>/app, catalog(type:node), overlays × 3, AppSet generators × 3, deploy branches × 3 }` → provision `{ secrets, DB, DNS } × 3`. Either the full matrix is generated or the node is not deployable — no partial (candidate-a-only) enablement.

## Verification

```bash
# all three overlays build
for env in candidate-a preview production; do
  kustomize build infra/k8s/overlays/$env/<node> >/dev/null && echo "$env ok"
done
# node present in all three AppSets
grep -l "<node>" infra/k8s/argocd/{candidate-a,preview,production}-applicationset.yaml
# promote-seed stays green (no missing-overlay sha256sum failure on main)
```

## Related

- [Create a New Service](./create-service.md) — the `services/` sibling of this guide
- [Node Formation — DAO Setup](./node-formation-guide.md) — on-chain formation; §8 is the deploy hand-off into this guide
- [Multi-Node Deploy](./multi-node-deploy.md) — env/lane topology
- [CI/CD Spec](../spec/ci-cd.md) — `CATALOG_IS_SSOT` (axiom 16), promote pipeline
