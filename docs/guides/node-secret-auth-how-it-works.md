---
id: node-secret-auth-how-it-works
type: guide
title: "Node Self-Serve Secrets — How the Auth Works + the Path to Functioning"
status: draft
trust: draft
summary: "AI-facing guide: how a node-owner's secret write actually authenticates today (per-env, sealed), why it is a sibling of the deploy port, why the CATALOG (not the nodes DB) is the env-aware node model, and the concrete sequenced path to a functioning multi-env version."
read_when: "Working on node self-serve secrets, asking why a secret write 503s/403s/409s on an env, or aligning the secrets plane with the operator deploy port."
owner: derekg1729
created: 2026-06-19
verified:
spec_refs:
  - ../design/node-self-serve-secrets.md
  - ../spec/cicd-platform-boundary.md
tags: [secrets, operator, control-plane, rbac, openbao]
---

# Node Self-Serve Secrets — How the Auth Works

> Canonical detail lives in [`design/node-self-serve-secrets.md`](../design/node-self-serve-secrets.md).
> This guide is the clear operational mental model. The HTML visual (`dolt-human-visuals`) is the catchy face; this is the AI-readable truth.

## 1. The one-paragraph model

There is **no single operator that writes all envs.** Each environment
(candidate-a · preview · production) runs its **own** operator pod, and each pod
can write **only its own env's** OpenBao. A node-owner holding only an API key
calls the operator that serves the env they want; that operator authorizes them
(OpenFGA), confirms the env (D1), then writes the value using **its own
in-cluster identity**. The caller never holds a kube or vault credential.

## 2. The auth chain (verified, candidate-a today)

```
dev (API key)
  → POST <env-operator>/api/v1/nodes/<id>/secrets { env, key, value }
  → [perimeter bearer auth]
  → GATE 1  OpenFGA: node.manage_secrets @ node:<id>   (503 if no store · 403 if not allowed)
  → GATE 2  env-match (D1): requestedEnv == operator's own DEPLOY_ENVIRONMENT  (409 otherwise)
  → GATE 3  key denylist: substrate-managed source:agent keys → 403 key_reserved
  → adapter self-login:
        read projected SA token  (SA operator-secrets-writer @ cogni-<env>, audience=cogni-openbao)
        POST openbao/v1/auth/kubernetes/login { role: <env>-node-secrets-writer, jwt }
        → short-lived OpenBao client token, policy = cogni/<env>/*  (DENY _system/* + _shared/*)
  → KV-v2 write  cogni/<env>/<node-slug>/<KEY>   (put new path · merge-patch existing)
  → ESO syncs → k8s Secret → Reloader rolls the node pod
```

**Two seals, two layers:**

- **Env seal = OpenBao policy.** `cogni/<env>/*`. The candidate-a operator's token
  _physically cannot_ reach `cogni/production/*`. Cross-env is impossible by
  construction — not merely by app logic.
- **Node seal = OpenFGA + path.** The policy is env-**wide** (any node in the env);
  the specific node is bounded by the `node.manage_secrets` check + the
  operator-stamped `<node-slug>` in the path. OpenBao does not know about nodes.

## 3. What's built vs. gap (be honest about each env)

| Env         | OpenBao writer role                           | Operator env-var + token                    | Self-serve write            |
| ----------- | --------------------------------------------- | ------------------------------------------- | --------------------------- |
| candidate-a | ✅ provisioned (`reconcile-env-substrate.sh`) | ✅ wired                                    | ✅ works (auth-wise)        |
| preview     | 🟡 reconcile runs, unverified                 | 🟡 unverified                               | 🟡 likely, untested         |
| production  | 🔴 role not provisioned (`bug.5007`)          | 🔴 `OPENBAO_NODE_SECRETS_WRITER_ROLE` unset | 🔴 **503** — factory throws |

`createOperatorSecretsPlane` throws → **503** when the writer role env-var is
unset; its message says _"candidate-a only today."_ So **prod needs provisioning**
before any of this works there: run the `production-node-secrets-writer`
role+policy on prod's OpenBao **and** wire the operator overlay's projected-token
volume + env-var. That is a discrete substrate task tied to `bug.5007`.

## 4. Why it's a sibling of the deploy port

This is the **secrets row of the typed operator control plane**
([`cicd-platform-boundary.md` §"The next layer"](../spec/cicd-platform-boundary.md)).
Same shape as deploy:

| Concern       | Port                                                     | Node resolved | Env               | Authz                 | Dev holds |
| ------------- | -------------------------------------------------------- | ------------- | ----------------- | --------------------- | --------- |
| deploy READ   | `DeployCapability.getDeployState({env,node})`            | once          | param             | —                     | nothing   |
| deploy WRITE  | `OperatorDeployPlanePort.dispatchNodePromote({env})`     | once          | param             | `node.promote_*`      | nothing   |
| secrets WRITE | `OperatorSecretsPlanePort.writeSecret({nodeId,env,...})` | once          | **param (D1 ✅)** | `node.manage_secrets` | nothing   |

Difference: deploy reaches other envs **declaratively** (git → Argo, "look but not
touch"). A secret **value** can't ride git/dispatch (plaintext), so cross-env
secrets are the one op that needs a live custodial channel — built later as a
swappable adapter (D4), or simply: the dev calls the env that serves their target.

## 5. The env-aware node model = the CATALOG, not the `nodes` DB

`bug.5038` instinct, made precise: an operator must be **aware of which nodes are
deployed in which env**. That awareness already exists — and it is **not** the
per-env `nodes` Postgres table (that is wizard-spawn state). It is:

- **`infra/catalog/<node>.yaml`** — `CATALOG_IS_SSOT` (Axiom 16). **One row per
  node, env-aware** (`envs: [candidate-a, preview, production]`). This is the
  single env-aware node identity the deploy port already uses
  (`listCatalogForkTargets`, `dispatchNodePromote`).
- **`DeployCapability.getDeployState({env,node})`** — live Argo read: is the node
  _actually running_ in that env right now.

**Misalignment to fix:** D1 resolves the node via `resolveNodeRegistry()` (the
per-env `nodes` DB + static). To match the deploy port, the secrets plane should
resolve identity + env-presence from the **catalog** (build-time typed module —
the runtime image carries no catalog, same `#1479` codegen pattern as the A2
allowlist) composed with `getDeployState`. One env-aware record, two existing
primitives, zero new DB.

## 6. The path to a functioning version (sequenced, no skeleton key)

1. **Prod provisioning** (`bug.5007`) — run `production-node-secrets-writer`
   role+policy + wire the overlay. _Makes auth work beyond candidate-a._ **Highest
   leverage: nothing else matters until an env can actually write.**
2. **Catalog-aligned resolution** — resolve the node from the catalog
   (env-aware) + `DeployCapability`, replacing the `nodes`-DB read. _Aligns the
   operator's node-awareness with the deploy port; one env-aware record._
3. **Per-env grant reachability** — the owner's `node.manage_secrets` grant must
   exist in the target env's OpenFGA store (the deploy port's flight-triangle, one
   rung over). Mirror the `production_promoter` split for prod
   (`node.manage_secrets_production`) so a test grant can never write prod.
4. **Cross-env convenience (optional, deferred)** — `targetEnv` from one host via
   a scoped/signed/target-verified `(node,env,key)` capability. Not required for
   "functioning": a dev calling the env that serves their target already works.

**Functioning MVP = steps 1–3.** Step 1 unblocks the substrate; step 2 aligns the
model with the deploy port; step 3 lets a real node-owner be authorized per env.
Step 4 is sugar.
