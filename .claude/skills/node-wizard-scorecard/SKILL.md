---
name: node-wizard-scorecard
description: Use when an agent receives a Cogni node wizard launch pack, takes over a newly published throwaway node, or must prove the node-wizard launch path end-to-end for an Akash/Crossplane-born node — child customization PR, child CI/image, catalog deploy pin, operator flight request, XComputeWorkload lease lifecycle, and the developer-unblock gate on the live host.
---

# Node Wizard Scorecard

Use this as the first response after receiving a node launch pack. The goal is
not to save the throwaway node; the goal is to prove the node-wizard launch path
is reproducible by an external agent without privileged manual bridges.

**Placement scope: Akash, born through Crossplane.** The k3s app lane is
deprecated for nodes (`akash-node-expert`; `place_k3s` is not a mitigation). A
node reaches its host as an `XComputeWorkload` (`compute.cogni.io/v1alpha1`,
namespace `cogni-<env>`, name == `spec.nodeId`) that Crossplane reconciles
through the private Akash transaction actuator. Crossplane owns watches,
retries, backoff, status and finalizers; Cogni owns only the actuator. This
scorecard is the **operational front-end of the canonical 20-row
`node-substrate-health-checklist`** for a fresh node, not a parallel invention —
when a row here is coarser, the checklist wins.

## Setup

If the workspace root does not contain `.env.cogni`, run
`/contribute-to-cogni` against the production operator and save the returned env
file at the repo root before doing launch work. Use that token to recall the
launch handoff knowledge block (`node-launch-handoff`), the
`node-substrate-health-checklist`, and `akash-cicd-pareto-scope` before
designing the customization PR. Read `akash-node-expert` for the runtime canon
and its live traps.

## First Response

Do not send the full matrix before a child customization PR exists. Before that
point, report only launch facts plus the next concrete action. A status table
with `READY` rows is misleading because the path has not produced a deployable
artifact and human merge latency may still be ahead.

Pre-PR first response:

```markdown
Launch facts:

- node repo:
- parent PR:
- candidate URL:

Current gate: child customization PR not opened
Next action: create a minimal node repo PR and report its URL
```

Humans may send only a repo URL, parent PR, or short status fragment. Recover
the rest from GitHub/operator state; do not ask the human to fill out the
scorecard.

## Required Matrix

Return this matrix only after the child customization PR exists, or when
reporting a terminal blocker that prevents opening one. Every row's evidence is
obtainable **without kubectl or SSH** — operator API, public `/version` +
`/readyz?deep=1`, or Loki via `scripts/loki-query.sh`.

| Gate                   | Evidence                                                                                                                                                          | Status         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Launch pack facts      | node repo URL, parent PR, candidate URL                                                                                                                           | `pass/blocked` |
| Branch protection      | node repo `main` requires the standard CI checks (and a PR) before merge                                                                                          | `pass/blocked` |
| Child customization PR | PR URL in node repo                                                                                                                                               | `pass/blocked` |
| Child CI               | required checks green                                                                                                                                             | `pass/blocked` |
| Child main image       | ghcr `bundle-sha-<child-main-sha>` resolves by **manifest probe** (`/v2/<repo>/manifests/bundle-sha-<sha>`); the tags list is unreliable                          | `pass/blocked` |
| Parent birth PR        | merged or still open                                                                                                                                              | `pass/blocked` |
| Catalog placement      | `infra/catalog/<slug>.yaml` carries `deployment_provider.<env>: akash`, the per-env `compute_api.<env>` cell, and `compute_egress_cidrs` (required on akash rows) | `pass/blocked` |
| Catalog deploy pin     | catalog `source_sha` equals the image-producing child `main` SHA (`CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN` — **not** a gitlink)                                     | `pass/blocked` |
| Repo-spec at that SHA  | the node repo's `.cogni/repo-spec.yaml` `deployment:` block exists **at `source_sha`**, not merely at HEAD (`assertDeclaredNodeDeployment` refuses otherwise)     | `pass/blocked` |
| Candidate flight       | requested through `POST /api/v1/vcs/flight`; run selected by exact headSha/inputs, never "latest run"                                                             | `pass/blocked` |
| XComputeWorkload live  | Argo delivered the XR and the composite went Ready — `{namespace="argocd"} \| json \| name="<slug>"` plus actuator `akash_tx_leased`                              | `pass/blocked` |
| Exact public SHA       | `curl -s https://<host>/version` `.buildSha` == the launched child SHA                                                                                            | `pass/blocked` |
| DNS/TLS                | `dig <host> +short @1.1.1.1` resolves and TLS validates; the XR publishes the CNAME (`status.dns.published`), no hand-written record                              | `pass/blocked` |
| Deep readiness         | `curl -s -o /dev/null -w '%{http_code}' 'https://<host>/readyz?deep=1'` == 200 — see the Deep readiness caveat below                                              | `pass/blocked` |
| Agent-first validation | candidate API exercised using `docs/guides/agent-api-validation.md`                                                                                               | `pass/blocked` |

