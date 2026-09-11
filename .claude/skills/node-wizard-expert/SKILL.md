---
name: node-wizard-expert
description: Use when designing, debugging, or operating the Cogni node formation wizard, node formation PRs, submodule-pinned node repos, child image builds, parent candidate-flight, or AI-assistant launch handoffs. Route launch execution and E2E proof to node-wizard-scorecard.
---

# Node Wizard Expert

## Primary Pointer

For any live throwaway-node launch, start with
[`node-wizard-scorecard`](../node-wizard-scorecard/SKILL.md). This skill is the
orientation layer; the scorecard is the execution and proof layer.

## First Recall

Before changing node-wizard launch behavior, recall the operator knowledge block:

- `node-launch-handoff` — `https://cognidao.org/knowledge/node-launch-handoff`
- `akash-cicd-pareto-scope` — `https://cognidao.org/knowledge/akash-cicd-pareto-scope`

That block is the evolving handoff contract for personal AI assistants launching a newly birthed node. Treat it as the operator-owned playbook; refine it when the launch process changes instead of duplicating long runbooks in the wizard UI.

## North-star birth contract — do not normalize the current gap

`akash-cicd-pareto-scope` is mandatory for any formation design or review. The
target acceptance contract is:

```text
Spawn -> repo + immutable bundle -> passive ephemeral candidate proof
      -> same digest in production -> canonical hostname exact-SHA proof
      -> close candidate -> return production-live node
```

- Production is generation-1 activity authority. Candidate-a validates but
  never creates a competing activity ledger; preview is absent at birth.
- The node is born Akash-native with one deployment/placement group per
  `(node, environment)` workload bundle. App-tier sidecars share that group.
- Shared generic substrate remains pooled; do not create a Temporal worker,
  database, queue, or model gateway per node by default.
- A shared-runtime scope is the cheaper starting product when a community does
  not need unique executable code. It is not a sovereign node.

Today formation emits candidate-a only and missing placement still defaults to
k3s. Treat that as the critical implementation gap, not the intended lifecycle.

## Ground Truth

- `.claude/skills/node-wizard-scorecard/SKILL.md`
- `docs/spec/node-baas-architecture.md` — node-as-a-service architecture + substrate model (read for the substrate-gaps work)
- `docs/design/node-wizard-secret-setting.md`
- `docs/guides/node-formation-guide.md`
- `docs/spec/node-ci-cd-contract.md`
- `scripts/ci/reconcile-edge-caddy.remote.sh` · `scripts/ci/reconcile-node-substrate.sh` — the substrate lane (edge + per-node DB/secret reconcile)
- `nodes/operator/app/src/features/nodes/launch-pack.ts`
- `nodes/operator/app/src/app/api/v1/nodes/[id]/launch-pack/route.ts`
- `.claude/skills/conductor-worktree-setup/SKILL.md`
- `scripts/conductor-worktree-setup.sh`
- `scripts/ci/sync-node-template-fork-pr.sh`

## Operating Rule

Today the wizard mints and publishes birth facts, then hands launch execution to
an AI assistant through the launch pack. Keep CI, GHCR, flight, Argo, and
`/version` state derived from their source systems rather than duplicating saved
wizard state. The north-star assistant flow must drive the full saga above and
return a production-live node; a generated PR or candidate deployment is only
progress, never successful Spawn completion.

Recent launch-path finding: generated parent birth PRs for throwaway nodes are
not progress by themselves. Progress is a scorecard row moving from blocked to
pass without privileged manual bridge work. A child commit without a child
`sha-<child-sha>` GHCR image is a blocker, not a deployable pin.

**DNS is automatic; edge is automatic-but-fragile (known gap).** A wizard-born node's public host (`<node>-<env>`) has its A-record upserted by `reconcile-node-dns.sh` (catalog-driven) and its edge Caddy route written by the flight's `node-substrate` job (`reconcile-edge-caddy.remote.sh`). DNS is reliable; the **edge is NOT yet reliably hands-off** — see the substrate-gaps table below (a freshly-flighted node can be Argo-Healthy and serve in-cluster yet return external 000 because Caddy's running config didn't pick up the new site). Canon: [`docs/spec/ci-cd.md` Axiom 21 `DNS_IS_RECONCILED_PER_ENV`](../../../docs/spec/ci-cd.md); operational detail in the `dns-ops` skill. A fresh-flight `NXDOMAIN` is usually negative-cache (`dig <host> +short @1.1.1.1`); a fresh-flight **external 000 with DNS resolving + pod Healthy is the edge-reload gap (bug.5031), not DNS**.

## Substrate E2E is NOT yet hands-off — gaps + heal recipes

