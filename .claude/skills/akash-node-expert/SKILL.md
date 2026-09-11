---
name: akash-node-expert
description: "Akash runtime and pipeline canon for how Cogni nodes run on decentralized compute. Use this skill when working on Akash placement, ComputeWorkload CRs, leases, node migrations to/from k3s, deployment_provider, compute egress, or debugging a node that won't come up on Akash. devops-expert remains the CI/CD-boundary router; this skill is the Akash runtime + pipeline canon. Triggers on: 'akash', 'ComputeWorkload', 'lease', 'migration job', 'placement', 'deployment_provider', 'bid', 'provider', 'escrow', 'zencloud'."
---

# Akash Node Expert

Akash Node Expert — how Cogni nodes run on decentralized compute.

USE WHEN: any task touching Akash placement, ComputeWorkload CRs, leases, node migrations to/from k3s, `deployment_provider`, compute egress, or debugging a node that won't come up on Akash. devops-expert remains the CI/CD-boundary router; THIS skill is the Akash runtime + pipeline canon. First reproducible node: toks4, 2026-09-10, proven candidate+prod via pure API path.

## The lane (how a node reaches Akash)

1. Catalog row `infra/catalog/<slug>.yaml`: `deployment_provider: {candidate-a|preview|production: akash}` (requires `type: node` + `source_repo`; schema `infra/catalog/_schema.json`) + `compute_egress_cidrs` (provider NAT, e.g. 80.200.246.35/32 = zencloud+digitalfrontier shared).
2. The node's own repo's `.cogni/repo-spec.yaml` must declare the `deployment:` block (`runtime_profile: cogni-node-app-v1`); `assertDeclaredNodeDeployment` (`nodes/operator/app/src/features/compute/node-services-workload-spec.ts`) refuses otherwise. Generator: `renderNodeDeploymentYaml()` in `packages/repo-spec/src/node-app-deployment.ts`.
3. Flight/promote (operator API ONLY: `POST /api/v1/vcs/flight`, `/api/v1/deploy/promote` — never gh dispatch): workflow materializes a ComputeWorkload CR onto the deploy branch (`.github/actions/materialize-compute-workload` → `nodes/operator/app/scripts/materialize-compute-workload.ts`), replacing the k3s overlay wholesale. Bundle ref = ghcr `bundle-sha-<sourceSha>` resolved to digest, pinned in `spec.bundle.ref`.
4. Argo applies the CR on the env's Cherry k3s; the compute-workload-controller (leader-elected singleton) reconciles: wallet-slot claim → migration Job gate → SDL/bid/lease via AkashComputeAdapter → boot SLO (`/version` sha match + `/readyz` 200) → Ready. `/version.buildSha` from outside is the only ground truth.

## The four once-manual bridges, now code (all live-proven 2026-09-10)

- Wallet allocation ledger (ConfigMap `compute-workload-allocation-ledger`, single slot): orphaned slots (CR gone) are CAS-reclaimed with a loud `compute_wallet_allocation_orphan_reclaimed` warn; cursor-bearing orphans get a one-tick grace. PR #2140.
- DB migrations off-k3s: reconciler-gated k8s Job `migrate-<slug>-<digest12>` on the env cluster, per-bundle-digest idempotent (completed Job IS the skip marker), image = the digest-pinned app artifact, DATABASE_URL via `<slug>-compute-env-secrets`, doltgres phase only when DOLTGRES_URL declared. Failure => CR Failed/MigrationFailed, retryable:false, NO lease churn (old lease keeps serving). Unschedulable/never-ran Jobs are deleted+retried (never poison the digest); requests are 128Mi/50m deliberately small for packed VMs. PRs #2141 #2144 #2148.
- Terminal CR recovery: dead-leader-epoch `outcome:"claimed"` attempts route through bounded observe-and-adopt recovery (adopt existing lease or settle+recover; never blind-create — Axiom 26 fail-closed). Elector identity carries a per-process nonce. PR #2142.
- RBAC promote: production promote needs `production_promoter` on the node (Derek-approved grant) + a billing account; `POST /api/v1/deploy/promote {nodeId(UUID), env, sourceSha}`.

## Traps that already burned us (do not repeat)

- Overlays patched controller env BY INDEX; an insertion blanked AKASH_ALLOWED_PROVIDERS fleet-wide (empty allowlist = reject every bid, silently). Now name-keyed (PR #2143); never add positional env patches.
- `strategy: Recreate` + live `rollingUpdate` residue = ArgoCD server-side-apply dry-run Forbidden => whole app un-syncable (ComparisonError, sync status Unknown). Use RollingUpdate maxSurge:0/maxUnavailable:1. PR #2138.
- Deploy branches historically rendered infra manifests from MAIN, making manifest changes unvalidatable pre-merge; fixed for candidate by PR #2152 (flight renders from source sha). Pre-merge flights also exercise new-image-vs-old-manifest skew — the state prod passes through mid-rollout.
- kine (k3s SQLite) bloats on Event churn; a starved VM fails probes fleet-wide and promotes 502 on verify-buildsha. Weekly compact timer + event-ttl=30m + openbao httpGet probe: PR #2137. Manual recipe (candidate-a only, captured in git): stop k3s → DELETE FROM kine WHERE id NOT IN (SELECT MAX(id) FROM kine GROUP BY name) → VACUUM → start.
- An empty node DB surfaces as generic INTERNAL_ERROR on `/readyz` → controller reads failed boot SLO → closes lease → escrow refund makes the wallet balance go UP. When one env works and another doesn't: DIFF THE ENVS FIRST (preview 37 tables vs prod 0 found it in one query).
- The controller Role must cover every adapter call; missing verbs surface as `compute_workload_migration_hold causeMessage:ProviderTransient` loops. Full call→grant matrix in PR #2148 body.
- Re-promoting the SAME sha into a wedged CR is a silent no-op (idempotency key includes generation) — promote a moving sha.

## Placement lever (Gate 2, PRs #2150 #2151, nt#117)

`POST /api/v1/nodes/[id]/envs {env, placement}` writes the catalog + tears down the k3s overlay; `POST /api/v1/nodes/[id]/deployment-block` mints the node repo-spec block; UI = NodeEnvToggle. node-template's overlay FILES are the render template and stay in-tree even when its deployment leaves an env (guard `operator` only; PR #2149).

## Stays on Cherry forever

operator + controller + scheduler-worker + Compose substrate (Postgres/Doltgres/Temporal/LiteLLM/OpenBao/OpenFGA/Caddy). A control plane cannot self-host on leases it manages; catalog schema forbids operator placement.

## Open edges (check work items before assuming)

Second audited provider needed before beacon wave (single-provider risk, task.5075). Remote metrics for controller not scraped (Axiom 26 scope). Preview/prod promote lane has no off-cluster preflight job (candidate-only). Vocabulary migrating external→off-cluster (task.5081). bug.5117 app_readonly auth failures unowned.
