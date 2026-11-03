# node-deploy · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

The node-deploy blue/green sequencer (task.5400, story.5127) and its read model. The sequencer converges every declared workload to its release; `release-view` projects what it did so a node developer follows deploy progress, success and failure WITHOUT polling `/version`.

## Pointers

- [Sequencer](sequencer.ts) · [Read model](release-view.ts) · [Fakes](testing.ts)
- [Contract](../../contracts/deploy.workloads.v1.contract.ts) · [Store port](../../ports/node-deploy.port.ts)
- [Release routes](../../app/api/v1/deploy/workloads/) · [Log proxy scope](../nodes/observability-logs.ts)
- [Dashboard](../../../../../infra/grafana/dashboards/operator/node-deploy.json) · [Alerts](../../../../../infra/grafana/alerts/node-deploy.alerts.yaml)
- [Log access spec](../../../../../docs/spec/grafana-observability-access.md)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["ports", "shared", "contracts"],
  "must_not_import": ["app", "adapters", "bootstrap"]
}
```

## Public Surface

- **Exports:** `NodeDeploySequencer`, `DEFAULT_SEQUENCER_CONFIG`, `buildWorkloadView`, `buildReleaseDetail`, `deriveReleaseTimeline`, declaration/edge helpers
- **Routes (via app/):** `GET|POST /api/v1/deploy/workloads`, `GET /api/v1/deploy/workloads/releases/{releaseId}?nodeId=&env=`
- **Files considered API:** `sequencer.ts`, `release-view.ts`, `declarations.ts`

## Observability contract (task.5400)

A node developer has THREE views of one deploy. They are written by the same code, so they agree.

1. **One emit helper.** Every sequencer event (`node_deploy_step`, `node_deploy_provider_strike`, `node_deploy_alert`) goes through `NodeDeploySequencer.record`. It writes the Loki line AND, when the event belongs to an attempt, appends the same step to `node_workload_attempts.steps` (`{step, outcome, reason?, dseq?, provider?, elapsedMs?, at}`). There is no second path. Never log a sequencer event with `this.d.log` directly.
   - Persistence is observability only: a failed append logs `node_deploy_step_persist_failed` and never fails or delays a deploy decision.
   - Consecutive identical steps of one attempt collapse into one row (poll loops). Newest 100 steps per attempt are kept (`MAX_ATTEMPT_STEPS`, atomic SQL append).
   - `elapsedMs` (ms since the attempt row was created) rides on every attempt step; `step=activated` also carries `leadTimeMs` (release recorded to serving). Grafana unwraps both.
2. **Release state (derived, never stored).** `deriveReleaseTimeline` computes `releaseState` from attempt phases on every read:
   - `queued` — no attempt yet · `deploying` — an attempt is mid-flight, or a failed lease is still closing
   - `active` — an attempt of the release serves · `parked` — 3 consecutive failed attempts, no paid create until a NEW release (`parkedReason` names the count and the last error)
   - `failed` — newest attempt failed or its live lease was lost, fewer than 3 failures (retry pending)
   - `superseded` — the desired row points at a newer release (`activatedAt` says if this one ever served)
   - `leadTimeMs = activatedAt - recordedAt`; `startedAt` is the first attempt's creation.
   - Read through `GET /deploy/workloads` (`desired.releaseState`, attempts with `steps[]`) and `GET /deploy/workloads/releases/{releaseId}`. Same authz gate as the list (`node.promote_production` for production, `node.manage_envs` otherwise); a release of another node or env is a 404.
3. **Node-scoped logs.** `GET /api/v1/nodes/{id}/observability/logs?env=<env>&service=deploy` returns ONLY that node's sequencer events: the proxy forces `{env, service="sequencer"} |= "node_deploy" | json | nodeId="<id>"` before any caller stage (DEPLOY_EVENTS_PIN_BY_LINE in `../nodes/observability-logs.ts`). `deploy` is reserved and not a lease service name.

Operator-only: the Grafana dashboard `cogni-node-deploy` and the alerts in `infra/grafana/alerts/node-deploy.alerts.yaml` (release parked, no leader for 10m, leadership lost, repeated proof_timeout). The no-leader alert relies on the bootstrap's once-a-minute `node_deploy_sequencer_leader {heartbeat:true}`.

## Responsibilities

- This directory **does**: sequence deploys over ports, emit one event stream, project the read model.
- This directory **does not**: perform IO, import adapters, decide authz, or store derived state.

## Usage

```bash
pnpm exec vitest run --config nodes/operator/app/vitest.config.mts \
  nodes/operator/app/src/features/node-deploy/sequencer.test.ts \
  nodes/operator/app/src/features/node-deploy/sequencer-timeline.test.ts \
  nodes/operator/app/src/features/node-deploy/release-view.test.ts
```

## Standards

- A new sequencer event goes through `record`; a new persisted field needs a contract field and a test in `sequencer-timeline.test.ts`.
- A new release state or rule changes `release-view.ts`, the contract enum and `release-view.test.ts` together.
- Schema changes to the attempts table follow the `schema-update` skill (additive, nullable).
