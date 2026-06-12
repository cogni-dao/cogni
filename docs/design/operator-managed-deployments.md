---
id: operator-managed-deployments
type: design
title: "Operator-Managed Deployments — how the operator app runs the node network (human-simple)"
status: draft
spec_refs:
  - spec.cicd-platform-boundary
  - ci-cd-spec
  - spec.mcp-control-plane
work_items: []
created: 2026-06-11
---

# Operator-Managed Deployments

> How does the operator app actually manage deployments? Picture version. No jargon.

## The one idea

The operator app does **not** SSH into machines or run scripts. It does two boring things:

1. **READ** the cluster's current state (which node is live where, at what version, healthy?).
2. **WRITE** intent to git (deploy this / remove that). **Argo CD** — already running — notices the git change and makes the cluster match.

That's it. Git is the steering wheel; Argo is the engine; the operator app is the dashboard + the hands on the wheel.

```
        ┌────────────────────── OPERATOR APP (.ts) ──────────────────────┐
        │   node/[id] page  =  the deployment console                    │
        │                                                                 │
        │   "blue is live on:  candidate-a ✓   preview ✓   prod ✗"        │
        │   [ deploy to preview ]   [ remove from candidate-a ]           │
        └───────────────┬─────────────────────────────┬──────────────────┘
                        │ READ                         │ WRITE (intent)
                        ▼                              ▼
              DeployCapability.getDeployState   DeployCapability.deployNode / removeNode
                        │                              │
                        ▼                              ▼
              reads Argo + k8s API           commits to  deploy/<env>-<node>  (or catalog node-set)
              (in-cluster, read-only)          via the GitHub App (same auth as flight today)
                        │                              │
                        ▼                              ▼
        ┌──────────────────────────  THE CLUSTER  ───────────────────────┐
        │   Argo CD watches git ───► reconciles ───► pods match git       │
        └─────────────────────────────────────────────────────────────────┘
```

## A day in the life — three flows

### 1. SEE — "where is blue running?"

```
You open  node/blue  →  page calls DeployCapability.getDeployState(env, "blue") for each env
                     →  adapter reads Argo Application + Deployment status (in-cluster)
                     →  page shows:  candidate-a  sha 1a2b3c  ✓ healthy  1/1
                                     preview      sha 1a2b3c  ✓ healthy  1/1
                                     production   —          not deployed
```

No SSH. The operator pod runs **inside** the cluster, so it just asks the k8s/Argo API.

### 2. DEPLOY — "ship blue to preview"

```
You click [deploy to preview]
   → DeployCapability.deployNode({ env: "preview", node: "blue", sourceSha })
   → wraps the EXISTING flight path (VcsCapability.dispatchCandidateFlight) — no new pipeline
   → Argo reconciles → pods roll → page flips to ✓ when /version.buildSha matches
```

The operator never invents a second deploy path. "Deploy" = the same promote-by-digest flow CI uses today, just triggered from a button + typed code instead of a `workflow_dispatch` by hand.

### 3. REMOVE — "take blue off candidate-a" (your ask)

```
You click [remove from candidate-a]  (confirm + authz check)
   → drop "blue" from candidate-a's catalog node-set  (deploy ⊆ provisioned, #1607)
   → its per-env AppSet/overlay stop rendering
   → Argo PRUNES the pods.  Reversible: re-add the env to redeploy.
```

Removal is a **clean GitOps delete**, not a hack — Argo's prune does the teardown. This is the per-node "off switch" you wanted, living right on the node page next to the env list.

## The auth question — "does the test operator need VPS auth?"

**No VPS. No SSH keys.** Reads and writes use two auths the platform already has:

| Operation                                      | What it needs                                                                                 | Why not VPS/SSH                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **READ** cluster state (`getDeployState`)      | an **in-cluster k8s ServiceAccount** with read-only RBAC on Argo `Application` + `Deployment` | the operator pod runs _inside_ candidate-a's k3s — it asks the local API; no network hop, no SSH key to leak     |
| **WRITE** intent (`deployNode` / `removeNode`) | the **existing GitHub App** (same creds as flight today)                                      | writes go to a **git** branch / catalog, not to a machine — Argo pulls the change. Git is the only write surface |

So the only _new_ grant is a **read-only k8s ServiceAccount token** mounted into the operator pod (a 1-file RBAC manifest + the adapter using the in-cluster config). That replaces the CI scripts' SSH-and-kubectl with an in-cluster, least-privilege read. The dangerous write path (SSH + `kubectl apply` in `deploy-infra.sh`) is **not** reused — writes stay in git.

> This is also why it's safe: a compromised operator read-token can _look_ but not _touch_; touching requires a reviewable git commit through the GitHub App.

## What exists vs what's next (honest)

| Piece                                               | State                                                       |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `DeployCapability` interface (read-only v0)         | ✅ shipped (`packages/ai-tools/src/capabilities/deploy.ts`) |
| `ArgoDeployAdapter` (reads Argo via in-cluster SA)  | ❌ next PR — the only real work for the SEE flow            |
| Read-only k8s ServiceAccount + RBAC manifest        | ❌ next PR (1 file)                                         |
| `<NodeDeployments>` section on `node/[id]`          | ❌ next PR — mirrors the existing `<NodeAccess>` section    |
| `deployNode` / `removeNode` (control verbs) + authz | ⏳ Phase 1 — after the read view proves out                 |
| `ComputeResourcePort` (Cherry→Akash, crypto-pay)    | ⏳ deferred until Akash funded                              |

**Smallest next PR = the SEE flow**: ServiceAccount + `ArgoDeployAdapter` + the read-only panel on `node/[id]`. That is the first thing actually _visible_ on candidate-a — the operator app showing, in its own UI, which envs a node is deployed to.

## Related

- [CI/CD Platform Boundary & Freeze Policy](../spec/cicd-platform-boundary.md) — the policy + the `DeployCapability` / `ComputeResourcePort` design this realizes.
- [CI/CD Spec](../spec/ci-cd.md) — Axioms 4/6 (build-once-promote-digest, Argo owns reconciliation) that make git-as-steering-wheel work.
- [MCP Control Plane](../spec/mcp-control-plane.md) — the same Port + registry + adapter-swap pattern, for MCP servers.
