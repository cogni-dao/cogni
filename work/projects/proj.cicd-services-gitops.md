---
id: proj.cicd-services-gitops
type: project
primary_charter:
title: CI/CD Pipeline
state: Active
priority: 1
estimate: 5
summary: Get the trunk-based pipeline fully green — PR build → candidate-a flight → merge → preview flight → preview review → release → production
outcome: One clean flow from feature PR through production with no rebuilds, pre-merge candidate validation, post-merge preview lease, policy-gated release, and first-class deploy-infra reconciliation on both candidate-a and preview VMs
assignees: derekg1729
created: 2026-02-06
updated: 2026-04-16
labels: [deployment, infra, ci-cd]
---

# CI/CD Pipeline

## Goal

Get the trunk-based pipeline fully green: `pr-build.yml` builds once, `candidate-flight.yml` flies selected PRs into the `candidate-a` slot pre-merge, merged PRs auto-flight to preview via `flight-preview.yml` with a three-value review lease, and `release.yml` policy-gates promotion to production. Task.0293 (PR #870) landed the merge-to-preview lane. Remaining blockers below, plus the critical `candidate-flight` → `deploy-infra` gap tracked in bug.0312.

## Pipeline Health

```
                          ┌─ app lever (Argo) ───┐
pr-build → triage ────────┤                       ├──→ verify → preview → release → production
                          └─ infra lever (compose)┘
GREEN       GREEN          GREEN      GREEN         AMBER    TBD       NEW       LEGACY
```

`pr-build.yml` is `detect → build (matrix, one leg per affected target) → manifest` as of task.0321 (PR #896, 2026-04-17). Candidate-a has two orthogonal levers (task.0314, PR #883, merged 2026-04-16): `candidate-flight.yml` (app digests → Argo) and `candidate-flight-infra.yml` (VM compose). Preview/prod (`promote-and-deploy.yml`) runs both sequentially on every merge.

**Per-node flighting sequence (re-ordered 2026-04-25):**

1. **task.0320** ✅ shipped the dormant substrate (per-env per-node deploy branches declared in `infra/catalog/*.yaml`; AppSets unchanged; behavioral no-op).
2. **task.0373** ✅ shipped (PR #1047, merged 2026-04-25). `candidate-flight` snapshot/restore around the PR-branch rsync — kills the rsync-clobber regression class without writing to main.
3. **task.0374** ✅ shipped (PR #1053, merged 2026-04-25). `infra/catalog/*.yaml` is the single declaration site; `image-tags.sh` / `detect-affected.sh` / `wait-for-argocd.sh` read it. Schema validated on every PR.
4. **task.0372 — Per-node candidate-flight matrix + AppSet substrate (in-review).** AppSets 1→4 generators across all 3 envs (candidate-a, preview, production). `candidate-flight.yml` matrix-fanned over affected nodes with `fail-fast: false`; per-cell concurrency `flight-${{ matrix.env }}-${{ matrix.node }}` is the lease primitive. Bootstrap script seeds 12 dormant per-env per-node deploy branches. Live-validated end-to-end on PR #1033. Three latent bugs surfaced + fixed via SSH diagnosis: Argo CRD strict-decode of `preserveResourcesOnDeletion`, fasttemplate not exposing arbitrary catalog fields, `/tmp/wait-for-argocd-remote.sh` race across parallel cells.
5. **task.0376 — Preview + production matrix cutover (next).** Applies the proven primitive symmetrically to `flight-preview.yml` + `promote-and-deploy.yml`. Adds `aggregate-preview` + `aggregate-production` jobs (CURRENT_SHA_IS_MERGE_BASE / ROLLUP_MAP_PRESERVES_UNAFFECTED / AGGREGATOR_CONCURRENCY_GROUP). Retires the lease scripts + state file. Rewrites `pr-coordinator-v0/SKILL.md`. Tightens `docs/spec/ci-cd.md` with `BRANCH_HEAD_IS_LEASE` + `LANE_ISOLATION` axioms.

Verify is AMBER: TLS rate limit (resets hourly). E2E, preview promotion (`flight-preview.sh`), and release (`release.yml`) untested in production — first real run pending.

## Active Blockers

| #   | Issue                                                                                                                                                                                                                                                                                      | Status       | Owner | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **TLS cert rate limit** — Let's Encrypt 5-per-identifier-per-hour limit hit after domain expiry recovery                                                                                                                                                                                   | ⏳ WAITING   | —     | Resets 01:39 UTC 2026-04-06. Re-trigger verify then.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | **provision Phase 7 clones wrong branch** — `${BRANCH}` (staging) lacks `infra/k8s/argocd/` files                                                                                                                                                                                          | ✅ FIXED     | —     | SCP from local checkout using per-env `APPSET_FILE`. No branch dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | **Caddyfile www redirect** — `www.{$DOMAIN}` block creates certs for nonexistent `www.test.*` domains                                                                                                                                                                                      | ✅ FIXED     | —     | Removed www block. Only needed for production (with DNS record).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | **Deploy branches use PRs instead of direct commits**                                                                                                                                                                                                                                      | ✅ DONE      | —     | task.0292: direct push for all envs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **Production rebuilds instead of promoting** — `build-prod.yml` builds fresh `prod-${SHA}` on main push                                                                                                                                                                                    | ❌ RED       | —     | Production would get different images than validated in candidate-a / preview                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | **Merge-to-main preview flighting**                                                                                                                                                                                                                                                        | 🟡 IN PR     | —     | task.0293: main→preview flight workflow with three-value lease, lock-on-success, unlock-on-failure, drain-on-release-unlock. PR #870 landed the skeleton; PR #874 fixed five chain blockers (squash-merge resolver, `sync.revision` wait, lock/unlock main checkout, AppSet reconcile step, canary residue) that kept it from actually reaching deploy-infra.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7   | **Release PR conveyor belt**                                                                                                                                                                                                                                                               | ✅ DONE      | —     | task.0294: policy-gated via release.yml workflow_dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8   | **Production promotion = direct dispatch of promote-and-deploy.yml**                                                                                                                                                                                                                       | 🟡 IN PR     | —     | bug.0361: deleted `promote-to-production.yml` + `require-pinned-promote-prod-prs.yml` + `auto-deploy-promote-prod.yml` + `scripts/ci/promote-to-production.sh`. Prod is now one workflow: human runs `gh workflow run promote-and-deploy.yml env=production source_sha=<preview-current-sha> build_sha=<pr-head> skip_infra=true`. Same entry point as preview. No intermediate PR. Same verify-deploy + e2e. Unblocks prod-frozen-at-2026-04-17 (migrator Argo hook never ran because overlay was never pushed).                                                                                                                                                                                                                                              |
| 9   | **Rename staging→preview in workflows**                                                                                                                                                                                                                                                    | ✅ DONE      | —     | deploy/preview branch created, all refs updated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | **SHA-pin OpenClaw images** — gateway uses `:latest`, violates IMAGE_IMMUTABILITY                                                                                                                                                                                                          | ❌ RED       | —     | Mutable tags in production                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11  | **Argo EndpointSlice OutOfSync** — k8s adds metadata fields not in Git manifests                                                                                                                                                                                                           | ⚠️ COSMETIC  | —     | PR #874 sidestepped: `wait-for-argocd.sh` now polls `sync.revision == deploy-branch SHA && health.status == Healthy` so CD no longer hangs on perpetual `OutOfSync`. Cosmetic cleanup still open: add `ignoreDifferences` for EndpointSlice metadata in the AppSet template.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 12  | **Control-plane logs dark + k8s per-container metrics deferred** — compose alloy ships pod logs (cogni-\_, argocd, kube-system), app metrics, docker-cAdvisor, and host metrics on single-VM; kubelet-cAdvisor per-container metrics need an in-cluster scraper, deferred until multi-node | 🟡 PARTIAL   | —     | PR #869 widens compose alloy's pod-log filter to `cogni-_\|argocd\|kube-system` so Argo CD sync events and kubelet/coredns/kube-proxy logs are queryable in Loki without SSH. PR #864 landed a speculative k8s Alloy DaemonSet that duplicated the compose pod-log path on a single-VM deploy; reverted in #869 with a single-VM/multi-node decision deferred. Multi-node revival → future task when the cluster splits past one VM.                                                                                                                                                                                                                                                                                                                           |
| 13  | **VM IPs in public repo** — env-endpoints.yaml on deploy branches exposes bare VM IPs                                                                                                                                                                                                      | ⚠️ SECURITY  | —     | bug.0295: need floating IPs or DNS-only EndpointSlices                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 14  | **Affected-only builds** — Docker image lane is affected-only + parallel matrix (task.0321, PR #896, 2026-04-17). Turborepo `--affected` for lint/test still not wired.                                                                                                                    | 🟡 PARTIAL   | —     | Docker: ✅ `detect-affected.sh` + per-target matrix (wall time ~max leg, not sum). Lint/test: ❌ still runs full suite — task.0260 open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Stack tests + E2E not running on candidate-a flight** — legacy staging-preview had full test coverage                                                                                                                                                                                    | ❌ RED       | —     | `candidate-flight.yml` must reach parity: stack-test in CI, E2E after deploy. **Meanwhile `scripts/ci/smoke-candidate.sh` embeds a hand-rolled bug.0322 cross-node isolation check that POSTs a REAL `gpt-4o-mini` chat completion via the `poet` graph on every flight** (lines 58–114). Couples flight gating to external LLM uptime + burns spend per flight; observed exit-28 curl timeouts fail flights regardless of PR diff (e.g. PR #1012 run 24874508475, 2026-04-24). Move this assertion into the real E2E (Playwright) when parity lands and delete the curl block.                                                                                                                                                                                |
| 16  | **No GitOps pipeline for k8s Secret delivery** — ksops half-wired (placeholder age keys), no workflow creates Secrets                                                                                                                                                                      | ❌ RED       | —     | ksops is configured in Argo CD but has never shipped a real encrypted secret — `.sops.yaml` holds placeholder age keys and no real `.enc.yaml` file lives under the per-env path_regex rules today. Options: (a) activate ksops end-to-end (generate real age keys, encrypt the first real secret) — interim; (b) task.0284 External Secrets Operator — target. Until one of those ships, every new in-cluster Secret requires manual cluster-side bootstrap.                                                                                                                                                                                                                                                                                                  |
| 17  | **pr-build BUILD_SHA ≠ image tag** — `/readyz` version reports ephemeral `refs/pull/{N}/merge` SHA instead of PR head                                                                                                                                                                      | ✅ FIXED     | —     | bug.0313: fixed in PR #873. `BUILD_SHA` env var preferred over `GITHUB_SHA`, pr-build.yml passes PR head SHA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 18  | **PAT-dispatched workflow chain** — `flight-preview` calls `gh workflow run` with PAT; target: `on: push deploy/*`                                                                                                                                                                         | 🟡 FOLLOW-UP | —     | Eliminate PAT dispatch; promote-and-deploy triggers on deploy branch push, reads `source_sha` from `.promote-state/candidate-sha`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 19  | **deploy-infra unconditional** — SSH + Argo wait + compose up on every promotion, even code-only PRs                                                                                                                                                                                       | ✅ DONE      | —     | task.0314 (PR #883, merged 2026-04-16) split candidate flight into two independent levers: `candidate-flight.yml` (app only, no SSH) and `candidate-flight-infra.yml` (compose only). `deploy-infra.sh` sources from `--ref main` default so app PRs can't ship stale compose config. Infra lever first-dispatch validated 2026-04-16 on candidate-a.                                                                                                                                                                                                                                                                                                                                                                                                          |
| 20  | **scheduler-worker CrashLoop + sandbox-openclaw ImagePullBackOff block `wait-for-argocd`**                                                                                                                                                                                                 | 🟡 IN PR     | —     | SW root cause was `deploy-infra.sh` writing `COGNI_NODE_ENDPOINTS` into `scheduler-worker-secrets` from the LiteLLM-flavored GH env secret, overriding the correct overlay ConfigMap via `envFrom` later-wins. bug.0315 / PR #913 removes the override, adds `wait-for-in-cluster-services.sh` to fail loud on future rollout regressions, and codifies "overlay ConfigMap is the source of truth" in `docs/spec/services-architecture.md`. Openclaw placeholder still tracked separately.                                                                                                                                                                                                                                                                     |
| 22  | **candidate-flight false-red on `scheduler-worker` after successful deploy**                                                                                                                                                                                                               | 🟡 IN PR     | —     | `wait-for-argocd.sh` budgets `ARGOCD_TIMEOUT` once for the whole promoted-app loop, so operator/poly/resy consume most of the 300s and `scheduler-worker` inherits only the remainder. Recent candidate-a flights on 2026-04-23 show the deploy converging while `verify-candidate` fails red and writes lease state `failed`. bug.0358 / fix branch converts the timeout to a per-app budget without changing the verification contract.                                                                                                                                                                                                                                                                                                                      |
| 21  | **Hand-curated overlay digests — CI-owned seed (preview) + flight self-heal (candidate-a)**                                                                                                                                                                                                | ✅ DONE      | —     | task.0349 (PR #989, merged 2026-04-22) made `flight-preview` write `chore(preview):` commits to `main` after each merge that dispatched preview promote — `main:overlays/preview/**` digests stay aligned with GHCR. task.0373 (PR #1047, merged 2026-04-25) made `candidate-flight` snapshot/restore `deploy/candidate-a` overlay digests around the PR-branch rsync — non-promoted apps cannot regress. Argo CD Image Updater was rejected during task.0349 design (see `docs/spec/ci-cd.md` authority section): IU writes one commit per Application per cycle (linear in catalog) and discovers "newest allowed image" rather than "the artifacts this merge produced". Production digest-seed remains an open follow-up (see Known Unknowns in ci-cd.md). |
| 22  | **Argo reports Healthy before old ReplicaSet drains — replace task.0341 polling (bug.0345)**                                                                                                                                                                                               | ❌ RED       | —     | Observed on candidate-a 2026-04-20: poly overlay bumped to new digest, Argo went Healthy, live pod still served old SHA. task.0341 widened the polling window (90s) but it's a health-check-semantics bug, not a poll-interval bug. Fix: `kubectl rollout status deployment/X --timeout=5m` (observes `observedGeneration`, `updatedReplicas == replicas`, `Progressing=NewReplicaSetAvailable`) OR fix the Argo Deployment health check + probe wiring. task.0341 solved at the wrong layer.                                                                                                                                                                                                                                                                  |

## Environment Status (2026-04-14)

| Check                     | Candidate-A (84.32.109.160) | Preview (84.32.110.92) |
| ------------------------- | --------------------------- | ---------------------- |
| VM + k3s + Argo CD        | ✅                          | ✅                     |
| All node pods Running 1/1 | ✅                          | ✅                     |
| Migrations completed      | ✅                          | ✅                     |
| NodePort /readyz 200      | ✅ (all 3)                  | ✅ (all 3)             |
| Compose infra healthy     | ✅ (frozen at provision)    | ✅ (CI-reconciled)     |
| TLS certs (HTTPS)         | ❌ rate limited             | ❌ rate limited        |
| Loki logs flowing         | ✅                          | TBD                    |
| Prometheus metrics        | ✅ compose alloy            | ✅ compose alloy       |
| GitHub secrets set        | ✅                          | ✅                     |
| DNS A records correct     | ✅                          | ✅                     |

> **Candidate-A Compose infra gap:** `candidate-flight.yml` carries the `Deploy Compose infra to candidate-a VM` step (PR #869 landed it; PR #874 added the AppSet reconcile step alongside it). The step is gated on `has_vm=true`, which requires `VM_HOST` + `SSH_DEPLOY_KEY` + ~40 app secrets on the `candidate-a` GitHub environment. Candidate-a env currently has zero secrets set, so the step silently skips on every flight. Unblock: populate `candidate-a` secrets via `pnpm setup:secrets --env candidate-a` (blocked on SSH pubkey install on 84.32.109.160 + `setup-secrets.ts` ENVIRONMENTS extension — tracked separately from bug.0312).

## E2E Success Milestone (Project Completion Gate)

Project is complete when one work item achieves `deploy_verified=true` via fully autonomous pipeline:

```
✅ PR merged (code gate — needs_implement → done)
✅ candidate-flight dispatched by pr-manager (task.0297: flightCandidate)
✅ getCandidateHealth() → healthy scorecard (task.0308: memory < 90%, restarts=0, oom_kills=0)
✅ qa-agent: feature exercised (exercise: field from work item ## Validation)
✅ Loki observability signal confirmed at deployed SHA (observability: field from work item)
✅ deploy_verified = true set autonomously by qa-agent (task.0309)
```

**vNext gate (not in v0):** qa-agent posts `qa-validation` commit status on PR head SHA via GitHub App → becomes third PR merge gate alongside `build-images` and `candidate-flight`.

### Active Tasks (Candidate Flight + QA Pipeline)

| Task      | Title                                                                | Status       | Priority |
| --------- | -------------------------------------------------------------------- | ------------ | -------- |
| task.0309 | QA agent — reads task, exercises feature, confirms observability     | needs_design | 0        |
| task.0308 | Deployment observability scorecard (getCandidateHealth, SHA in logs) | needs_design | 1        |
| task.0297 | Add candidate-flight tool to VCS capability (flightCandidate)        | needs_design | 1        |
| task.0381 | **Single-node-scope CI gate (P0, node sovereignty)**                 | done         | 0        |

## Roadmap

### Crawl (P0) — Done

| Deliverable                                                                    | Status |
| ------------------------------------------------------------------------------ | ------ |
| Canonical `pnpm packages:build` (tsup + tsc -b + validation)                   | Done   |
| Manifest-first Docker layering (app + scheduler-worker)                        | Done   |
| `check:full` local CI-parity gate                                              | Done   |
| Runtime DSN isolation (`validate-dsns.sh`)                                     | Done   |
| App to `apps/operator` workspace, flatten platform/ → infra/ + scripts/        | Done   |
| K8s overlays + Kustomize bases (node-app, scheduler-worker, sandbox)           | Done   |
| Argo CD catalog-driven ApplicationSets tracking deploy branches                | Done   |
| Deploy branch model (deploy/canary, deploy/preview, deploy/production)         | Done   |
| Multi-node CI scripts (promote-k8s-image, deploy-infra)                        | Done   |
| k3s + Argo CD bootstrap via cloud-init                                         | Done   |
| Service contract (livez, readyz, version, pino, Zod config, graceful shutdown) | Done   |
| staging-preview.yml disabled (replaced by multi-node pipeline)                 | Done   |

### Walk (P1) — DSN-Only Provisioning & Build Improvements

**Goal:** Provisioner uses DSNs instead of component vars; build-time env coupling removed.

| Deliverable                                                                     | Status      | Est | Work Item            |
| ------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Add `DATABASE_ROOT_URL` secret (admin DSN for provisioning)                     | Not Started | 1   | (create at P1 start) |
| Implement Node provisioner (`provision.ts`) parsing 3 DSNs with `URL()`         | Not Started | 2   | (create at P1 start) |
| Update `db-provision` container env: only 3 DSNs                                | Not Started | 1   | (create at P1 start) |
| Delete `APP_DB_*` usage from provisioner codepath                               | Not Started | 1   | (create at P1 start) |
| Runtime-only env validation: remove build-time env coupling                     | Not Started | 2   | (create at P1 start) |
| `check:full --only-stack` and `--verbose` CLI enhancements                      | Not Started | 2   | (create at P1 start) |
| Multi-node CI: per-node `validate:chain`, fix `COGNI_NODE_DBS` in component job | Not Started | 1   | (create at P1 start) |

### Run (P2+) — Secret Cleanup & Graph-Scoped Builds

| Deliverable                                                                | Status      | Est |
| -------------------------------------------------------------------------- | ----------- | --- |
| Delete `APP_DB_*` + `POSTGRES_ROOT_*` secrets from GitHub                  | Not Started | 2   |
| Graph-scoped builds (`pnpm deploy` for service Dockerfiles)                | Not Started | 3   |
| Test architecture: move `tests/_fakes/` and `tests/_fixtures/` out of root | Not Started | 3   |

### GitOps Foundation

| Deliverable                                               | Status      | Work Item |
| --------------------------------------------------------- | ----------- | --------- |
| OpenTofu k3s module (Cherry Servers provider)             | Done        | task.0149 |
| k3s provisioned + Argo CD installed via cloud-init        | Done        | task.0149 |
| Promotion flow: PR→overlay→Argo syncs (canary working)    | Done        | task.0149 |
| Multi-node Argo CD: catalog-driven ApplicationSets        | Done        | task.0247 |
| infra/ reorg: k8s/, provision/, catalog/                  | Done        | task.0247 |
| Storage plan: PVCs for stateful deps, backup strategy     | Not Started | —         |
| K8s API read-only service account for AI agent debugging  | Not Started | task.0187 |
| Argo CD API token for sync status / rollback by AI agents | Not Started | task.0187 |

## Constraints

- **IMAGE_IMMUTABILITY**: Tags are `{env}-{sha}-{service}` or content-addressed; never `:latest`
- **MANIFEST_DRIVEN_DEPLOY**: Promotion = overlay digest change, not rebuild
- **BUILD_ONCE_PROMOTE**: `pr-build.yml` builds `pr-{N}-{sha}` once; `flight-preview.yml` re-tags to `preview-{sha}`; preview and production promote the exact same digests
- **NO_SSH_PAST_GITOPS**: No SSH deploy after production joins promote-and-deploy chain
- **AFFECTED_ONLY_CI**: Run lint/test/build only for changed packages (target: Turborepo, task.0260)

## Dependencies

- [x] EndpointSlice IPs on deploy branches + Temporal namespace bootstrap — fixed in #774. Provision writes IPs, promote writes digests. One writer per deploy fact.
- [ ] turbo.json pipeline config (blocks affected-only CI)

## Relocated Sections

The following content was removed from this project during the 2026-04-05 stabilization cleanup. It lives in dedicated specs/projects:

- **Preview Environments** → [preview-deployments.md](../../docs/spec/preview-deployments.md)
- **Health Probe Separation** → [health-probes.md](../../docs/spec/health-probes.md)
- **Node → Operator Migration** → [node-operator-contract.md](../../docs/spec/node-operator-contract.md) (needs its own project file)
- **Scaling Infrastructure** (HPA, managed Postgres, CDN) → trigger-based, not active
- **CI Portability / Dagger** → deferred, evaluate when GitHub Actions becomes limiting
- **CI Acceleration / Turborepo** → task.0260, referenced in constraints above

## Design Notes

Content aggregated from original CI/CD roadmap docs during 2026-04-05 stabilization pass. See Relocated Sections above for pointers.

## As-Built Specs

- [ci-cd.md](../../docs/spec/ci-cd.md) — Pipeline flow, branch model, workflow inventory
- [build-architecture.md](../../docs/spec/build-architecture.md) — Build order, Docker layering
- [health-probes.md](../../docs/spec/health-probes.md) — Liveness/readiness probe separation
- [services-architecture.md](../../docs/spec/services-architecture.md) — Service structure contracts
- [database-url-alignment.md](../../docs/spec/database-url-alignment.md) — DSN source of truth

## Operator Guides

- [create-env.md](../../docs/guides/create-env.md) — stand up a whole env (candidate-\*/preview/production/fork) via `provision-env.yml`; includes the known perfectionist gaps in the e2e provisioning path
- [create-node.md](../../docs/guides/create-node.md) — take a node live across the env matrix
- [fork-quickstart.md](../../docs/runbooks/fork-quickstart.md) — per-secret bring-up walkthrough (§6) + init-artifact custody
