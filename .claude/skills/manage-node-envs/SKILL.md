---
name: manage-node-envs
description: "Manage which deploy-environments a Cogni node lives in (candidate-a / preview / production) via the operator app — the full request→owner-approve→verb→merge→verify loop for env (deploy-topology) membership. Use whenever an agent needs to add a node to an env or remove it from one, is asked to 'give this node a preview deploy', 'promote this node into production topology', 'take a node out of preview', 'stop deploying X to candidate-a', 'change a node's deploy reach / env set', 'onboard my node to an environment', or hits a 403 authz_denied / 503 authz_unavailable on POST /api/v1/nodes/{id}/envs. Also triggers on 'env_manager', 'can_manage_envs', 'env-membership PR', 'node deploy topology', 'catalog envs: line'. This is distinct from FLIGHTING a build (candidate-flight / can_flight) and from PROMOTING a sha (promote / can_promote_production) — env-membership changes WHERE a node is deployed, not WHICH build runs there. Do NOT use for provisioning a whole environment (that is provision-env), for secret-writes (cicd-secrets-expert), or for image promotion (promote)."
---

# Manage node env membership

Add or remove ONE deploy-environment from a Cogni node's reach, through the operator
app. "Env membership" answers _which environments a node is deployed into_ — the
`envs:` list in the node's catalog row. It is deliberately separate from flighting a
build and from promoting a sha: flighting picks the build that runs in an env you're
already in; env-membership picks the envs themselves.

The whole loop is three operator API calls plus one wait-on-a-human step:

1. **Request** the `env_manager` role (agent bearer).
2. **Block** until the node OWNER approves it. You cannot skip or self-serve this.
3. **Call the verb** (`POST .../envs`) — opens a catalog-edit PR.
4. **Merge** that PR (`POST /api/v1/vcs/merge`) — enqueues; poll to `MERGED`.
5. **Verify** the per-env keystone app-of-apps reconciled the node in/out.

## When to use

- "Give node X a preview deployment" / "add X to production" / "deploy X to candidate-a".
- "Take X out of preview" / "stop deploying X to production" / "shrink X's env set".
- You called `POST /api/v1/nodes/{id}/envs` and got `403 authz_denied` (you lack the
  role) or `503 authz_unavailable` (the env's OpenFGA model lacks the relation).
- Someone asks to change a node's "deploy reach", "deploy topology", or the catalog
  `envs:` line.

Not this skill: standing up a brand-new environment (→ `provision-env`), writing a
node secret (→ `cicd-secrets-expert`), or moving a build/sha (→ `promote`).

## A) Get the permission — request → OWNER approves (the ONLY grant path)

Managing a node's env topology is gated on `can_manage_envs`, which is computed from
the `env_manager` OpenFGA role (and is also implied by `admin`). `env_manager` is a
_distinct, least-privilege_ scope — it is NOT `developer`(→`can_flight`) and NOT
`production_promoter`(→`can_promote_production`). Requesting `developer` and expecting
to change envs is the classic trap; the right answer to the wrong role is `403`.

**Request** (agent bearer, your registered principal):

```
POST /api/v1/nodes/{id}/access-requests
{ "role": "env_manager" }
```

This writes a tracking row only — OpenFGA tuples remain the authority, so the request
alone grants nothing.

**Approve** — done by the node OWNER, from a browser session:

```
POST /api/v1/nodes/{id}/developers
{ "agentUserId": "<your-user-id>", "decision": "approve", "role": "env_manager" }
```

This route is RLS-owner-gated (`nodes.ownerUserId == session.id`) — the DB query only
returns the node when the caller _is_ its owner — and it writes the role tuple via
`authorization.writeRelation`. So **only the owner can approve**, and approval is what
actually flips `can_manage_envs` on for you.

### HARD RULE — block and wait for the owner

The ONLY legitimate way to obtain `env_manager` is **request → owner-approve**. There
is no other door, by design (this is what keeps deploy-topology under node-owner
governance):

- Never write OpenFGA tuples directly.
- Never self-approve or approve on the owner's behalf.
- Never reach for kube / OpenBao / any privileged plane to "just grant it".

If you don't yet hold `can_manage_envs`, your correct move is to **stop and wait** for
the owner to approve — surface the pending request to them and block. Do not try to
route around the approval; there is nothing to route around, and attempting it is the
anti-pattern this skill exists to prevent.

## B) Use the verb

Once you hold `can_manage_envs`:

```
POST /api/v1/nodes/{id}/envs
{ "env": "candidate-a" | "preview" | "production", "present": true | false }
```

- `present: true` adds the env; `present: false` removes it.
- **Idempotent:** requesting the state that already holds returns
  `{ ... result: { kind: "no_changes" } }` and opens **no PR**. Adding an env the node
  already has, or removing one it doesn't, is a safe no-op — lean on this instead of
  pre-checking.
- Auth: `503 authz_unavailable` means the env's OpenFGA model doesn't carry the
  `can_manage_envs` relation yet (model drift — the env needs a re-bootstrap, not a
  retry); `403 authz_denied` means you simply aren't granted (go back to §A).

**What it does:** opens a catalog-edit PR on the OPERATOR monorepo — never the node's
own repo. The PR is **byte-identical to what formation / the bash renderers produce**,
touching exactly:

- `infra/catalog/<slug>.yaml` — the `envs:` line.
- `infra/k8s/overlays/<env>/<slug>/kustomization.yaml` — the per-env overlay
  (added on add, deleted on remove).
- `infra/k8s/argocd/appsets/<env>/<env>-<slug>-applicationset.yaml` — the node's
  per-(env,slug) ApplicationSet (added on add, deleted on remove).
- `infra/k8s/argocd/appsets/<env>/kustomization.yaml` — the env's appsets list the
  slug folds into / out of.

### Every env is an INDEPENDENT, atomic toggle (ATOMIC_PER_ENV)

There is **no special-casing of `candidate-a`**. candidate-a is toggled exactly like
preview and production — you can add or remove any single env on its own, in any order.
Removing the last remaining env leaves a valid empty `envs: []` row: the node is then
simply _deployed nowhere_, but its catalog row (plus per-node, env-independent Caddy /
scheduler entries) is left intact. So "remove from preview" and "remove from
candidate-a" are the same kind of operation — one atomic per-env delta each. (If you
recall an older "you can't drop candidate-a while in preview/prod" rule, that
constraint was removed; the code is atomic-per-env now.)