## Rules

- **Every spawned node repo's `main` MUST have branch protection requiring the
  standard CI checks (and a PR) before merge.** Without it, a PR whose checks
  were skipped or never ran can merge _vacuously_ and the operator's own merge
  gate becomes the only authority.
- Do not push directly to child `main`. Do not merge your own child or parent
  PR — stop at ready/mergeable and report the merge row as pending.
- Do not infer GHCR success from a commit existing; probe the bundle manifest.
- Do not request flight until the catalog `source_sha`, the child image, and the
  repo-spec `deployment:` block **at that SHA** all agree.
- Flight must be requested through the operator API. A source-repo deploy
  workflow, an Akash Console click, or a bespoke deploy script turns the row
  `blocked`, not `pass` — the launch path is what is under test.
- **NEVER kubectl, NEVER SSH, and never touch a lease by hand.** A validator who
  needs cluster credentials has proven nothing about the wizard path.
- DNS is automatic — never hand-create a `<node>-test` record. A fresh-flight
  `NXDOMAIN` is almost always negative-cache; re-check `dig … @1.1.1.1`.
- **A node born on Akash has no `<slug>-node-app` k3s Service.** Anything that
  expects one (scheduler-worker routing maps, in-cluster probes) must splice the
  public host instead — the bug.5094 class, which fails silently.
- Re-promoting the SAME sha into a wedged workload is a silent no-op; promote a
  moving sha. A promote with no image at the sha goes green with only a
  "skipping" warning (bug.5121 / story.5023) — probe ghcr first.
- `spec.leaseEpoch` is bumped by a human or the materializer **only** to replace
  a terminally closed lease. Never bump it to "retry": the actuator refuses to
  re-spend a settled key on purpose, which is what makes a stuck workload loud
  instead of expensive.
- If a gate is blocked by missing operator authority, report the blocker instead
  of inventing a privileged workaround.

## Fresh Boot Health — the developer-unblock gate

After flight and `/version` match, prove the freshly booted node is **usable**,
not just deployed. `deployed` never substitutes for `usable`; missing evidence
is `blocked`, never `pass`.

