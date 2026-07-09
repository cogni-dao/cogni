---
name: node-to-candidate-a
description: "Take a Cogni node from NOT-deployed to live-and-validated on candidate-a, end to end, as a node-contributor agent — RBAC request → owner approve → env-membership verb (add candidate-a) → merge → Argo auto-reconcile → agent-api-validation. This is the cold-start runbook: a fresh agent with only its COGNI API key + a node id can follow it start to finish. Use when asked to 'get my node onto candidate-a', 'deploy node X to candidate-a', 'prove a node deploys e2e', 'add a node to the candidate environment', or to validate the env-membership verb against a real deployment. Distinct from node-setup (which BIRTHS a node into the registry — a prerequisite here) and from flighting/promoting a BUILD (candidate-flight / promote — which pick which image runs in an env you're already in). This picks the ENV itself, then proves the node actually deployed and answers."
---

# Node → candidate-a (the cold-start e2e)

Get a node **deployed on candidate-a and validated**, starting from nothing but your
COGNI API key + a node id. Env-membership answers _which environments a node is
deployed into_ — the `envs:` list in `infra/catalog/<slug>.yaml`. This skill drives the
full loop and proves the node actually came up.

**Prerequisite:** the node must already exist in the operator registry (a catalog row).
If it doesn't, form it first with [`node-setup`](../node-setup/SKILL.md), then return here.
The deep reference for the verb loop is [`manage-node-envs`](../manage-node-envs/SKILL.md);
this skill is the executable e2e that ends in a validated deployment.

## The mental model (read this first — it's the thing agents get wrong)

```
 you (env_manager on <node>)
   │  POST /nodes/<node>/envs {env:"candidate-a", present:true}
   ▼
 operator ──authors byte-exact catalog PR (4 files)──► operator monorepo PR
   │            catalog envs +env · overlay · appset · appsets/kustomization
   ▼   CI: unit(render --check drift) · format · static · manifest ···· GREEN ✅
 merge queue   ⛔ NOT automatic — you trigger it (POST /vcs/merge)
   │  squash → main
   ▼   ═════════ everything below is AUTOMATIC ═════════
 Argo keystone  cogni-candidate-a-appsets   (targetRevision:main, prune:true, selfHeal:true, ~1–3 min)
   │  new appset file on main → creates the node's Application
   ▼
 node's Application → PODS START  ✅ real deployment on the candidate-a cluster
```

**MERGE is gated (you trigger it, CI must be green). DEPLOY is automatic after merge**
(Argo continuously reconciles `main`). Do not hand-apply anything to the cluster — the
catalog is the only lever; manual `kubectl` is reverted by the appset's selfHeal.

## Step 0 — auth (agent bearer)

```bash
BASE=https://cognidao.org            # operator that owns the node's registry
# candidate/test-org nodes live on the CANDIDATE operator: BASE=https://test.cognidao.org
API_KEY=<your COGNI key>             # or register: POST $BASE/api/v1/agent/register {name}
ID=<node id or slug>                 # e.g. "anotha"
```

## Step 1 — request `env_manager` (the ONLY grant path is request → owner-approve)

`env_manager` → `can_manage_envs` is a distinct least-privilege role (NOT `developer`/
`can_flight`). Requesting the wrong role and getting `403` is the classic trap.

```bash
curl -sS -X POST "$BASE/api/v1/nodes/$ID/access-requests" \
  -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d '{"role":"env_manager"}'      # → {status:"pending", agentUserId:"<you>"}
```

## Step 2 — BLOCK for the owner's approval (you cannot self-serve)

The node **owner** approves from their session — this is the trust boundary; there is no
other door. Never write OpenFGA tuples, self-approve, or reach for kube.

```
Owner runs: POST /api/v1/nodes/$ID/developers {agentUserId:"<you>", decision:"approve", role:"env_manager"}
```

Surface the pending request to the owner and **wait**. Proof the grant landed: step 3
flips from `403 authz_denied` to `200`.

## Step 3 — confirm authz + add candidate-a

The verb is **idempotent**: adding an env the node already has returns `no_changes` (no
PR). Use that as your authz probe, then the real add.

