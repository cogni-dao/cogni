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

- **Exports:** `NodeDeploySequencer`, `DEFAULT_SEQUENCER_CONFIG`, `buildWorkloadView`, `buildReleaseDetail`, `deriveReleaseTimeline`, `readWorkloadDeclarations` (reads repo-spec + `.cogni/workloads/*.yaml` at one sha from the repo it is handed; story.5137), `resolveWorkloadDeclaration` (declaration check and lowering; an image of `.` takes a `builtImage` digest or, deferred, the `pendingImage` tag), `resolveEnvLanes` + `EnvLaneSequencers` (`env-lanes.ts`: the per-env lanes of ONE sequencer process), declaration/edge helpers
- **Routes (via app/):** `GET|POST /api/v1/deploy/workloads`, `GET /api/v1/deploy/workloads/releases/{releaseId}?nodeId=&env=`
- **Files considered API:** `sequencer.ts`, `release-view.ts`, `declarations.ts`, `read-declarations.ts`, `env-lanes.ts`

## Where a node deploys from (story.5127)

`POST /deploy/workloads` deploys a node from ITS OWN repo, not the operator's.

1. **Repo.** The route calls `NodeSourceResolverPort.resolveNodeSource({nodeId, parentOwner, parentRepo})` (`createNodeSourceResolver`, story.5137). It reads the node's row from the catalog baked into the operator image (`ImageCatalogNodes`, `/app/infra/catalog`; the same catalog the sequencer uses) and checks it with `parseRemoteSourceCatalogRow`. It makes NO GitHub read of a parent repo, so flight (candidate-a) and production are the same call and differ only in env. A remote-source node (has `source_repo`) returns its own `{owner, repo}` plus `image_repository` (`ghcr.io/<owner>/<repo>`). An in-repo node (the operator) returns the env's parent repo with `imageRepository: null`. A node the image does not know is 404 `catalog_missing`.
2. **Declarations.** `.cogni/repo-spec.yaml` and `.cogni/workloads/*.yaml` are read from that repo at `sourceSha` (DECLARED_AT_THE_SHA). The read (`createDeclarationReader`) tries the operator App first. Only when the App is NOT installed on that repo (error code `github_app_not_installed`) does it read anonymously (`raw.githubusercontent.com` for files, the unauthenticated REST contents API for the one directory listing). That path needs no secret, never writes, and works only for a PUBLIC repo; any other App failure is thrown, never masked by the public read. The repo-spec `node_id` must equal the requested node (`node_mismatch`).
3. **Built image (ALWAYS_DEFER).** A manifest image of `.` means "the image node CI built at this sha". The route NEVER waits on node CI and never reads the registry, in any env, for any caller: it lowers `.` to `<image_repository>:sha-<sha>` with `imagePending: true` (`pendingImage`). The sequencer's `pinImage` resolves the digest through `BuiltImageResolverPort` (anonymous ghcr.io OCI API: pull token, `HEAD /v2/<path>/manifests/sha-<sha>`, `Docker-Content-Digest`) BEFORE any attempt row exists. While the image is absent it is `DependencyNotReady` (step `dependency/waiting`, nothing paid, retried every tick); a registry failure waits too; past `imageAlertMs` (30 min) it raises `alert/image_not_published`. The digest is pinned WRITE-ONCE on the release (`StorePort.pinResolvedImage`, column `node_workload_releases.resolved_image`, `UPDATE ... WHERE resolved_image IS NULL`) and the store returns the spec with that digest and no `imagePending`, so every attempt of a release deploys one image and a mutable tag never reaches a create. An in-repo node has no image repository, so `.` stays `built_image_unresolved` (422) and its manifest pins images by digest.
4. **Latest release wins.** A new release for the same `(node, env, workload)` moves the desired row to itself in the same transaction. An older release that never started (for example its image never appeared) is superseded: it gets no attempt and no registry read, and an in-flight attempt of an older release that has not been proven is failed `superseded`.

## One front door, every env (story.5137)

The production operator serves `candidate-a`, `preview` and `production` for canonical Akash nodes (the fleet control env reconciles every Akash lane). The route refuses (`app/api/v1/deploy/workloads/_lib/lane.ts`):

- **(a)** an env outside `NODE_DEPLOY_ENVS` (default: only `DEPLOY_ENVIRONMENT`) with 409 `env_not_served`;
- **(b)** a node this fleet does not own with 409 `node_not_in_fleet` (catalog `source_repo` org != `NODE_SUBMODULE_PARENT_OWNER`, case-insensitive; `isFleetOwnedRow`), or a lane whose `controlEnvFor(env, provider, FLEET_CONTROL_ENV)` is not the fleet control env (`env_not_served`). The test operator therefore refuses canonical toks5;
- **(c)** a record for a lane whose catalog `compute_api[env]` is not `node-deploy` with 409 `node_not_on_deploy_verb`, so the verb never races a Crossplane writer (CD4).

