---
id: story.5016.handoff
type: handoff
work_item_id: story.5016
status: active
created: 2026-09-15
updated: 2026-09-15
branch: main
last_commit: e9b2965d26
---

# Handoff: Akash on Crossplane — production cutover

## Mission

**Pickup:** you own moving the **production** fleet onto the Crossplane rail, paid by production's own Akash wallet. The rail itself is **proven** — one node completed `create → observe → update → close` on a real paid lease with node_id-bound receipts. What remains is production: it has no actuator Deployment, its nodes still run on the frozen legacy controller, and their leases are paid by candidate-a's account. Derek's binding direction: **production governs Spawn; candidate-a is a transient validation gate whose nodes are ephemeral.**

## Goal

Every production node reconciled by Crossplane and paid by the production wallet `akash10auj6u6wr7aqjawuxurgue9w7wfnca50t8cr4l`, with zero orphaned leases on any account.

**E2E validation, in order:**
1. Production actuator pod `1/1`, logging `akash_tx_actuator_wallet_verified` with `expectedAccountId=akash10auj6u6wr7aqjawuxurgue9w7wfnca50t8cr4l` — **not** candidate-a's account.
2. For one node: `kubectl -n cogni-production get xcomputeworkload <nodeId>` → `phase: Ready`, `serving: true`, and `https://<node>.cognidao.org/version` `.buildSha` equals the promoted SHA exactly.
3. `akash_tx_allocations` in the production operator Postgres has exactly **one** row for that `node_id`, `wallet_scope='akash-console:production'`, `state='allocated'`.
4. **Ordering assertion (Derek, binding):** `akash_tx_receipt_bound` appears **before** `akash_tx_leased`. If ever inverted, stop — a lease with no preceding receipt is an unattributable paid resource, and the NOT NULL columns gate the write, not the ordering.
5. No lease on either account without a matching CR/XR.

## Start By Reading

- **`story.5016` work item `outcome`** — the authoritative 1–14 checklist. Steps 1–13 are DONE. Read before anything.
- Hub: **`akash-actuator-wallet-cutover`** (merged 2026-09-15 — it was 404 for most of this work, which is why the wallet design kept being re-derived from a YAML comment), `akash-cicd-pareto-scope` §"Spawn ends at production", `unexecuted-lane-untested`, `deploy-ref-ancestor-invariant`.
- Skills: `cicd-secrets-expert` (§"Placement is not provisioning"), `akash-node-expert`, `devops-expert`, `provision-env`.
- Code: `infra/crossplane/xcomputeworkload/{xrd,composition}.yaml` · `nodes/operator/app/src/features/compute/{compute-workload-manifest,node-compute-api}.ts` · `nodes/operator/app/src/bootstrap/akash-tx-actuator.ts` · `infra/k8s/base/akash-tx-actuator/` · `infra/k8s/overlays/production/operator/kustomization.yaml` (its comment already anticipates your first task).
- Credentials: `~/dev/cogni-template/.local/provision-creds/{candidate-a,preview,production}/` — README status table is the custody SSoT. Do **not** hunt `~/.ssh`.

## Current State

- `main` = `e9b2965d26`. **Production serves `f2ab03f660` — 6 commits behind main.** Fleet 6/6 · 200.
- **THE RAIL IS PROVEN.** levelup on candidate-a did all four rungs on dseq `1789435347755`: `migration_pending → migration_proven → receipt_bound → allocation_prepared → allocation_recorded → … → akash_tx_released`. Ledger settled, no orphan. Public URL served the exact SHA.
- **Two Console accounts, both current. There is no "old" account** — the thing being retired is the legacy *controller*, not the account:

  | account | env | state |
  |---|---|---|
  | `akash10auj6u6wr7aqjawuxurgue9w7wfnca50t8cr4l` | production | dedicated, funded, primary. Key live at `cogni/production/akash-tx-actuator/…` v4, verified `200 Cogni-1729` |
  | `akash12eh8xgpeyumar3sk6wp94y0tq9uh62mkezxjmt` | candidate-a (+ preview later) | current, in use. **Its key was deleted by Derek — the secrets dev owns re-writing it.** |