| Check                        | Evidence                                                                                                                                                                                                                                                                                       | Status         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Lease lifecycle              | one disposable workload goes **create → observe → update → close**. Actuator events in order: `akash_tx_allocation_prepared` → `akash_tx_leased` → `akash_tx_updated` → `akash_tx_released`. Observe on an absent resource answers `{found:false}`, not connection-refused                     | `pass/blocked` |
| Migration ran **from empty** | a Job for `spec.bundle.ref` succeeded **and its log shows tables being created**, not `relation "__drizzle_migrations" already exists, skipping` — see the caveat below                                                                                                                        | `pass/blocked` |
| Operational schema           | node Postgres reachable with node-scoped credentials; the app's own reads work (registration is the cheapest proof)                                                                                                                                                                            | `pass/blocked` |
| Knowledge schema             | Doltgres DB/schema live; a contribution **and** a work item round-trip; repo-spec exposes `knowledge.remote.url`; durability = the Dolt round-trip recipe below                                                                                                                                | `pass/blocked` |
| Registration works           | new agent registration succeeds against the node                                                                                                                                                                                                                                               | `pass/blocked` |
| Temporal                     | one real graph run finishes on the node's queue through the shared worker. `runtime.substrateHost` must be the env VM's published alias (`cogni-<env>.vm.cognidao.org`); without it the lease gets no Temporal/Redis/LiteLLM env and this row cannot pass                                      | `pass/blocked` |
| One real LLM completion      | a registered principal gets a real completion through the declared graph/model path (haiku, free model `gpt-oss-120b`). **Known live failure:** agent chat on Akash nodes has been observed to hang — report `blocked` with the timeout, never paper over it                                   | `pass/blocked` |
| Request-correlated app log   | the exercised request's `reqId` appears in Loki from the **node app**, labeled by env/node/service/SHA. **Known-open: cannot pass today** — see Declared gaps                                                                                                                                  | `blocked`      |
| Cost attribution             | the paid mutation persisted `{node_id, env, XR UID/generation, idempotency key}` **before** contacting Akash; cost rows group by immutable `node_id` (deliberately NOT a FK to the registry). `akash_tx_receipt_bound` precedes `akash_tx_leased`; `akash_tx_identity_conflict` is a hard fail | `pass/blocked` |
| Wallet single-writer         | `ONE_WALLET_ONE_ACTIVE_WRITER` — exactly one actuator reached the wallet. `akash_tx_actuator_wallet_verified` at boot (the actuator asserts its own public `AKASH_ACTUATOR_ACCOUNT_ID`) and no legacy `compute-workload-controller` writer in that env                                         | `pass/blocked` |
| No manual bridge             | no SSH, no Akash Console click, no manual deploy script anywhere in the run                                                                                                                                                                                                                    | `pass/blocked` |

### Deep readiness caveat

`/readyz?deep=1` makes Temporal + scheduler-worker **fatal** (503), so a 200
there is a real substrate assertion. But the body is still flat —
`{"status":"healthy", …}` with no per-substrate detail. **That flat shape is the
gap, not the pass.** Record the deep 200 _and_ pair it with the Temporal graph
run row. Never quote a default `/readyz` 200 as substrate evidence: on that path
Temporal and scheduler-worker failures are non-fatal and still return 200.

### From-empty migration caveat

A migration Job running is **not** the gate. Across all 12 existing env-slots,
27 migration Jobs were observed and **every one** logged
`relation "__drizzle_migrations" already exists, skipping` — those nodes carried
a DB from their k3s era. **A from-empty bootstrap has never been observed.** The
gate is from-empty: the Job log must show the schema being created.
`spec.migration.policy: RequireBeforeTransaction` makes a finished migration a
precondition of every paid transaction (bug.5140), so a refusal surfaces as
`akash_tx_migration_pending`/`akash_tx_migration_failed` rather than a lease.
`Skip` is the only written-down bypass, for workloads with no database at all.

### Loki query discipline

```bash
scripts/loki-query.sh '{namespace="cogni-<env>",pod=~"akash-tx-actuator-.*"} | json | event="akash_tx_leased"' 120 50
scripts/loki-query.sh '{namespace="cogni-<env>",pod=~"migrate-<slug>-.*"}' 120 200
scripts/loki-query.sh '{namespace="argocd"} |= "<slug>"' 120 100
```

- **A single negative sweep is NOT evidence of absence.** Confirm with a second,
  differently-shaped query (widen the selector, drop the filter, extend the
  window) before reporting "no such event".
- Prefer `| json | field="value"` over text regexes. In LogQL regex `.` matches
  any character, so `compute.reconcile` silently matches nothing that looks like
  `compute_workload_reconciled` — and vice versa, a dotted pattern matches things
  you did not mean.
- Loki retention is ~7 days. If the window predates that, say so; do not
  fabricate.

### Dolt round-trip recovery (the `Knowledge schema` durability proof)