The operator's own canary is exempt from (b) and (c) and is served only in its own `DEPLOY_ENVIRONMENT`. `recordNodeRelease` (`app/_facades/deploy/record-node-release.server.ts`) is the ONE release writer; the route, and later the merge webhook, call it. The sequencer process builds one `NodeDeploySequencer` per served env (`NODE_DEPLOY_ENVS`, `env-lanes.ts`) over the shared payer, store, Cloudflare credentials and advisory lock: per env a `cogni-node-deploy-<env>` secrets namespace (the admission policy reads the env from the name), a substrate host (`NODE_DEPLOY_SUBSTRATE_HOSTS`), and an edge guard from that env's catalog cells filtered by the SAME fleet predicate (`NODE_DEPLOY_FLEET_OWNER`; unset admits no remote-source node). The payer env is the release's env. One pass per env, each its own failure domain.

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

**Rails (bug.5567).** A refused create is persisted (`error: "create refused: ..."`) and never replayed under its `nd:` key; the next attempt takes a new ordinal. An unbound attempt whose `observe` keeps throwing is failed `orphan_suspect:` after `observeUnavailableMs` (15 min from the first failure) with `alert/orphan_suspect` (carries the cogniKey; the lease is NOT claimed closed and nothing re-observes it, so a human acts on the alert). A live app lease whose `/version` serves the exact sha but whose `/readyz` fails is `alert/dependency_down`: kept, never closed or redeployed; the lease is closed only after `/version` itself fails for 15 min (a class change restarts that clock).

Operator-only: the Grafana dashboard `cogni-node-deploy` and the alerts in `infra/grafana/alerts/node-deploy.alerts.yaml` (release parked, no leader for 10m, leadership lost, repeated proof_timeout). The no-leader alert relies on the bootstrap's once-a-minute `node_deploy_sequencer_leader {heartbeat:true}`.

**Hairpin rule.** An app cannot reach a state lease's public forwarded port on its own provider, so every app create excludes blue's provider AND the provider of each bound state workload's active lease (`excludeProviders`, deduped, max 16, logged as step `providers_excluded`).

## Node app runtime env and placement (task.5405)

A node APP of a non-operator node gets the SAME env the retired Crossplane lane rendered, with OpenBao as custodian. The operator's own workloads (slug `operator`) and the dev harness (no `runtime` dep) get only `RELEASE_SHA` and bindings.