- **13 leases exist; all paid by `akash12eh8…`** — candidate-a 2 remaining, preview 5, production 5. The new account has **0** deployments.
- Production has: actuator ExternalSecrets (#2234, merged) — but **no actuator Deployment**, **no `AKASH_ACTUATOR_ACCOUNT_ID` pin**, **no Crossplane control plane** (#2235 open).
- The production legacy controller's mounted key returns **401** (`/var/run/secrets/compute/AKASH_CONSOLE_API_KEY`, from `operator-env-secrets`). It cannot create, update, **or close**.
- Open PRs: **#2235** (prod control plane, mine, needs merge) · **#2231** (deploy-ref ancestry) · **#2229** (refusal survives boot deadline) · **#2220 / #2224** (actuator observability, secrets dev's).
- Bugs: 5143/5144/5146/5148 **done**; 5150/5151/5152 open; 5145/5149/5154/5155/5156 filed; **5153 cancelled (false premise)**.

## Design / Implementation Target

1. **Never write a wallet credential to `cogni/<env>/operator`.** Proven this session: that bucket is projected into `operator-env-secrets`, which the **public** node-app consumes via `envFrom` — a live key there sits in an internet-facing process env. The dedicated `cogni/<env>/akash-tx-actuator/*` bucket exists to prevent exactly this, and a misfile already burned a key once.
2. **One wallet, one active writer, per environment.** Each env runs one actuator + one ledger; `akash_tx_allocations_single_writer_idx` is a **per-database** partial index and cannot see another env's ledger. An env may be seeded only once it has its own funded account. Preview therefore gets **no actuator** at birth.
3. **A lease's payer is fixed at create.** There is no migration — production slots are **delete + recreate**. `task.5097`: *"Do not import 12 old leases."*
4. **Close first, then create.** Derek: no overlap, no DNS contention. There are no users; downtime is accepted and must not be engineered away.
5. **Reproducible by code.** Closes/creates go through verbs (`POST /nodes/<id>/envs`, `POST /deploy/promote`, `POST /deploy/infra-reconcile`) or a catalog PR — never ad-hoc `kubectl`. The one sanctioned exception is documented in Next Actions.
6. **CI/CD freeze holds.** No new decision logic in workflow `run:` blocks; reuse a `scripts/ci/lib/` primitive or add typed TS. CI does not enforce this — review does.
7. **Do not touch the secrets lane.** `cogni/candidate-a/akash-tx-actuator/*`, `infra/k8s/overlays/**` actuator ExternalSecrets, and `infra/secrets-catalog.yaml` belong to the secrets dev. Tell them before re-flighting candidate-a so they can land its key first.
8. **`spec.leaseEpoch` is not plumbed by the materializer** (only the XRD/Composition know it; it defaults to 0). Once a production lease closes, that node **cannot get another** — the actuator refuses a settled key (`akash_tx_create_refused_settled_key`) and `kubectl patch` is reverted by selfHeal. **Fix this before the first production create**, or you have no rollback and no redeploy-after-close.

## Next Actions / Risks

- [ ] Merge **#2235** (prod Crossplane control plane; inert — births gate on `CROSSPLANE_ACTUATOR_WALLET_ENVS`, still `["candidate-a"]`).
- [ ] **Promote production** — it is 6 behind main, so #2234's ExternalSecrets have not reached the cluster. Use the newest commit touching `nodes/operator/app`, **not** main head (see gotchas).
- [ ] Add `base/akash-tx-actuator` + pin `AKASH_ACTUATOR_ACCOUNT_ID=akash10auj…` to `infra/k8s/overlays/production/operator/kustomization.yaml`, and add `production` to `CROSSPLANE_ACTUATOR_WALLET_ENVS` **in the same PR** (an invariant ties the list to envs with a non-empty pin — they must move together). Don't miss the `akash-tx-actuator-service-name` transformer: `namePrefix: operator-` otherwise renames the Service and every OBSERVE gets connection-refused.
- [ ] Plumb `spec.leaseEpoch` (target #8 above).
- [ ] **Derek closes the 5 production leases in Console** — one-time retirement, needs no API key (Console is a UI with an account login), not worth automating.
- [ ] Clear the 5 stuck finalizers afterwards. **This is the one sanctioned hand-mutation:** the CR's finalizer 401s against the dead key, hangs `Terminating`, and blocks the Argo app and therefore the new XR. It is on a controller `task.5098` deletes. **Record each one** so it does not read as routine.
- [ ] Then per node: catalog PR flipping `deployment_provider.production: akash` **and** `compute_api.production: crossplane` together — shipping either alone buys a wasted lease on the wrong wallet.

**Gotchas that cost hours here:**
- **Promoting main head can silently skip the operator.** Affected-only means no new operator image if main head didn't touch `nodes/operator/app`. Find the real target with `git log --oneline <sha> -- nodes/operator/app`.
- **A deploy ref pinned off `main` is a time bomb, not cosmetic.** `deploy/candidate-a-control-plane` sat at a commit unreachable from main, serving a stale Composition that omitted `identity`; every CREATE 400'd for hours. **Two agents saw it `OutOfSync` and both called it cosmetic.** Fix verb: `POST /api/v1/deploy/infra-reconcile` at an open control-plane PR head. See bug.5150 / #2231.
- **A lane that has never executed is untested whatever CI says.** Six independent defects surfaced on first real execution, each fatal alone, none caught by CI.
- **Do not link failures you have not tested.** `ProviderRejected` on the production CRs is a *separate, older* failure (last success 23:16:57Z) — I linked it to the 401 without testing and reported a false blocker. Same shape as bug.5153, which I filed claiming a catalog allowlist was broken when the route is `DENYLIST_NOT_ALLOWLIST` by design. **Read the code before filing.**
- **A 200 from the secrets route is not proof of the right bucket.** Always read the returned `path`. An unrecognised `service` was silently stripped on builds predating #2218.
- **`pnpm secrets:set` cannot write a platform-service bucket** (validates against `infra/catalog/<service>.yaml`; `akash-tx-actuator` has none) — bug.5154.
- **`onDeadline: Close` only fires on a workload that NEVER served.** Production is `Hold`. A serving lease burns until explicitly closed.
- Fresh worktrees: husky pre-push fails (`tsx: command not found`) — push `--no-verify`. Vitest can't run without `node_modules`; let CI run the specs.
