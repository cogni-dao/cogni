# Test envs on candidate-a: `/api/v2/test-envs` (story.5159) - rev 2

Goal: a dev gets their own test env, ready, without waiting in a queue. Rev 2 answers design review (B1-B3 and
notes). Evidence pinned to origin/main `9f1fd0f88c`; paths under `nodes/operator/app/src/` unless stated. #3176 is
not a dependency.

## Core idea

A test env is one more desired row of the same node: workload key `te<6 letters>` (e.g. `teqwkzmx`), release spec =
the node's declared `app` manifest at the requested SHA with a new name and host. The sequencer drives every desired
row concurrently (`features/node-deploy/sequencer.ts:451-460`) and keys state by `(node, env, workload)` (pk
`shared/db/node-workloads.ts:126-127`), so a new key never supersedes `app` (supersede = same-key upsert,
`adapters/server/node-deploy/postgres-store.adapter.ts:414-438`). No table, no migration (columns are `text`;
`migrations/0055_node_workloads.sql`, `0064` have no CHECK/enum). The key is `te` + 6 letters, not `te-<id>`: a
hyphen is refused for sibling labels (`edge.ts:142`) and the edge host regex takes letters only (`edge.ts:69`), so the
edge needs no change. Spawny-boi's zone is `cogni-testing.org` (live `spawny-boi-test.cogni-testing.org` = 200), so a
host is `spawny-boi-teqwkzmx-test.cogni-testing.org`. Test envs exist on candidate-a only.

## 1. API (`app/api/v2/test-envs/`; `contracts/test-envs.v2.contract.ts`)

- `POST {nodeId, sourceSha, label?}` -> 202 `{testEnvId, host, state:"requested"}`. `label` is stored as the declared
  env `COGNI_TEST_ENV_LABEL`. Strict body: any other key, and any `env`, is 400 before the gate.
- `GET /{id}` -> `{testEnvId, nodeId, sourceSha, host, label, state, requestedAt, readyAt, readyMs, expiresAt}`.
  State comes from `buildWorkloadView` (`release-view.ts:190`) via `testEnvState` (requested, deploying, ready,
  failed, closing, closed). `requestedAt` = release `createdAt`; `readyAt` = first `activatedAt`.
- `DELETE /{id}` -> 202 `{testEnvId, state}`; see 7. Ids not matching `^te[a-z]{6}$` are 400, so v2 can never read or
  stop `app`. An unknown id is 404 before the gate (the id carries no node); a known id the caller may not touch is
  the gate's 403. Ids are random, so only existence is disclosed.
- Authz = v1 POST: `gate()` (`_lib/gate.ts:45`) on candidate-a (`node.flight` OR `node.manage_envs`,
  `_lib/authz.ts:33-34`), then `envNotServed`, `nodeNotOnDeployVerb` (`_lib/lane.ts`), in v1's order
  (`app/api/v1/deploy/workloads/route.ts:64`). **`proxy.ts` is untouched.** It covers `/api/v1/*` only (`:75-77`,
  `:228-244`); v2 handlers authenticate with `getSessionUser` (session or agent key) exactly as every v1 handler does.
  A v2 request skips only the perimeter's early rejection, never the handler's check. Perimeter parity is a follow-up.

## 2. Lane model and v1 byte-identity

1. `features/node-deploy/test-env.ts` (pure): `isTestEnvKey`, `newTestEnvKey`, `testEnvSpec(app, key, slug, binding)`:
   name = key, host = `hostForEnv("<slug>-<key>.<zone>")`, optional label env. It re-checks the sequencer's own guard
   (`siblingLabel` `edge.ts:116` returns the key; `hostOwnedBy` `edge.ts:88` passes), so a test env never holds the
   node's main host. It refuses (422 `test_env_unsupported`) a worker, a non-http app, an app with companions or state
   bindings (shared state), and the operator node.
2. `recordNodeRelease` (`app/_facades/deploy/record-node-release.server.ts:126`) takes an optional `testEnv`. Set: it
   resolves workload `"app"` (`declarations.ts:177`), maps the spec, checks the cap, records under the key. Absent:
   the v1 path, byte for byte (a v1 result has no `host`). Only the v2 POST passes `testEnv`.
