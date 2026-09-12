---
name: akash-node-expert
description: "Akash runtime and pipeline canon for how Cogni nodes run on decentralized compute. Use this skill when working on Akash placement, ComputeWorkload CRs, leases, node migrations to/from k3s, deployment_provider, compute egress, or debugging a node that won't come up on Akash. devops-expert remains the CI/CD-boundary router; this skill is the Akash runtime + pipeline canon. Triggers on: 'akash', 'ComputeWorkload', 'lease', 'migration job', 'placement', 'deployment_provider', 'bid', 'provider', 'escrow', 'zencloud'."
---

# Akash Node Expert

Akash Node Expert — how Cogni nodes run on decentralized compute.

USE WHEN: any task touching Akash placement, ComputeWorkload CRs, leases, node migrations to/from k3s, `deployment_provider`, compute egress, or debugging a node that won't come up on Akash. devops-expert remains the CI/CD-boundary router; THIS skill is the Akash runtime + pipeline canon.

**Fleet status (live-verified 2026-09-11):** toks4 3/3, levelup 2/2, node-template 3/3, poly 2/2 env-slots LIVE on Akash (CR Ready + `/version` sha match + zero k3s `<node>-node-app` pods). beacon both envs DOWN pending its Tier-2 true merge (beacon#58, task.5088). The k3s app lane is **DEPRECATED** — Derek red line: NEVER flip a node back to k3s (`place_k3s` is not a mitigation; fix forward).

## Scaling north star — mandatory recall

Before designing placement, formation, lease lifecycle, capacity, cost, or shared
substrate, read
[`akash-cicd-pareto-scope`](https://cognidao.org/knowledge/akash-cicd-pareto-scope)
(`story.5024`). Its binding decisions are:

- Spawn ends with the canonical production hostname serving the exact immutable
  SHA. Candidate-a is a passive, ephemeral proof gate; preview is absent at
  birth; production is generation-1 activity authority.
- Use one Akash deployment/placement group per `(node, environment)` workload
  bundle, not one lease per service and not one giant Cogni fleet lease.
  Tightly coupled app-tier sidecars share the group and internal network.
- Akash providers perform physical bin-packing. Keep node-level lifecycle,
  secrets, cost attribution, failure containment, and future DAO custody.
- Pool generic substrate. Keep the controller's bootstrap/recovery path outside
  the leases it reconciles; this independence boundary—not one named host—is
  permanent.
- Use a shared-runtime scope when unique executable code is unnecessary; only a
  sovereign node earns its own repo/artifact/lease.

When as-built code differs, name the gap and fix toward this target. Never
reinterpret the target around a temporary implementation constraint.

## The lane (how a node reaches Akash)

1. Catalog row `infra/catalog/<slug>.yaml`: `deployment_provider: {candidate-a|preview|production: akash}` (requires `type: node` + `source_repo`; schema `infra/catalog/_schema.json`) + `compute_egress_cidrs` (provider NAT, e.g. 80.200.246.35/32 = zencloud+digitalfrontier shared). `compute_egress_cidrs` is REQUIRED on akash rows (#2175) — currently hand-edited; there is NO TS writer for it yet.
2. The node's own repo's `.cogni/repo-spec.yaml` must declare the `deployment:` block (`runtime_profile: cogni-node-app-v1`); `assertDeclaredNodeDeployment` (`nodes/operator/app/src/features/compute/node-services-workload-spec.ts`) refuses otherwise. Generator: `renderNodeDeploymentYaml()` in `packages/repo-spec/src/node-app-deployment.ts`. Repo-spec is read AT THE PROMOTED SHA — the block must exist at `sourceSha`, not just at HEAD.
3. Flight/promote. Candidate: `POST /api/v1/vcs/flight`. Prod: `POST /api/v1/deploy/promote {nodeId(UUID), env: production, sourceSha}` — the sourceSha MUST have a ghcr bundle (probe `/v2/<repo>/manifests/bundle-sha-<sha>`; the tags list is unreliable) AND its repo-spec at that sha must carry the deployment block. Preview: every registered node's main-merge auto-dispatches preview promote (the node-template carve-out was removed, #2172), or manual `gh workflow run promote-and-deploy.yml -f environment=preview -f nodes=<slug> -f node_source_sha=<sha>`. The workflow materializes a ComputeWorkload CR onto the deploy branch (`.github/actions/materialize-compute-workload` → `nodes/operator/app/scripts/materialize-compute-workload.ts`), replacing the rendered k3s app manifests on that branch. Bundle ref = ghcr `bundle-sha-<sourceSha>` resolved to digest, pinned in `spec.bundle.ref`. NOTE the in-repo k3s footprint (per-node overlay + AppSet) REMAINS for akash nodes — Argo delivers the CR through the per-node Application (`NO_DELETE_ON_PLACEMENT`); "akash = no k3s footprint" is a stale claim.
4. Argo applies the CR on the env's Cherry k3s; the compute-workload-controller (leader-elected singleton) reconciles: wallet-slot claim → migration Job gate → SDL/bid/lease via AkashComputeAdapter → boot SLO (`/version` sha match + `/readyz` 200) → Ready. Strict node health = `/version` sha match + ComputeWorkload CR Ready (CRs are named by node UUID) + zero `<node>-node-app` k3s pods. RAISED BAR (Derek): a node isn't healthy until agent-api-validation passes — register an agent key on the node and exercise chat with the free model `gpt-oss-120b`. Chat on Akash nodes currently HANGS (under investigation; likely stale scheduler-worker `COGNI_NODE_ENDPOINTS` + bug.5121).

Node-birth adjacents on main (2026-09-11): `POST /api/v1/nodes/{id}/reconcile-protection` heals birth branch protection onto existing forks (#2176, bug.5123); DNS self-CNAME fix — `endpointHostname` excludes `publicHost` so a node no longer CNAMEs to itself (#2177, bug.5125).

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
- Promote silently no-ops when NO IMAGE exists at the sha: the run goes green with only a "skipping" warning (bug.5121 / story.5023). Probe `bundle-sha-<sha>` on ghcr BEFORE dispatching. Dispatches return no run id — select the run by exact headSha/inputs, never "latest run".
- Fork CI checks out the PR HEAD, not a merge commit: files that landed on main mid-PR (e.g. `.cogni/repo-policy.json`) must be byte-copied onto the PR branch or its CI fails (bug.5124).
- Tier-2 machine merges clobber fork-local schema/migrations (poly#5 / beacon#58 precedent) — redo as a feature-aware TRUE merge, never re-fire the machine merge.
- Flip PRs collide on shared catalog/configmap files — serialize them and re-fire the verb on DIRTY; the merge queue drops PRs silently (check the PR actually reached MERGED).
- Akash app logs do NOT ship to Loki — only controller/litellm/scheduler-worker do. An Akash node's app logs are reachable only via the provider lease; don't "prove" app behavior from Loki silence (observability gap, open).

## Placement lever (Gate 2, PRs #2150 #2151, nt#117)

`POST /api/v1/nodes/[id]/envs {env, placement}` writes the catalog (reduced delete set — the per-node overlay + AppSet stay in-tree, `NO_DELETE_ON_PLACEMENT`; Argo delivers the CR through the per-node Application); `POST /api/v1/nodes/[id]/deployment-block` mints the node repo-spec block; UI = NodeEnvToggle. node-template's overlay FILES are additionally the render template (guard `operator` only; PR #2149). Flip PRs touch shared catalog/configmap files — serialize (see traps).

## Control/state substrate ladder

Current placement is operator + controller + scheduler-worker + Compose substrate
(Postgres/Doltgres/Temporal/LiteLLM/OpenBao/OpenFGA/Caddy) on Cherry. Do not
encode "Cherry forever" as the architecture. The permanent rule is that the
only controller/recovery path cannot self-host exclusively on leases it manages.
Move stateless shared services first; move stateful services only after proven
backup/restore, replication, and cross-provider recovery; preserve an independent
control anchor throughout.

## Open edges (check work items before assuming)

Second audited provider needed (single-provider risk, task.5075). beacon placement blocked on its Tier-2 true merge (beacon#58, task.5088). Agent chat on Akash nodes hangs — the raised health bar (agent-api-validation) fails fleet-wide, under investigation (likely stale scheduler-worker `COGNI_NODE_ENDPOINTS` + bug.5121). `compute_egress_cidrs` has no TS writer (#2175, hand-edited). One-deploy-verb fix for the silent no-op promote = story.5023. Akash app logs absent from Loki. Remote metrics for controller not scraped (Axiom 26 scope). Preview/prod promote lane has no off-cluster preflight job (candidate-only). Vocabulary migrating external→off-cluster (task.5081). bug.5117 app_readonly auth failures unowned.
