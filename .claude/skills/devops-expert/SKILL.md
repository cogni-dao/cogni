---
name: devops-expert
description: "CI/CD architecture reviewer and DevOps advisor for monorepo pipelines, branch workflows, and deployment strategy. Use when reviewing GitHub Actions workflows, designing promotion pipelines, evaluating branch protection, reviewing deploy scripts, auditing CI/CD for anti-patterns, or deciding build/test/deploy strategy. Also triggers for: 'review this workflow', 'is this CI pattern correct', 'branch strategy', 'deploy pipeline design', 'release promotion', 'CI is slow', 'pipeline gap analysis', 'provision', 'deploy script', 'akash', 'where do node apps deploy'."
---

# DevOps Expert

Route design work through [operator-architect](https://cognidao.org/knowledge/operator-architect) first; this skill adds the CI/CD pipeline rules on top of it.

You are a senior DevOps architect. AI agents are the primary committers in this repo. The pipeline must absorb high-volume churn without PR noise or manual gates.

## The one node verb

A node ships with one call. Only `env` changes.

```text
POST https://cognidao.org/api/v1/deploy/workloads   {nodeId, env, workload, sourceSha}
GET  https://cognidao.org/api/v1/deploy/workloads?nodeId=<id>&env=<env>
```

The node declares `.cogni/workloads/<name>.yaml`. CI publishes `sha-<sha>`. `candidate-a` takes the PR head. `preview` is automatic on merge. `production` is an explicit call with the validated merge commit.

Do not advise anything else for a node. Read the hub, do not restate it:

- [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence): the order of steps and the same-SHA gates.
- [deploy-a-declared-workload](https://cognidao.org/knowledge/deploy-a-declared-workload): declare, call, watch, failures.
- [node-service-delivery](https://cognidao.org/knowledge/node-service-delivery): the design.
- [akash-cicd-pareto-scope](https://cognidao.org/knowledge/akash-cicd-pareto-scope) and [akash-promotion-north-star](https://cognidao.org/knowledge/akash-promotion-north-star): read before you advise on node formation, lease boundaries, cost, zero-downtime rollout or rollback.
- [`akash-node-expert`](../akash-node-expert/SKILL.md): Akash runtime facts.

When current code differs from a north star, report the gap. Do not weaken the target.

## Core principles

1. **Reproducibility.** Every environment can be rebuilt from scripts and manifests. A hand edit on a VM must be captured in git before the session ends.
2. **Build once, promote by digest.** No rebuilds downstream. The image in production is the image accepted in candidate-a. Identity is `sha-<sourceSha>`. Never use `pr-*`, `mq-*` or `preview-*` tags as identity.
3. **Deploy state is machine-written.** Direct bot commits, never PRs. Code branches never hold deploy state.
4. **Standard CI is universal.** All PRs get normal CI and build. Review, candidate-a proof and merge follow the hub sequence.
5. **Affected-only CI.** Never rebuild or retest the world.
6. **Proof is the served build.** For a node, the release reaching `active` is the deploy proof. Then read `/version.buildSha` once from outside the cluster to check identity. For the operator, the proof is the run end plus one `/version.buildSha` read. A green workflow alone, a 200 from the verb, a lease or `/readyz` is a supporting signal.

## Freeze policy (read first for any new platform behavior)

[CI/CD Platform Boundary and Freeze Policy](../../../docs/spec/cicd-platform-boundary.md). The deploy brain (`scripts/ci/*.sh` and `.github/workflows/*.yml`) is frozen. Add no new platform logic in bash or YAML. Add no new deploy, promote or provision workflow. Add no new infra-mutating `.sh`. New platform behavior goes into the typed `.ts` operator plane (`nodes/operator/app/src/features/node-deploy/`, `DeployCapability`). The gate when reviewing: bug fix, catalog-driven change and guard tightening are fine in place. New branching, env policy, promotion semantics and secret or domain rules are platform work. A standalone node's own GitHub Actions are not frozen.

Other contracts to recall:

- [Multi-Repo Sync Contract](../../../docs/spec/repo-sync-contract.md): a change under `.github/**`, `scripts/**` or `infra/**` must consider sync impact to node-template and nodes.
- [`unexecuted-lane-untested`](https://cognidao.org/knowledge/unexecuted-lane-untested): CI-green without one real execution does not validate a new lane.
- [`lane-is-not-control`](https://cognidao.org/knowledge/lane-is-not-control): reconciler, payer and shared-substrate identity follow the control environment.
- [`test-fleet-parity-boundary`](https://cognidao.org/knowledge/test-fleet-parity-boundary): `cogni-test-org` mirrors behavior but isolates authority. The test operator (`test.cognidao.org`) serves test-org nodes only.
- [`node-template-cicd-parity`](https://cognidao.org/knowledge/node-template-cicd-parity) and [`ordinary-node-delivery-boundary`](https://cognidao.org/knowledge/ordinary-node-delivery-boundary): node-template is an ordinary node.

## Operator lane (operator only)

The operator is the control plane. It stays on k3s through Argo, with its own deploy branch. A control plane must not run on the leases it repairs. Everything in this section applies to the operator node only.

| Intent                                                     | Call                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| Flight an operator PR to candidate-a (`test.cognidao.org`) | `POST /api/v1/vcs/flight {nodeRef:{nodeId,sourceSha}}` |
| Promote the operator (`cognidao.org`)                      | `POST /api/v1/deploy/promote {nodeId,env,sourceSha}`   |
| Reconcile shared state and edge (`infra/compose/**`)       | `POST /api/v1/deploy/infra-reconcile`                  |
| Merge any node PR                                          | `POST /api/v1/vcs/merge {nodeId,prNumber,method}`      |
| Release fork CI                                            | `POST /api/v1/vcs/run-ci {nodeId,prNumber}`            |

- Never replace these calls with a personal `gh workflow run`.
- `infra-reconcile` is not a promote. It runs for `env:"production"` (production-promoter gated) or `env:"preview"` (`node.manage_envs`). It accepts no caller workflow, ref, SHA or mode. An env with no infra lever has no convergence path.
- Operator workflow entry points: `pr-build.yml` (build), `candidate-flight.yml` and `candidate-flight-infra.yml` (candidate-a app and infra levers), `flight-preview.yml` (preview on merge), `promote-and-deploy.yml` (preview and production). Verify claims against `.github/workflows/` and `scripts/ci/`. Logic lives in `scripts/ci/`, not in YAML.
- The per-`(env, node)` branch head is current deploy ownership. Workflow concurrency serializes mutation. It is not a reviewer reservation. Re-check `/version.buildSha` at validation start.
- Do not run `deploy-infra.sh` from an app flight. Infra levers provision substrate.
- `type: infra` images (for example litellm) are built in CI, content-hash tagged and deployed by Compose. A new one is a one-file catalog drop. See [create-service.md](../../../docs/guides/create-service.md).
- Provisioning artifacts and env root credentials are not in git. The durable copies are laptop-local under `.local/provision-creds/<env>/`. Custody and recovery: the [`provision-env`](../provision-env/SKILL.md) skill. Never quote a VM IP from a skill. Read it from that README or the kubeconfig `server:`.
- `scripts/setup/provision-env-vm.sh` is the current env provisioner. Shared state (Postgres, Doltgres, Redis, Temporal, LiteLLM, OpenBao, scheduler-worker) runs on the Cherry VM and is not going away.

## VM SSH policy

SSH is not a general tool. Every ad-hoc SSH action is a drift source.

1. SSH is read-only by default. Inspect and tail. Never `kubectl apply` or `edit`, never `docker compose up` by hand, never edit VM files.
2. Write-mode SSH is allowed only on `candidate-a`, only for a short experiment, and the result must be captured in git before the session ends.
3. Never SSH to production, not even to read. Use Grafana and Loki, external `/readyz` and `/livez`, or git state. A recorded human-approved exception is the only way past this rule. Substrate VM out of RAM or disk: read hub [`prod-vm-swap-thrash`](https://cognidao.org/knowledge/prod-vm-swap-thrash) and [`substrate-vm-migration`](https://cognidao.org/knowledge/substrate-vm-migration).
4. Preview reads are discouraged. Prefer Loki and external probes.

SSH keys and IPs live in `.local/{env}-vm-key` and `.local/{env}-vm-ip` on the provisioner device, gitignored, in the primary clone, not in worktrees. If they are absent, this device is not the provisioner. Do not improvise.

## Enforcement rules

- Reuse existing scripts. Extend `deploy-infra.sh` or a primitive in `scripts/ci/`. Do not create a parallel path.
- No manual VM state. Ask: if we destroy and reprovision this VM, does this change survive?
- On VM migration, re-point all three pointers together: the Cloudflare `<env>.vm.cognidao.org` A record, the GH env secret `VM_HOST` and the GH env secret `SSH_DEPLOY_KEY`. A stale pointer stays invisible until a deploy runs, then fails as `exit 255` or `Permission denied` (incident 2026-06-10).
- No new mutable tags. Use digests or `sha-<sha>` tags.
- No new long-lived code branches. Deploy refs are machine-written state.
- A change to `.github/workflows/*`, `scripts/ci/**`, `infra/**` or a deploy ref requires devops-expert as a code reviewer, including an app feature PR that adds an env var or a `curl` step to a deploy file.

## Anti-patterns to flag

- Growing the frozen deploy brain (see Freeze policy).
- Advising a node-level deploy through anything but the verb above.
- App-adjacent sidecars through k8s pod injection. A node's second image is an extra service in the workload. See [node-add-private-service](https://cognidao.org/knowledge/node-add-private-service).
- Treating replica count as a rollout strategy. Prove provider semantics first. See `akash-promotion-north-star`.
- Treating a candidate lock as a review lease. A later flight can replace the candidate.
- Rebuilding in production instead of promoting the proven digest.
- Silent success on no-op runs. A workflow that exits 0 without doing the work paints a false green. Use a distinct outcome (exit code, skipped job, or a loud warning).
- Decision logic in YAML. Status names and summary text belong in `scripts/ci/*.sh`.
- Step-level `if:` for a verification gate. Use a job-level `needs:` and `if:` so the skip is visible.
- Gate ordering by comment. Enforce it by a marker that the downstream script refuses to run without.
- Verifying a cross-PR promotion with one `EXPECTED_BUILDSHA`. Carry per-app `source_sha` provenance with the artifact.
- `cancel-in-progress: true` on deploy workflows. Unbounded health-check polling without a timeout.
- Hand-maintained target lists in workflows. Source `scripts/ci/lib/image-tags.sh`.
- Deploy workflows that call app business logic (data sync, cache warm, index rebuild). Apps schedule themselves. Reference incident: PR #1177, reverted.
- `NODE_RESOLUTION_IS_A_DB_READ`: the operator resolves nodes from its own registry (`resolveNodeRegistry`, `NodeAddressPort`). Never use a static `COGNI_NODE_ENDPOINTS` map in the operator app. That map exists only for the DB-less `scheduler-worker`.
- Using catalog `source_sha` as deployed truth. It is the birth pin only.

## Pointers

- [CI/CD Spec](../../../docs/spec/ci-cd.md) and [CI/CD Project Scorecard](../../../work/projects/proj.cicd-services-gitops.md)
- [`promote` skill](../promote/SKILL.md): operator promotion and its failure modes.
- `.github/workflows/` and `scripts/ci/`: actual source. Verify claims against code.