```bash
# authz probe (a member env → no_changes = authz PASSED; 403 = go back to step 1/2)
curl -sS -X POST "$BASE/api/v1/nodes/$ID/envs" -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' -d '{"env":"preview","present":true}'

# the add → opens the catalog PR
curl -sS -X POST "$BASE/api/v1/nodes/$ID/envs" -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' -d '{"env":"candidate-a","present":true}'
# → {result:{status:"pr_opened", action:"add", prNumber:N, prUrl:...}}
# (already on candidate-a? → no_changes. Remove first, or pick a node that isn't.)
```

The PR touches exactly 4 files (byte-identical to the bash renderers): catalog `envs:`,
`overlays/candidate-a/<slug>/kustomization.yaml`, `appsets/candidate-a/candidate-a-<slug>-applicationset.yaml`,
`appsets/candidate-a/kustomization.yaml`.

## Step 4 — merge the PR (it enqueues; poll to MERGED)

```bash
curl -sS -X POST "$BASE/api/v1/vcs/merge" -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' -d "{\"nodeId\":\"$ID\",\"prNumber\":N}"
# 200 = QUEUED, not merged. Poll: gh pr view N --repo <owner/repo> --json state (→ MERGED)
```

The PR must be CI-green first. **Known gotcha (bug.5073, fixed):** older operator builds'
verb stripped the catalog trailing newline → prettier format-check fails → the whole `unit`
job (incl. the drift gates) is skipped and the PR is unmergeable. If you hit a lone
`No newline at end of file` on the catalog yaml, the operator predates the fix — patch the
trailing newline on the PR branch to unblock (and flag it).

## Step 5 — the deploy is automatic; verify it actually happened

Do NOT trust the merge alone. Within ~1–3 min the keystone `cogni-candidate-a-appsets`
reconciles `main` and creates the node's Application. Verify on three axes:

- **Argo/cluster:** the `cogni-candidate-a-<slug>` Application appears and goes `Healthy`
  (read-only SSH is allowed on candidate-a; never write).
- **Endpoint:** `curl https://<slug>-test.cognidao.org/version` returns (node is up).
- **Loki:** `{namespace="cogni-candidate-a"} |~ "<slug>" |~ "reconcile"` shows the verb's
  `dns.forward_reconcile.skipped {slug:"<slug>", env:"candidate-a"}` — proves your call
  reached the operator. Use `scripts/loki-query.sh '<logql>' <mins> <limit>` (export
  `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` inline).

## Step 6 — agent-api-validation (the terminal proof)

Exercise the now-live node per [`docs/guides/agent-api-validation.md`](../../../docs/guides/agent-api-validation.md):
discover → register → invoke a real route against `https://<slug>-test.cognidao.org`.
Then post the scorecard via [`validate-candidate`](../validate-candidate/SKILL.md) (it owns
the matrix + Loki-evidence format). That posted scorecard is your definition of done.

## Invariants (the load-bearing rules)

- **REQUEST_THEN_OWNER_APPROVE_ONLY** — the sole path to `env_manager`. No tuples, no
  self-approve, no kube. Block and wait when unauthorized.
- **CATALOG_IS_SSOT** — the verb edits the operator monorepo catalog/overlays/appsets and
  nothing else; manual cluster edits are reverted by selfHeal.
- **MERGE_GATED_DEPLOY_AUTO** — you trigger the (CI-gated) merge; Argo does the deploy.
- **ATOMIC_PER_ENV / IDEMPOTENT** — every env is an independent toggle; the already-holding
  state returns `no_changes` and opens no PR.
- **VERIFY_THE_DEPLOY** — a merged PR is not a deployed node. Confirm Application + endpoint
  + Loki before claiming done.

## Proven

candidate-a operator `8c37795a`, node `anotha`, 2026-07-09: RBAC `403→200`, byte-exact
4-file PR (cogni-test-org/cogni-monorepo#48), `render --check` drift gates green (verb ==
bash renderers), `dns.reverse_reconcile.skipped` in Loki, idempotent `no_changes`. Bug
found + fixed on the way: bug.5073 (trailing-newline strip).