Plain `dolt clone` (Dolt CLI) does **not** work on healthy Doltgres data — it
fails `could not find root value: main; table has unknown fields`. That is the
Dolt engine failing to read the Doltgres dialect, NOT corruption. (The same
string from DoltHub's **web-SQL** runner _does_ mean a corrupted repo.) Recover
doltgres-native:

```bash
# creds: JWK keyid at the node's OpenBao cogni/<env>/<node>/DOLT_CREDS_{JWK,KEYID}
docker run -d --name dolt-recover -p 5433:5432 \
  -e DOLTGRES_PASSWORD=recoverpw -v "$HOME/.dolt:/root/.dolt:ro" dolthub/doltgresql:0.57.3
psql "postgresql://doltgres@127.0.0.1:5433/doltgres" \
  -c "SELECT DOLT_CLONE('<owner>/<repo>');"        # SELECT, not CALL
psql "postgresql://doltgres@127.0.0.1:5433/<repo>" \
  -c "SELECT domain,title FROM knowledge WHERE content LIKE '%<marker>%';" \
  -c "SELECT id,type,title FROM work_items WHERE id='<work-item-id>';" \
  -c "SELECT LEFT(commit_hash,10),message FROM dolt_log ORDER BY date DESC LIMIT 6;"
```

Report `blocked` if the DoltHub target is the canonical repo rather than a
throwaway (use the per-env `KNOWLEDGE_DOLTHUB_REMOTE_URL` override), if
`DOLT_CREDS` are absent so the push is a silent no-op, or if the recovered clone
is missing the entry / work item / commit. DoltHub is an unsupported Doltgres
remote — its Dolt-native GC can prune a live base chunk and silently corrupt a
long-lived mirror; prefer a Doltgres-native remote.

## Declared gaps — report, never silently pass

- **`runtime.logPush` (bug.5127) is carried by the XRD but not emitted.** It is
  fail-closed opt-in requiring `LOKI_LEASE_PUSH_*` in `operator-env-secrets`.
  Until it ships, `Request-correlated app log` is `blocked` by construction.
- **Akash app logs do not reach Loki at all today** — only
  controller/litellm/scheduler-worker streams do. Therefore **"prove it from
  Loki silence" is invalid** for anything app-origin: absence there says nothing
  about the app. Use it only for actuator/Argo/substrate streams.
- **Agent chat on Akash nodes has been observed to hang.** If the LLM row times
  out, that is a live finding to report, not a flaky retry.
- `compute_api` defaults to `legacy` per env (`LEGACY_IS_DEFAULT`). If the cell
  is absent or `legacy`, the node did **not** take the Crossplane path — say so
  rather than claiming a Crossplane birth.

## Human Scorecard Timing

Do not present the node formation scorecard to the human until flight has
succeeded, `/version` matches the launched SHA, and agent-first API validation
has passed. The report must include repo links, child PR/check status, the
bundle tag and digest, catalog pin status, flight status, `/version`, the lease
lifecycle row, and a short explanation of the child-build → catalog-pin →
flight → XComputeWorkload path. Facts:
`docs/spec/node-ci-cd-contract.md`; API exercise:
`docs/guides/agent-api-validation.md`.

## Minimal v0 Path

1. Confirm launch-pack facts and recall the knowledge handoff plus
   `node-substrate-health-checklist`.
2. Confirm the node repo `main` has branch protection requiring the standard CI
   checks before merge; enable it if missing.
3. Open a child node customization PR; wait for CI, human/operator merge, and
   the child `main` bundle image (probe the manifest).
4. Confirm the catalog row: `deployment_provider.<env>: akash`,
   `compute_api.<env>`, `compute_egress_cidrs`, and `source_sha` == that SHA.
5. Confirm the node repo-spec `deployment:` block exists **at `source_sha`**.
6. Ensure the parent birth PR is merged, or explicitly ask the human to merge it.
7. Request candidate-a flight through the operator API.
8. Verify `/version`, `/readyz?deep=1`, DNS/TLS, and run agent-first validation.
9. Walk the lease lifecycle create → observe → update → close from the actuator
   stream, and confirm receipts are `node_id`-bound with one wallet writer.
10. Run the from-empty migration check and the Dolt knowledge round-trip.
    Deployed ≠ usable, and usable ≠ durable, until both pass.
11. Present the node formation scorecard, with every declared gap named.