## C) Merge the generated PR

The verb only _opens_ a PR — the node doesn't move until it merges.

```
POST /api/v1/vcs/merge
{ "nodeId": "<id-or-slug>", "prNumber": <n> }
```

- Auth reuses `can_flight` (a deliberate least-privilege MVP concession — the merge
  seam is one node-authz check; see the route's `NODE_SCOPED` note). `nodeId` is
  required and addresses the node whose PR this is; the operator's own monorepo PRs are
  addressed as `nodeId: "operator"`.
- **It ENQUEUES.** When the base branch requires a merge queue, `mergePr` returns
  `{ enqueued: true }` with no `sha` — the merge completes asynchronously on the rebased
  candidate. Treat a successful response as "queued", then **poll the PR until it reads
  `MERGED`** (e.g. `gh pr view <n> --json state,mergedAt`). Do not assume merged on the 200.

## D) Verify the reconcile

Merging changes git; the node actually appears/disappears when Argo reconciles. On
merge to `main`, the per-env **keystone app-of-apps** `cogni-<env>-appsets`
(`prune: true` + `selfHeal: true`, `targetRevision: main`, path
`infra/k8s/argocd/appsets/<env>`) picks up the change:

- **Add:** the new `<env>-<slug>-applicationset.yaml` appears in git → the keystone
  syncs → the node's ApplicationSet (and its Application) is created in that env.
- **Remove:** the file vanishes from git → `prune: true` deletes the node's
  Application → the node stops being deployed there.

That reconcile is the ground truth that the node moved. Confirm via Argo (the
`cogni-<env>-<slug>` Application appears / is gone) rather than trusting the PR merge
alone.

**Observability:** the verb emits a DNS-seam log in Loki, slug+env scoped:
`dns.forward_reconcile.skipped` on add, `dns.reverse_reconcile.skipped` on remove
(v0 only logs the intended Cloudflare change — the per-node A record is upserted at
provision / lingers to TTL; the live reconcile is a flagged vNext seam).

## Runbook

1. **Request the role:** `POST /api/v1/nodes/{id}/access-requests { "role": "env_manager" }`.
2. **Block for approval:** stop and wait for the node OWNER to
   `POST /api/v1/nodes/{id}/developers { agentUserId, decision:"approve", role:"env_manager" }`.
   Do not proceed, and do not attempt any other grant path, until this returns success.
3. **Call the verb:** `POST /api/v1/nodes/{id}/envs { env, present }`. A `no_changes`
   result means you're already in the target state — done, no PR.
4. **Merge the PR:** `POST /api/v1/vcs/merge { nodeId, prNumber }`, then poll the PR to
   `MERGED` (it enqueues; the 200 is "queued", not "merged").
5. **Verify reconcile:** confirm the keystone `cogni-<env>-appsets` created / pruned the
   node's `cogni-<env>-<slug>` Application in Argo; check the `dns.*_reconcile.skipped`
   Loki line for your slug+env.

## Invariants — the load-bearing rules

- **REQUEST_THEN_OWNER_APPROVE_ONLY** — the sole path to `env_manager` is request →
  owner-approve. No direct tuples, no self-approve, no kube/OpenBao grant. Block and
  wait when unauthorized.
- **DISTINCT_SCOPE** — `env_manager`→`can_manage_envs` is its own least-privilege role,
  separate from `developer`/`can_flight` and `production_promoter`/`can_promote_production`
  (all also implied by `admin`).
- **CATALOG_IS_SSOT** — the verb edits the operator monorepo catalog/overlays/appsets;
  it never touches the node's own repo and never bypasses git.
- **ATOMIC_PER_ENV** — every env (candidate-a included) is an independent toggle;
  removing the last env yields a valid `envs: []`. No candidate-a special case.
- **IDEMPOTENT** — the already-holding state returns `no_changes` and opens no PR.
- **MERGE_ENQUEUES** — `vcs/merge` returns `enqueued`; poll to `MERGED`. The node moves
  only after the keystone app-of-apps reconciles, not on PR merge alone.
