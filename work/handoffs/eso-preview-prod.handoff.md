---
id: eso-preview-prod.handoff
type: handoff
work_item_id: task.5094
status: active
created: 2026-06-02
updated: 2026-06-02
branch: derekg1729/eso-operator-resy
last_owner: derek-claude
---

# Handoff: get **preview + prod** onto ESO-synced secrets

**The only goal that matters: operator + every node on preview and production read their A1/A2 secrets from ESO-synced k8s Secrets sourced from OpenBao — retiring the imperative `deploy-infra` secret-push.** candidate-a/-b are throwaway rehearsal, not deliverables.

## Verified topology (SSH into live clusters, 2026-06-02 — corrects prior confusion)

There are **two clusters labeled `env=candidate-a`** in shared Grafana; don't conflate them.

| Cluster                                | ESO substrate?                                                                               | Secrets                                            | Notes                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Monorepo candidate-a `84.32.9.111`** | 🔴 **NONE** — no `externalsecrets`/`clustersecretstore` CRDs, no openbao/external-secrets ns | imperative `*-node-app-secrets` (8 nodes, 46 keys) | the live shared flight slot. SSH key `cogni-candidate-a-vm-*` in the **main** worktree `.local/` |
| **i-am-coco fork** (separate VM)       | 🟢 has OpenBao+ESO                                                                           | —                                                  | syncs `i-am-coco/cogni-node-20260528`; NOT the monorepo                                          |
| **Monorepo candidate-b `84.32.25.59`** | 🟢 had it (proved consume path Jun-01)                                                       | `*-env-secrets`                                    | **DOWN** now; creds dead                                                                         |
| **preview / production**               | 🔴 **NONE**                                                                                  | imperative                                         | never ran the substrate provisioner                                                              |

**Why preview/prod have no ESO:** they were never provisioned with `scripts/setup/provision-env-vm.sh` (the substrate-installing provisioner) — stood up by the old path; the new provisioner has only ever run on candidate-b (one experiment). **The real constraint is confidence in `provision-env-vm.sh`, not the manifests.**

## Status matrix — ESO → preview + prod

| #   | What's needed                          | preview | prod | Reality                                                               |
| --- | -------------------------------------- | ------- | ---- | --------------------------------------------------------------------- |
| 1   | ESO substrate (OpenBao+ESO installed)  | 🔴      | 🔴   | never installed                                                       |
| 2   | **`provision-env-vm.sh` trusted**      | 🔴      | 🔴   | run once ever (candidate-b) — THE gate                                |
| 3   | per-env ExternalSecret + overlay flips | 🔴      | 🔴   | trivial — mirror PR #1460, dormant-safe                               |
| 4   | `DOLTGRES_URL` fan-out fix (step-1)    | 🟡      | 🟡   | designed; sequenced behind provision-script churn (#1450/51/52/#1388) |
| 5   | OpenBao seeded + pods boot from ESO    | 🔴      | 🔴   | only during/after a provision                                         |

Manifests (#1460-style) are the trivial 10%; the blocking 90% is that **no real env has ever had the substrate provisioner run successfully**, and prod is the scary one.

## THE decision (drives everything)

**How does the OpenBao+ESO substrate get onto preview/prod?**

- **(A) Fresh provision** — `provision-env-vm.sh preview|production` (tofu destroy+apply). Proven once on candidate-b. **Destroys the VM + postgres/temporal data.** Pre-authorized ("no prod users").
- **(B) In-place Argo install** — land CP2a.1 (`infra/catalog/openbao.yaml` + AppSet generator) so Argo installs the substrate on the _existing_ clusters, + a one-time OpenBao bootstrap job (init/unseal/seed/writer-role). **Preserves data**, less proven.

Recommendation: **B** for prod blast-radius (data-preserving, incremental); A acceptable for preview. Open for review.

## Ordered plan (preview → prod)

1. Pick **A or B** (above).
2. Harden `provision-env-vm.sh` (the churn PRs) + land step-1 `DOLTGRES_URL` fan-out fix on a clean base.
3. Author preview+prod ESO manifests (ExternalSecret leaves + overlay `secretRef` flips). **Retarget PR #1460** off candidate-a.
4. **preview**: install substrate (chosen mechanism) → seed → flip → boot from ESO → validate (`/validate-candidate` + Loki) → soak.
5. **prod**: same, after preview soaks. Zero human re-entry (per `secrets-classification.md` migration tracker — names stable, provision re-homes inside OpenBao).
6. Retire imperative `*-node-app-secrets` push + sops `.enc.yaml`.

## Open questions for the reviewer

- **A vs B** substrate-install mechanism for preview/prod.
- Derek floated **decommissioning candidate-a** (move flighting to candidate-b). Orthogonal to ESO — factor in or defer?
- Sequencing: step-1 fix touches the same provisioning scripts as #1450/51/52/#1388 — confirm it lands after they merge.
