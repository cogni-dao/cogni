---
name: akash-node-expert
description: "Akash runtime canon for how Cogni nodes run on decentralized compute. Use when working on Akash placement, leases, providers, bids, escrow, compute egress, or debugging a node that will not come up on Akash. Nodes ship through POST /api/v1/deploy/workloads; the hub owns that journey. Triggers on: 'akash', 'lease', 'placement', 'bid', 'provider', 'escrow', 'zencloud', 'egress', 'node-deploy', 'sequencer'."
---

# Akash Node Expert

How Cogni nodes run on decentralized compute. This skill holds Akash runtime facts. The hub holds the delivery journey.

## How a node ships

A node declares `.cogni/workloads/<name>.yaml` and calls `POST /api/v1/deploy/workloads {nodeId, env, workload, sourceSha}`. Only `env` changes. The operator sequencer does create, prove, edge flip, retain and close. Read before acting:

- [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence) for the order and gates.
- [deploy-a-declared-workload](https://cognidao.org/knowledge/deploy-a-declared-workload) for the declaration, the watch and the failure signatures.
- [node-service-delivery](https://cognidao.org/knowledge/node-service-delivery) for the design.

Code: `nodes/operator/app/src/features/node-deploy/` (read its `AGENTS.md`). The operator itself stays on k3s and Argo (operator only). Never roll a node back to k3s. Fix forward.

Do not trust any roster written in a skill. Read live state: `GET /api/v1/nodes`, `infra/catalog/*.yaml`, `curl https://<host>/version`.

## Scaling north star

Before you design placement, lease lifecycle, capacity, cost or shared substrate, read [`akash-cicd-pareto-scope`](https://cognidao.org/knowledge/akash-cicd-pareto-scope) (story.5024). Its binding decisions:

- Spawn ends with the production hostname serving the exact immutable SHA. Candidate-a is a passive proof gate. Preview is absent at birth.
- One Akash deployment per `(node, environment)`, not one per service and not one giant fleet lease.
- Pool generic substrate. The controller's recovery path stays outside the leases it reconciles.

When as-built code differs, name the gap and fix toward the target.

## Read ground truth first

A 2026-10-01 session produced five wrong root causes for one node by inferring topology from logs. Each died to a read that was available the whole time.

1. **Release state.** `GET /api/v1/deploy/workloads?nodeId=<id>&env=<env>` shows the desired release and each attempt. The provider and lease id are in the attempt.
2. **Sequencer log.** `{env="<env>",service="sequencer"} |= "node_deploy_step" |= "<releaseId>"`. A good release runs `attempt_planned` to `blue_retiring`.
3. **Money truth.** `scripts/ops/recover-orphaned-akash-lease.sh --audit` reads Console with the actuator credential. The `--audit` summary under-reports. The per-DSEQ read (`DRY_RUN=1 --dseq <dseq>`) is the truth (bug.5262). `{env="<env>"} |= "compute_cost_observed"` in Loki proves the money stopped.
4. **Database truth.** `scripts/grafana-postgres-query.sh` runs read-only SQL with no SSH. `pg_stat_activity` is server-wide. Always `group by datname`. A node datasource may fail auth (bug.5117, SQLSTATE 28P01). Use `--node operator` with a `datname` filter.

## Placement narrows a pool; it is not egress

- `required_placement_countries` filters bids on the provider's declared ingress country. That is not egress. Measure egress from inside a lease. Never derive `compute_egress_cidrs` from the registry.
- Placement lives in the workload's placement spec, not the SDL. Changing the country set does not change the SDL.
- `featEndpointCustomDomain` is optional. Many audited providers publish `false` and never serve a custom host. Both Swiss providers declare `false`.
- `activeLeases > 0` is not a quality signal (bug.5334). It made a provider's first lease unwinnable.
- `ipCountryCode` is GeoIP and it lies. Screen on the declared field.
- Read the roster before you widen any gate. `NO_ELIGIBLE_BIDS` carries `[refused: <reason>=N]` and `[bids: ...]`. First-match-wins attribution hides later gates.
- Market scale: about 1850 registered, about 60 online, about 33 audited, about 28 custom-domain capable across 9 countries. Pass a country set, never one country.

## Probe the market with the dev key

`.env.cogni` carries `AKASH_PROBE_CONSOLE_API_KEY` and `AKASH_PROBE_ACCOUNT_ID`, a dedicated dev wallet. It answers "would X bid" in 2 minutes. Plain HTTP on `https://console-api.akash.network` with `x-api-key`:

- `POST /v1/deployments {data:{sdl, deposit:0.5}}` returns `{dseq, manifest}`
- `GET /v1/bids?dseq=<dseq>`
- `POST /v1/leases {manifest, leases:[...]}`
- `GET /v1/deployments/<dseq>` shows `leases[].status.services.<svc>.uris`
- `DELETE /v1/deployments/<dseq>` closes

Never use the production actuator account. A manual mint has no `akash_tx_allocations` receipt. It cannot be closed through the actuator and it bills invisibly (bug.5189, bug.5262). Always `DELETE`, then re-read state until `closed`. A 200 from `DELETE` is not proof. Price is never the blocker: a bare SDL draws 9 to 11 bids in 10 to 20 seconds.

## Facts that stay true

- The `akash-tx-actuator` is the only Akash wallet writer. One wallet, one active writer, enforced by a Postgres single-writer index.
- A lease outlives every object that names it. Never strip a finalizer to "unwedge" something before you close the lease, verify by re-reading Console, and only then clear. Use `scripts/ops/recover-orphaned-akash-lease.sh`. It refuses to clear what it cannot prove closed.
- The cluster is not the source of truth for spend. Audit the wallet.
- A terminally closed lease's idempotency key is spent. The verb uses a new `releaseId` and attempt for each retry.
- A `state` workload keeps one long-lived lease and is never auto-replaced. App and worker workloads recover on a chain-confirmed close, on `insufficient_funds`, or after 15 minutes of failed proof.
- An empty node database shows as a generic `INTERNAL_ERROR` on `/readyz`. The proof fails and the sequencer retries. When one env works and another does not, diff the envs first.
- Lease logs reach Loki through the lease-log pump (bug.5240) as `{env, node=<uuid>, service=<sdl-service>, source="lease"}`. Read them with `GET /api/v1/nodes/{id}/observability/logs?service=<name>`. On an env with no pump, Loki silence proves nothing.
- Fork CI checks out the PR head, not a merge commit. Files that landed on main mid-PR must be copied onto the PR branch (bug.5124).

## Poly production placement findings, 2026-11-02

- Gen-24 and gen-25 failed `provider_rejected` with zero FI, NL or PT bids, although the same spec drew FI bids from the dev wallet. Gen-26 leased RHITE FI. The cause is unknown. Read the provider roster first, then probe with the dev key.
- Providers froggy (RO) and metz (CH) returned nginx 404 for every host. Do not keep a static list of them. PR #3056 set the provider allowlist (`AKASH_ALLOWED_PROVIDERS`) to empty. Instead, a new app create skips each provider with one confirmed `host_not_routed` strike on any lane in the last 24 hours (PR #3061, bug.5586). The no-lockout rules in `nodes/operator/app/src/features/node-deploy/AGENTS.md` (Provider memory) still apply.
- RHITE FI and BG h6i egress IP varies per pod. Do not pin a `compute_egress_cidrs` /32 to them. UA ithub `89.207.152.9` and FI m3a `95.217.72.142` were stable.
- The Polymarket CLOB geoblock covers only Crimea, Donetsk and Luhansk in UA. UA providers are usable.

## Operator only: control and state substrate

The operator, the scheduler-worker and the Compose substrate (Postgres, Doltgres, Temporal, LiteLLM, OpenBao, OpenFGA, Caddy) run on Cherry. The permanent rule is that the controller and its recovery path cannot self-host only on leases they manage. Move stateless shared services first. Move stateful services only after proven backup, restore and cross-provider recovery.

## Open edges

Check work items before you assume. A second audited provider is needed (task.5075). `compute_egress_cidrs` has no TS writer and is hand-edited (#2175). The shared services admit Akash providers by egress IP (task.5384). Database migrations before a release serves: task.5408. No stop verb exists. If you need one, open a new work item.