- **Env.** `node-app-env.ts` (`nodeAppEnv`, pure, parity-pinned key by key in `node-app-env.test.ts` against `infra/crossplane/xcomputeworkload/composition.yaml` l.185-284). Order, later wins: `HOST/HOSTNAME/PORT`, `APP_ENV`, `DEPLOY_ENVIRONMENT`, `COGNI_REPO_SHA`, substrate topology (`NODE_DEPLOY_SUBSTRATE_HOST`), bucket secrets, `COGNI_NODE_ID`, DB pool maxes (catalog), identity (`NODE_NAME`, `NEXTAUTH_URL`, ...). Then `RELEASE_SHA`, then declared state bindings (CD2: a binding beats the bucket). Injected env beats a same-named declared `env`.
- **Declared keys only.** An `app` release carries `secretKeys` (value-free): the `cogni-node-app-v1` profile keys plus the app service's declared `secret_refs` from the node's repo-spec AT `sourceSha`, computed in `declarations.ts` with `resolveRuntimeProfileSecretRefs` (the helper the Crossplane lane used). A denylisted key (`OFF_CLUSTER_WORKLOAD_DENIED_KEYS`) is refused at lowering (`secret_ref_refused`, 422). A fleet-inherited key that merely sits in the node's bucket (`GH_WEBHOOK_SECRET`, `POSTHOG_API_KEY`, ...) is never on the list and never delivered. `LITELLM_VIRTUAL_KEY` is delivered as `LITELLM_MASTER_KEY`. Every declared key (minus those a state binding supplies) must be present.
- **Worker workloads (task.5272).** A manifest whose workload name matches a repo-spec service with NO `runtime_profile`, beside a distinct `cogni-node-app-v1` service, lowers with `runtimeProfile: "worker"` and `secretKeys` = that service's own `secret_refs` ONLY. The sequencer then builds `workerEnv` (`HOST`, `PORT`, `DEPLOY_ENVIRONMENT`, `COGNI_REPO_SHA`, the declared secrets) instead of `nodeAppEnv`: no node-app profile, database, auth or substrate env, and no DB CA start wrapper. It still has a route (its own `<slug>-<workload>` host) and the same blue/green proof. Anything that does not match both conditions stays the node app (fail safe). Only a worker may claim `<slug>-<workload>`; `workerHostRefusal` (pre-create, `edge.ts`) refuses a workload name that is not one plain label or is `test`/`preview`/`dev`, a host any OTHER catalog slug owns in any env (`NodeCatalogPort.slugs()`), and the node's own host in another env.
- **Secrets (existing custody path).** `NodeRuntimeSecretsPort` (`EsoNodeRuntimeSecrets`) ensures ONE ExternalSecret `nd-<slug>-env` in the sequencer's OWN namespace (`NODE_DEPLOY_SECRETS_NAMESPACE`): `ClusterSecretStore openbao-backend` (ESO's `eso-reader`), explicit `data:` entries `{secretKey: K, remoteRef: {key: <env>/<slug>, property: K}}` for exactly the declared keys (NO `dataFrom: extract`), target `nd-<slug>-env` (Owner, 5m). The slug comes from the image catalog mapping, never caller text. It waits a bounded 20 s for Ready, then reads the target Secret and returns exactly the requested keys. Custody stays in OpenBao; there is NO new OpenBao role and no root token. The sequencer is the ONLY writer of that ExternalSecret (Role: externalsecrets get/create/patch/update in its namespace only). A declared key with no OpenBao property leaves the ExternalSecret not Ready, so nothing is paid.
- **Cluster-side bound.** ESO's store reads `cogni/data/*`, so the sequencer's ExternalSecret rights are fenced by a `ValidatingAdmissionPolicy` + binding (`infra/k8s/base/node-deploy-sequencer/admission-policy.yaml`, bound per overlay to `cogni-node-deploy-<env>`, `failurePolicy: Fail`, `Deny`): store pinned to `ClusterSecretStore/openbao-backend`, no `dataFrom`, no per-entry `sourceRef`, every key `<this env>/<slug>` and never `operator`, `scheduler-worker`, `akash-tx-actuator`, `_system`, `_shared`, `openfga`, `litellm`, `doltgres`, `temporal`, `postgres`, `redis`, `grafana`, `loki` or any bucket containing `database`; target `nd-*`. Pinned by `tests/ci-invariants/node-deploy-sequencer-admission.spec.ts`. Sequencer code is not the boundary.
- **Edge hosts from the catalog.** The edge guard regex is built at boot from the image catalog (`edgeHostRegexFor(ImageCatalogNodes.nodeDeploySlugs(env, fleetOwner))`): the operator's canary plus every node whose `compute_api[<env>]` is `node-deploy` (`^(node-deploy-canary|<slug>...)(-[a-z]+)?\.cognidao\.org$`), so onboarding a node needs no overlay edit and `NODE_DEPLOY_EDGE_HOST_REGEX` no longer exists. Before any paid create the sequencer also requires `hostOwnedBy(host, env, slug)`: the node's OWN host (slug + the env's `-test`/`-preview`/`-dev` suffix; the canary label for the operator) or `<slug>-<workload>` plus the same suffix for a sibling workload of that node (red's `sandbox` at `red-sandbox[-test|-preview]`, the host its app derives), so node A can never take node B's host. Operator hosts (`cognidao.org`, `preview.`, `test.`) never match.
- **NO_HALF_ENV.** A missing key, an ExternalSecret that is not Ready, a node the image catalog does not know, or a malformed catalog cell throws `DependencyNotReady` BEFORE the attempt row exists: step `dependency/waiting` names the keys (never values), nothing is paid, no attempt is burned, and the next tick retries.
- **Catalog.** `NodeCatalogPort` (`ImageCatalogNodes`) resolves node id -> slug + row from `/app/infra/catalog` baked in the image. `node-catalog-policy.ts` reads `required_placement_countries[<env>]` (sent as `spec.placement.requiredCountryCodes`; apps only) and `database.<env>.runtimePoolLimits`.
- **Placement.** `SequencerConfig.appProviders` (`NODE_DEPLOY_APP_PROVIDERS`, INTERIM, task.5384, expires 2026-11-23) is sent as `allowProviders` on app creates; the actuator INTERSECTS it with its own allowlist and refuses an empty result before paying. Step `placement_constrained` records it.
- **Start command.** A node app that receives a DSN starts through `databaseConsumerCommand` (DB CA trust wrapper), as the Crossplane lane did.
- **Not here.** Loki lease push (operator-bucket credentials) and the release-side migration Job are not wired by the sequencer (see the PR).

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
