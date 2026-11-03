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

- **Exports:** `NodeDeploySequencer`, `DEFAULT_SEQUENCER_CONFIG`, `buildWorkloadView`, `buildReleaseDetail`, `deriveReleaseTimeline`, `readWorkloadDeclarations` (reads repo-spec + `.cogni/workloads/*.yaml` at one sha from the repo it is handed, through the deploy-plane port; story.5137), `resolveWorkloadDeclaration` + `needsBuiltImage` (declaration check and lowering; an image of `.` takes the `builtImage` digest), declaration/edge helpers
- **Routes (via app/):** `GET|POST /api/v1/deploy/workloads`, `GET /api/v1/deploy/workloads/releases/{releaseId}?nodeId=&env=`
- **Files considered API:** `sequencer.ts`, `release-view.ts`, `declarations.ts`, `read-declarations.ts`

## Where a node deploys from (story.5127)

`POST /deploy/workloads` deploys a node from ITS OWN repo, not the operator's.

1. **Repo.** The route calls `DeployPlanePort.resolveNodeSource({parentOwner, parentRepo, slug})`. It reads `infra/catalog/<slug>.yaml@main` through the App (the same read as `resolveNodeRepo`). A remote-source node (has `source_repo`) returns its own `{owner, repo}` plus `image_repository` (`ghcr.io/<owner>/<repo>`). An in-repo node (the operator) returns the parent repo with `imageRepository: null`. A missing row is 404 `catalog_missing`.
2. **Declarations.** `.cogni/repo-spec.yaml` and `.cogni/workloads/*.yaml` are read from that repo at `sourceSha` (DECLARED_AT_THE_SHA). The repo-spec `node_id` must equal the requested node (`node_mismatch`).
3. **Built image.** A manifest image of `.` means "the image node CI built at this sha". Only when a manifest asks for it, the route calls `BuiltImageResolverPort.resolveBuiltImage` (anonymous ghcr.io OCI API: pull token, then `HEAD /v2/<path>/manifests/sha-<sha>`, read `Docker-Content-Digest`). The lowered image is `<image_repository>@sha256:<digest>`, never a tag. No such image (or not public) is 422 `built_image_not_found` BEFORE any write; a registry failure is 502 `built_image_lookup_failed`. An in-repo node has no image repository, so `.` stays `built_image_unresolved` (422) and its manifest pins images by digest.

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
   - `superseded` — the desired row points at a newer release (`activatedAt` says if this one ever served). `serving: true` says it STILL backs the live lease; the workload list also returns `servingReleaseId`.
   - The sequencer's `alert/release_parked` step (persisted on the release's newest attempt) is the park verdict: it makes the release `parked` even while its third attempt is still `closing`.
   - `leadTimeMs = activatedAt - recordedAt`; `startedAt` is the first attempt's creation.
   - Read through `GET /deploy/workloads` (`desired.releaseState`, attempts with `steps[]`) and `GET /deploy/workloads/releases/{releaseId}`. Same authz gate as the list (`node.promote_production` for production, `node.manage_envs` otherwise); a release of another node or env is a 404.
3. **Node-scoped logs.** `GET /api/v1/nodes/{id}/observability/logs?env=<env>&service=deploy` returns ONLY that node's sequencer events: the proxy forces `{env, service="sequencer"} |= "node_deploy" | json | nodeId="<id>"` before any caller stage AND repeats `| nodeId="<id>"` as the last stage (DEPLOY_EVENTS_PIN_BY_LINE in `../nodes/observability-logs.ts`). For EVERY scope the caller's remainder must be whole pipeline stages (`|`, `|=`, `|~`, `!=`, `!~`): no `or`/`and`/`unless` (an `or nodeId=~".+"` would widen the preceding label filter), no braces, no `label_format` writing `nodeId|node|env|service`; anything else is a 400 `invalid_query`. `deploy` is reserved and not a lease service name.

Operator-only: the Grafana dashboard `cogni-node-deploy` and the alerts in `infra/grafana/alerts/node-deploy.alerts.yaml` (release parked, no leader for 10m, leadership lost, repeated proof_timeout). The no-leader alert relies on the bootstrap's once-a-minute `node_deploy_sequencer_leader {heartbeat:true}`.

**Hairpin rule.** An app cannot reach a state lease's public forwarded port on its own provider, so every app create excludes blue's provider AND the provider of each bound state workload's active lease (`excludeProviders`, deduped, max 16, logged as step `providers_excluded`).

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

## Notes

- The sequencer holds no IO: ports are injected, so the same state machine runs over fakes in tests and over the actuator in production.
- `release-view.ts` only reads rows the sequencer wrote; it never decides anything the sequencer decides.