3. `declarations.ts`: refuse a manifest named `te<6 letters>` or `main` (whole set, `workload_manifest_refused`). A v1
   POST of a te key is `workload_not_declared`, so no v1 caller can create one and no node can spoof one.
4. Sequencer: `assertNewAppHost` (`sequencer.ts:1397-1450`) already admits the te host (plain label, not an env word).
   No create/activate branch. Added only: the TTL pre-pass (7).
5. Shared with `app` (by design, per `(env, slug)`): the secrets bucket (same keys as the app lane), the database and
   its roles, the node's Temporal namespace. The first te lane's create may take the mesh transport, because
   `attemptTransport` reads node-wide history (`mesh-attempt.ts:116-135`); it is not a separate lane choice.

## 3. Host and DNS

`EdgeRouter.point` (`edge.ts:225`) writes one proxied CNAME per host (`DnsRecordsPort`, `ports/node-deploy.port.ts:450`);
canary hosts work this way; no wildcard in `infra/`. `-teqwkzmx-test` matches the regex (`(-[a-z]+(-[a-z]+)?)?`).
`NEVER_WITHDRAWN` (`edge.ts:18`): no delete, so a closed env leaves a stale CNAME (bug.5633). Accepted; one per env.

## 4. DB connections, cap, and who applies the role caps (B1)

`infra/catalog/spawny-boi.yaml` had no `copies` (profile `shared-default-v1`: app 2, service 4, `copies: 2`). Each
copy adds app +1, service +2. The candidate-a sum in `tests/ci-invariants/shared-db-budget-sum.spec.ts` is **79 of 85**;
`copies: 4` adds 6 -> **85, passing with zero headroom** (the spec passes; a new case pins spawny-boi at 4 / app 4 /
service 8). So 2 test envs per node, not 3 (three needs `max_connections` or a pooler, story.5166).
**Nothing applies those caps on candidate-a.** `candidate-flight.yml` matrixes `k3s_node_targets_json` only,
`selectDeploymentTargets` drops `compute_api=node-deploy` cells, `candidateDeploymentFingerprint`
(`features/compute/node-deployment-targets.ts:72`) ignores `database`, and no runtime code reads `database.copies`.
So the catalog edit is a record, not an action. The manager does it once: read `pg_roles.rolconnlimit` for the
spawny-boi app and service roles on candidate-a; if still 2/4, run a one-time break-glass `ALTER ROLE ... CONNECTION
LIMIT` to the values `copies: 4` yields (4 and 8). The PR's catalog edit captures it in git. Wiring the cap into the
sequencer or a deploy-infra step is a follow-up, not hidden here.
**The 409 reader:** `testEnvCap(catalogRow)` in `test-env.ts` reads `database["candidate-a"].copies` from the row the
route already holds (`gate().catalogRow`, the image-baked `infra/catalog/<slug>.yaml` through `createNodeCatalog`,
`bootstrap/capabilities/node-catalog.ts`). `cap = clamp(copies - 2, 0, 3)`, where 2 is the app lane's live + spare. No
`copies` -> 0. It never reads `infra/database-budget-profiles.yaml`.

## 5. Callbacks

Out of scope: proof is `/readyz` and `/version`. Not stacked on #3176.

## 6. KPI and v1 isolation (B2, B3)

`deploy.lead-time@1` already measures `activatedAt - release.createdAt` (`delivery-kpis.ts:121-139`); `createdAt` is the
POST instant, so that is request-to-ready. te rows must not move any v1 reading, and they reach it by four paths:
`servingLanes` (serving drift, `no_active_attempt`), `fleet.lanes-down` probes and `fleet-probe-snapshot.ts`, and
`releases()` (first-try, success, lead time). One filter closes them all.

- `DeliveryScope.testEnvs?: "only" | "include"` (`ports/delivery-kpi.port.ts:21`). Absent = te rows EXCLUDED.
- Source SQL: `scopeSql` (`adapters/server/node-deploy/delivery-kpi-source.adapter.ts:74`) adds
  `AND <r|d>.workload !~ '^te[a-z]{6}$'` for both aliases; `only` uses `~`; `include` adds nothing. The pattern is
  `TEST_ENV_KEY_PATTERN` in `ports/node-deploy.port.ts`, the SQL twin of `isTestEnvKey`.
