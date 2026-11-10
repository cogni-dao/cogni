# story.5039 — the env verb. Reproducible e2e, not another hand-written PR.

> **LANE COLLISION WARNING — READ FIRST.** Another agent is live on **task.5132**
> (the poly mint): `candidate-flight.yml`, `promote-and-deploy.yml`, `infra/catalog/*`,
> Argo/AppSet artifacts, and an in-progress **paid Akash lease**. Do not touch any of
> it. Your lane is the operator TypeScript env-verb path only.
>
> `owner` is UNSET on every work item and is **not settable through the API**, so
> nothing in the system will warn you about this. Coordinate by item + this file.

Work in your own worktree:

```bash
git worktree add -b <you>/story-5039-env-verb ../story5039 origin/main
```

Claim `story.5039`; write the ordered DoD into `outcome` before you act.

## The outcome

`POST /api/v1/nodes/{node}/envs {env, present:true}` turns an environment ON for
**any** node; `{present:false}` turns it OFF **and closes the paid lease**. Zero
hand-written files. Both halves are missing today.

## Read first — do not re-derive

| what | where |
| --- | --- |
| who pays (NS1–4) + the acceptance bar | Dolt `akash-actuator-wallet-cutover` |
| V0 scope + the as-built parity gaps | Dolt `akash-cicd-pareto-scope` |
| why first runs break | Dolt `unexecuted-lane-untested` |
| the path convention | `scripts/ci/lib/appset-paths.sh` → `control_env_for` |

The bar is already written, in `akash-actuator-wallet-cutover`:

> a node owner performs the action through the operator's own surface, holding only
> their normal grants, and it works end to end. No agent, no curl, no cluster access.

and its corollary — the thing you are fixing:

> **A verb that succeeds and does nothing is BROKEN.**

## Your acceptance test already exists

**PR #2301** hand-wrote poly's `candidate-a` + `preview` activation. It was an explicit
bypass. **You are done when the verb emits that exact diff.**

Four artifacts. What `planAdd` produces today:

| artifact | today |
| --- | --- |
| 3 placement cells per env (`deployment_provider`, `compute_api`, `lease_generation`) | ❌ none — and absence silently selects the deprecated k3s lane |
| AppSet under the **reconciling cluster's** dir (`appsets/production/` for an akash non-prod lane) | ❌ writes `appsets/<env>/` (bug.5204) |
| `infra/k8s/overlays/<env>/<node>/*` | ✅ works |
| scheduler endpoint patch | ❌ only `buildPlacementPlan` emits it |

```
gens/env-membership-plan.ts                  :96 :100
gens/appset.ts                               :104 :133
adapters/server/vcs/github-repo-write.ts     :347 :4221
features/compute/node-deployment-provider.ts (add controlEnvFor here)
```

## Half 1 — ON. Ships **with** bug.5204, not after it.

Same four files. The path fix **alone is provably dead code**: with no placement cells,
control env always equals env, so the resolver never fires.

Reuse, don't invent — put `controlEnvFor({catalog, environment})` beside
`resolveNodeDeploymentProvider`; it already parses `deployment_provider` with the same
default rule. It is the TS twin of `control_env_for`. **One rule, two runtimes.**

**PR #2304 is your gate.** Red on main by design; it enumerates every consumer still
building the path from the env. Green = your sweep is done. Do not re-grep and judge —
run the gate. *"I grepped and think I got them all"* is the assumption that caused the
defect.

Also fix that `present` and `placement` are mutually exclusive today — that makes a
"one call" verb really ≥2 PRs, and the DoD unreachable.

## Half 2 — OFF. Load-bearing, and entirely unbuilt.

`present:false` reverses **git only**. Nothing closes the Akash lease. Two proven
failure modes: **bug.5189** (deleting a controller orphaned live leases behind its
finalizers) and **bug.5190** (a git purge left live ExternalSecrets).

**Missing primitive, build it first:** the ledger port has `listStalePreparing` for
wedged receipts but **nothing lists ALLOCATED receipts** — so an orphaned paid lease
whose `(node, env)` the catalog no longer declares is *undetectable*. Without it every
activation is a one-way door and spend never stops.

> a stuck namespace is recoverable, an orphaned paid lease is not

Close the lease and **prove it closed against the Console account** before clearing any
finalizer. A workload's status field freezes the moment its controller dies, and
deleting Kubernetes objects is not proof the money stopped.

## Done

1. The verb emits the #2301 diff. Byte-compare.
2. **A second node activates via the identical call with zero edits.** One node working
   is not a platform feature.
3. One env deactivates, lease **proven closed** against the Console account.
4. #2304 green; #2302 merged.
5. Zero leases on the **test** Console account for any `cogni-dao` node (NS3/NS4).

## Traps

- **Never hand-write a catalog row to unblock yourself.** That is #2301 — repeating it
  deletes the reason this item exists.
- **Never fix the AppSet path without the cells.** Dead code, two passes.
- **A green check is not proof.** `/version.buildSha` from outside the cluster, plus
  `/readyz?deep=1` for substrate — `deep=1` is what makes substrate failures fatal. A
  node can serve `/version` with no database.
- This lane has **never executed**. Budget first-run defects as a phase: the last new
  lane produced 5 in a row; 2026-09-16 produced 10, none caught by CI.

## Bookkeeping

`bug.5204` folds into this item. `story.5040` holds the three fail-loud asserts —
#2296 shipped one, #2302 and #2304 are the other two and are unmerged. Plan + status on
the work item; durable *why* in Dolt; never a doc that rots.
