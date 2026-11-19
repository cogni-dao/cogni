# Test envs on candidate-a: `/api/v2/test-envs` (story.5159), rev 3 (fast path)

Goal: a dev gets their own test env, ready, without waiting in a queue. First proof: 4-5 simultaneous spawny-boi test
envs on candidate-a. KPIs and health measurements come second.

## Design

- A test env is one more desired row of the node: workload key `te<6 letters>`, release spec = the node's declared `app`
  at the requested SHA with a new name and host `<slug>-<key>-test.<zone>`. The sequencer already drives every desired
  row concurrently (`features/node-deploy/sequencer.ts:451`) and keys state by `(node, env, workload)`
  (`shared/db/node-workloads.ts:126`), so a new key never supersedes `app` or another test env. No table, no migration.
- `POST /api/v2/test-envs {nodeId, sourceSha, label?}` -> 202 `{testEnvId, host, state}`; `GET /{id}` -> state, host,
  requestedAt, readyAt, readyMs, expiresAt; `DELETE /{id}` closes it. candidate-a only. Ids not matching `^te[a-z]{6}$`
  are 400, so v2 can never touch `app`.
- Authz = v1 POST: `gate()` on candidate-a (`node.flight` OR `node.manage_envs`), then `envNotServed` and
  `nodeNotOnDeployVerb`. `proxy.ts` is untouched: v2 handlers authenticate with `getSessionUser` exactly as v1 handlers
  do; only the perimeter's early rejection is skipped.
- `recordNodeRelease` takes an optional `testEnv`; absent = the v1 path byte for byte. `test-env.ts` (pure) builds the
  spec and host and re-checks the sequencer's own guard (`siblingLabel`, `hostOwnedBy`, `edge.ts:88,116`), so a test env
  never holds the node's main host. It refuses a worker, a non-http app, an app with companions or state bindings.
- `declarations.ts` refuses a manifest named `te<6 letters>` or `main`; a v1 POST of a te key is
  `workload_not_declared`, so no v1 caller can create one.
- Host/DNS: one proxied CNAME per host through the existing edge writer (`edge.ts:225`); no wildcard needed, no edge
  change (key is letters only, so the host regex and `workerHostRefusal` admit it). A closed env leaves a stale CNAME
  (no DNS delete, bug.5633).
- Lifecycle: cap `MAX_TEST_ENVS_PER_NODE = 5` per node (409 `test_env_cap`, never a queue); stopped envs with an open
  lease still count; a post-insert recount closes the cap race. TTL 4 h: `Sequencer.tick` stops running te rows past
  it through `requestStop` (te keys only). DELETE = `requestStop`; `stoppedStep` closes the lease.
- Node topology read (`github-node-deployment-topology.adapter.ts`) drops te keys: they are not services of the node.
- Freeze policy: TypeScript only under `features/node-deploy`, `app/_facades/deploy`, `app/api/v2`, `contracts`,
  `ports`, `adapters`. No shell, no workflow YAML, no YAML change.

## Not in this PR (follow-ups)

- **v1 KPI isolation (was B2).** te rows still reach `servingLanes` (serving drift, `fleet.lanes-down` probes) and
  `releases()` (first-try, success, lead time). Planned: `DeliveryScope.testEnvs` (absent = exclude) in the source SQL
  (`delivery-kpi-source.adapter.ts` `scopeSql`, both aliases) plus an optional, default-less `testEnvs` calculator param,
  then a `deploy.lead-time@1 {testEnvs:"only", quantile:90}` KPI (target <= 15 min). `GET` already returns `readyMs`.
- **DB role caps (was B1).** Nothing applies them on candidate-a (`k3s_node_targets_json` only; `node-deploy` cells are
  dropped; the fingerprint ignores `database`). spawny-boi has app 2 / service 4 for `app` + spare. The manager reads
  `pg_roles.rolconnlimit` and applies a recorded break-glass `ALTER ROLE` sized for `app` + 5 test envs (about 1 app +
  2 service connections per copy). Raising the budget (`max_connections`/pooler, story.5166) and the catalog `copies`
  record come later. The cap constant does not read the catalog.
- Callbacks (scheduler-worker) are out of scope: proof is `/readyz` and `/version`.

## Risks and validation (test.cognidao.org)

Risks: all envs share spawny-boi's database, roles and secrets bucket; N SHAs migrate one DB at start (pick
compatible SHAs); each env asks 2 CPU / 2 Gi / 4 Gi disk (check escrow and bids); a failing te lane shows in
`candidate-lanes-down` until KPI isolation lands; the first te lane may take the mesh transport (`attemptTransport`,
`mesh-attempt.ts:116`).

Steps: 1 flight; read `rolconnlimit`, apply the break-glass. 2 Baseline `GET /api/v1/deploy/workloads` (`app` active).
3 POST 5 spawny-boi SHAs at once; poll GET to `ready`. 4 Each host `/readyz` 200 and `/version` = its SHA; `app`
unchanged; none superseded. 5 Sixth POST -> 409. 6 DELETE all; leases closed. 7 v1 regression: one normal `app` POST
and one operator flight pass.