- Calculators: `testEnvs: z.enum(["only","include"]).optional()` in `scopeShape` (`delivery-kpis.ts:81`), NO default,
  so stored params, binding identity and the default evidence text (`scope:node=*,env=..`) stay byte-stable. The
  fleet snapshot cache key includes the mode, so `only` never shares a snapshot. `fleet.lanes-down` and drift pass no
  `testEnvs`, so they exclude te rows without a change.
- New KPI (hub, via metrics-expert): `deploy.lead-time@1 {env:"candidate-a", quantile:90, days:7, testEnvs:"only"}` <= 15 min.
- B3: `GitHubNodeDeploymentTopologyAdapter.listNodeDeployServices`
  (`adapters/server/node-deployment/github-node-deployment-topology.adapter.ts:163`) drops te keys, so they are not
  services of the node; a lane with only te rows reads as "topology unavailable", as with no release.

## 7. Lifecycle

- Cap 409 `test_env_cap`, never a queue. A node's slots = its running te rows plus stopped te rows whose lease is not
  terminal (`TERMINAL_ATTEMPT_PHASES`, `stop-plan.ts:25`): a closing lease still holds connections.
- Cap race: the store has no per-node lock for this. The writer counts before any side effect, records, then recounts
  and ranks held rows by `(updatedAt, key)`; a request ranked past the cap stops its own row (`system:test-env-cap`)
  and is refused 409. Residual: two POSTs whose commit order differs from their `updatedAt` order can both pass; the
  role limit (section 4) then refuses connections, never data.
- TTL 4 h: `Sequencer.tick` runs `expireTestEnvs` first: `requestStop(by:"system:test-env-ttl")` for running te rows
  older than the TTL (`updatedAt`). `expiredTestEnvs` selects only te keys. `stoppedStep` (`sequencer.ts:499`) then
  closes the lease.
- DELETE: `requestStop` (the one writer of `stopped`, CD4) then `stoppedStep` closes every open lease and reads the
  close from chain. A delete-kind app needs no destroy (CD5). Idempotent.

## 8. Freeze policy

All logic is TypeScript under `features/node-deploy`, `app/_facades/deploy`, `app/api/v2`, `contracts`, `ports`,
`adapters`. No `scripts/ci/*.sh`, no workflow YAML. The only YAML touch is one existing data key (`copies: 4`).

## 9. PR plan

One draft PR, fresh branch from origin/main: `test-env.ts`, `test-env-view.ts`, `record-node-release.server.ts`,
`declarations.ts`, `sequencer.ts` (TTL), `delivery-kpis.ts`, `fleet-probe-snapshot.ts`, the source adapter, the topology
adapter, `ports`, the contract, 2 routes, `infra/catalog/spawny-boi.yaml`, tests, this file.

## 10. Risks and validation (test.cognidao.org, `COGNI_CANDIDATE_OPERATOR_API_KEY`)

Risks: (a) role caps unapplied until the break-glass (section 4). (b) Two SHAs migrate one shared DB at start
(`DATABASE_MIGRATION_URL`): pick schema-compatible SHAs; the hazard is real and per-env DBs are a later step. (c) Each env
asks 2 CPU / 2 Gi / 4 Gi disk: check test-account escrow and bids first. (d) Running te lanes are probed only by the
`only` reading; v1 readings exclude them. (e) p90 <= 15 min is not guaranteed (node-template p90 16 min); the KPI is
honest. (f) Stale CNAMEs. (g) `GET` is row-first (404 before the gate).
Steps: 1 flight the PR; read `rolconnlimit` and apply the break-glass if 2/4. 2 Baseline `GET /api/v1/deploy/workloads`
(`app` active at `98873adc`). 3 POST two spawny-boi SHAs with images at once; poll GET to `ready`. 4 Each host: `/readyz`
200, `/version` = its SHA; `app` host unchanged; neither row superseded. 5 `readyMs` for both; calculator with
`testEnvs:"only"`; and the default `deploy.lead-time@1` reading is unchanged. 6 Third POST -> 409; no
`too many connections for role`. 7 DELETE both -> leases closed. 8 v1 regression: one normal `app` POST and one
operator flight pass.