The first real **production** node launch (beacon, 2026-06-16) proved the **control plane** (formation, flight dispatch, RBAC) works, but the **substrate plane** (DB + edge + secrets + preview lease) has gaps that each needed manual intervention — _nothing self-healed_. Treat these as known failure modes until the linked work lands. Architecture spec: [`docs/spec/node-baas-architecture.md`](../../../docs/spec/node-baas-architecture.md) (§ Cognition Substrate + the substrate lane).

| Gap                                  | Symptom                                                                                               | Heal recipe (manual, until fixed)                                                                                                                                                            | Fix                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Edge not reloaded**                | node Argo-Healthy + serves in-cluster, but `<slug>-<env>.cognidao.org` → external **000**             | on the VM: `docker exec <edge-caddy-container> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`                                                                               | **bug.5031 / PR #1697** (reload+verify, hash gated on success)                       |
| **Doltgres DB missing**              | pod `Init:CrashLoopBackOff`; `migrate-doltgres` FATAL `database "knowledge_<slug>" does not exist`    | on the VM: `docker exec -e PGPASSWORD=<doltgres-pw> <doltgres-container> psql -h 127.0.0.1 -U postgres -c 'CREATE DATABASE knowledge_<slug>;'`, then `kubectl delete pod <crashlooping-pod>` | **bug.5033** (add doltgres DB-create to the substrate lane next to the Postgres one) |
| **Preview = single GLOBAL lease**    | preview deploy queues forever; `deploy/preview` `review-state: reviewing` on a stale/unrelated sha    | commit `unlocked` to `deploy/preview/.promote-state/review-state`, then `gh workflow run flight-preview.yml -f sha=<main-head>`                                                              | **bug.5032** (per-node preview lease, mirror candidate-a)                            |
| **Prod-promote `sourceSha` footgun** | prod promote dies at `decide → Checkout`; `head_sha` = a node child sha absent from the operator repo | call `POST /api/v1/deploy/promote {nodeId, env:"production"}` with **NO `sourceSha`** → preview-forward reads `deploy/preview-<slug>`                                                        | (file: reject `sourceSha` for node prod-promote)                                     |
| **No LLM backend**                   | node deploys but `POST /chat/completions` times out                                                   | provision the node's LiteLLM/model secret                                                                                                                                                    | (gap — graph exec unusable until wired)                                              |
| **Launch agent flounders**           | fresh agent hunts `.env.cogni`, 401s recalling the knowledge block                                    | register first (`/contribute-to-cogni`) → save token → _then_ recall                                                                                                                         | **bug.5030 / PR #1695**                                                              |
| **Can't track flight**               | dev hangs on a hand-rolled watcher                                                                    | poll candidate `/version` for `buildSha==sourceSha` (authless); never watch GH Actions                                                                                                       | **task.5021** (operator flight-status API)                                           |
| **"pin" PR stalls**                  | `chore(node): pin <slug>` PR sits open, not auto-merged                                               | merge it (operator merge-authority) → triggers `flight-preview`                                                                                                                              | **task.5022** (auto-bump+merge `source_sha`, rename pin→bump)                        |

Production heal needs prod read/SSH (owner-gated; "never SSH prod" is the default — a one-off prod data fix needs explicit owner authorization and a captured follow-up bug). **Pareto fix: make the substrate lane idempotent + verify-and-heal (DB + edge + secrets) so none of these need a human** — bug.5033 + PR #1697 are the first two. Note: work-item IDs (`bug.503x`) currently collide with in-code bug refs (e.g. `bug.5031` is also the Grafana datasource-drift class in committed docs) — confirm against the work API before citing.

## Repo Ancestry Rule

Wizard-minted nodes must be named forks of `node-template`, not GitHub template-generated repos. Template generation copies a snapshot without shared git history, so agents cannot fetch `node-template` and merge future template updates. The publish path should call `GitHubRepoWriter.forkFromTemplate`, wait for the forked `main`, commit only the regenerated `.cogni/repo-spec.yaml` identity on top, and pin that identity commit as the operator submodule gitlink.

If a same-named repo already exists, reuse it only when it is a fork of the configured `NODE_TEMPLATE_OWNER/node-template`; otherwise fail closed and repair the repo lineage explicitly.

## Fast Repair

When a minted test-node fork lags behind `cogni-test-org/node-template`, refresh
its existing PR branch with:

```bash
PR_TITLE='ci: sync <slug> node CI' \
  scripts/ci/sync-node-template-fork-pr.sh cogni-test-org/<slug> <branch>
```

This is the repeatable version of the manual `test-cog` repair: fetch the fork
PR branch, merge the current test-org template, auto-resolve the known stale
`ci.yaml` image-name conflict in favor of the template, run the node workflow
invariant, push, and print the PR/check links.
