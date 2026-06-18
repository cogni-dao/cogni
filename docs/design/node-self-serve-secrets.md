---
id: design.node-self-serve-secrets
type: design
title: "Node Self-Serve Secret Values — operator-mediated, OpenFGA-authorized"
status: draft
created: 2026-06-10
skills:
  - ../../.claude/skills/git-app-expert/SKILL.md
  - ../../.claude/skills/rbac-expert/SKILL.md
  - ../../.claude/skills/cicd-secrets-expert/SKILL.md
spec_refs:
  - ../spec/node-baas-architecture.md
  - ../spec/secrets-management.md
  - ../spec/secrets-classification.md
  - ../spec/node-ci-cd-contract.md
related:
  - ./node-wizard-secret-setting.md
  - ./secrets-catalog-per-node.md
implements:
  - spike.node-self-serve-secrets
---

# Node Self-Serve Secret Values

## Decision

A node-owner granted OpenFGA `developer` on their node sets or rotates a secret
**value** (`cogni/<env>/<node>/<KEY>`) through the operator, authorized by an
OpenFGA `check`, written by the operator pod's **own** in-cluster credential. The
caller holds only an API key — never a kubeconfig, never the OpenBao writer JWT.

This is the **value-write** complement to two shipped pieces:
[`node-wizard-secret-setting.md`](./node-wizard-secret-setting.md) (wizard emits
secret _shape_) and [`secrets-catalog-per-node.md`](./secrets-catalog-per-node.md)
(the per-node catalog declares shape for typed consumption + ESO fan-out — it is
**not** a write-gate). A node owns its whole `cogni/<env>/<node>/*` namespace; the
RBAC grant, not a key list, is the boundary. It mirrors the **flight triangle**
(`developer → can_flight` → operator-held GitHub App creds → dispatch) one rung
over: `secrets_manager → can_manage_secrets` → operator-held OpenBao writer → write.

> **Scope discipline (freeze-aware).** The only CI/CD-plane change is one
> _additive_ substrate role-binding block (§Phase 1.B). Everything else is
> operator-app code on the normal app cadence. No existing role, policy, or
> workflow is modified. Resist scope creep: this design is the minimum that
> removes the human, not a secrets-management platform.

### North-star alignment

This is a direct fill-in of the BaaS substrate model
([`node-baas-architecture.md`](../spec/node-baas-architecture.md)), invariant
**"node declares shape; operator wires environment."** Three rows of its Substrate
Map are exactly this feature:

- **Secrets** — _node declares key names + consumers; operator provides OpenBao
  values, ESO manifests, **rotation path**._ The node already declares the key in
  `.cogni/secrets-catalog.yaml` (shape); this is the operator-provided path that
  finally lets the node-owner supply/rotate the **value** through the operator —
  not a human with a kubeconfig.
- **Authorization** — _authz checks + protected actions in app routes; shared
  OpenFGA store/model._ `can_manage_secrets` is that protected action.
- **Studio/Wizard** — _operator UI + validation._ This API route is the backend
  the operator Studio/agent both call; the human UI is a thin client over it.

The Supabase analogy is load-bearing for the **proof** too: you set a Supabase
secret in the dashboard and confirm it in the product, never by shelling into a
pod. Hence the observable is API-plane (§Closed loop), not `kubectl exec`.

## At a glance

```text
 NODE-OWNER  ── holds ONE thing: an API key. No kubeconfig. No vault token. ──┐
      │                                                                       │
      │  POST /api/v1/nodes/<id>/secrets   { key: "FOO", value: "s3cr3t" }    │
      ▼                                                                       │
 ┌──────────────── OPERATOR POD (one pod, serves EVERY node) ─────────────┐   │
 │ GATE 1  OpenFGA: is THIS caller a secrets_manager on node <id>?  ──────┼───┼─► OpenFGA store
 │ GATE 2  is FOO a substrate-reserved key? (denylist; new keys OK)        │   │  (per-node tuples)
 │ GATE 3  self-login with the POD's OWN k8s identity  ───────────────────┼───┼─► OpenBao
 │         bao kv patch  cogni/<env>/<id>/FOO = s3cr3t   (value on stdin) │   │
 └────────────────────────────────────────────────────────────────────────┘   │
      │  API response { written, version, path }  ──────────────────────────►  caller confirms
      ▼
 OpenBao  cogni/<env>/<id>/FOO   ◄── the value LIVES here (KV-v2, versioned)
      │  ESO pulls it (ESO's OWN read-only token)
      ▼
 k8s Secret  <id>-env-secrets  ──(Stakater Reloader auto-rolls the pod)──►  NODE POD: process.env.FOO ✅
```

**Who holds which key** (nobody holds a long-lived writer secret):

| Key                              | Lives                                                     | Held by               | Used when                         |
| -------------------------------- | --------------------------------------------------------- | --------------------- | --------------------------------- |
| OpenBao root + unseal keys       | `.local/<env>-openbao-init.json` (off-cluster)            | human / break-glass   | provision + emergencies only      |
| OpenBao policies + roles         | OpenBao config, written once at provision                 | —                     | set at provision (git-captured)   |
| `OPENFGA_API_TOKEN` (authz-root) | `cogni/<env>/operator/*` → ESO                            | the operator pod only | every authz check / tuple write   |
| operator's OpenBao identity      | projected SA token (`audience: cogni-openbao`, short TTL) | the operator pod only | minted per write, 1h scoped token |

Day-2 trust root = the **Kubernetes API server** (OpenBao validates projected SA
JWTs against it). "Who can write a secret" reduces to "which SA is bound in the
role" — controlled only by the provision script in git.

## Premise check (empirical — the human is load-bearing today)

The operator pod **cannot write OpenBao autonomously today.** Proven, not assumed:

- The `<env>-writer` OpenBao k8s-auth role binds only SAs `openbao-writer` +
  `openbao-operator` in the **`default`** namespace, with an env-wide policy
  `path "cogni/data/<env>/*" {read,create,update,patch}`
  (`scripts/setup/reconcile-env-substrate.sh:105-116`).
- The operator pod has **no** `serviceAccountName` (`infra/k8s/base/node-app/deployment.yaml`)
  and runs in `cogni-<env>` (`infra/k8s/overlays/candidate-a/operator/kustomization.yaml:6`),
  i.e. as `cogni-<env>/default` — a SA the writer role does not bind. A JWT from it
  fails the OpenBao namespace check (403) before policy is even evaluated.
- The existing writer path mints its token out-of-cluster:
  `ssh VM → kubectl create token openbao-operator -n default → bao write auth/kubernetes/login`
  (`scripts/ci/secret-materialize.sh:95-100`). That `kubectl create token` is the
  human's custody. The flight pattern proves the pod holds **GitHub App** creds and
  dispatches workflows; it does **not** prove the pod can mint a writer token or
  reach OpenBao.

**Net-new = a machine identity for the operator pod.** This is the irreducible
work; the rest is reuse.

## Reuse map

| Surface                                                                                                        | Verdict                       | Anchor                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| OpenFGA `check` call-site (`action`/`resource`/`context`, 503-vs-403)                                          | **reuse verbatim**            | `vcs/flight/route.ts:206-221`                                                  |
| `developer` grant loop (approve → `writeRelation` tuple)                                                       | **reuse — no new tuple/role** | `nodes/[id]/developers/route.ts:202-211`                                       |
| `relationForAuthzAction` SSOT + immutable-model auto-roll                                                      | **reuse**                     | `authorization-core/src/index.ts:115`, `bootstrap-openfga.sh:141-164`          |
| Capability/port + bootstrap factory + stub-on-non-operator                                                     | **reuse pattern**             | `bootstrap/capabilities/vcs.ts:61`, `operator-deploy-plane.ts:17`              |
| `wrapRouteHandlerWithLogging` + owner-gating + Loki events                                                     | **reuse pattern**             | `nodes/[id]/developers/route.ts`                                               |
| `set-secret.sh` guards (env enum, `_system` refusal, KEY regex, put-vs-patch)                                  | **reuse logic**               | `scripts/secrets/set-secret.sh:51-137`                                         |
| `openBaoPathFor()` path resolution                                                                             | **reuse**                     | `secrets-catalog-loader.ts:327-344`                                            |
| Per-node catalog = the allowlist                                                                               | **reuse as data**             | `infra/secrets-catalog.yaml` (A2 entries)                                      |
| ExternalSecret + Reloader closed loop (cluster-wide, opt-in, already on node-app)                              | **reuse — already live**      | `infra/k8s/argocd/reloader/values.yaml`, `base/node-app/deployment.yaml:15-20` |
| **Operator-pod OpenBao machine identity**                                                                      | **NET-NEW**                   | —                                                                              |
| `SecretsCapability` + `OpenBaoSecretsAdapter`                                                                  | **NET-NEW**                   | —                                                                              |
| `node.manage_secrets` action + `can_manage_secrets` relation                                                   | **NET-NEW (tiny)**            | —                                                                              |
| Catalog-membership + path-scope + tier guard (build-time-codegen'd allowlist; runtime image lacks the catalog) | **NET-NEW**                   | #1479 typed-module codegen pattern                                             |
| `POST /api/v1/nodes/[id]/secrets` route                                                                        | **NET-NEW**                   | —                                                                              |

## Phase 1 — the irreducible minimum

### A. OpenFGA delta (operator-app + model JSON; auto-rolls)

1. `infra/openfga/rbac-model.json`, `node` type — add a sibling of `can_flight`,
   **no `metadata` block** (computed relations take no direct assignment):
   ```json
   "can_manage_secrets": { "computedUserset": { "relation": "developer" } }
   ```
2. `packages/authorization-core/src/index.ts` — add `"node.manage_secrets"` to the
   `AuthzAction` union and a `case "node.manage_secrets": return "can_manage_secrets";`
   to `relationForAuthzAction`.

`developer` already confers it (computed), so **no new role, no new tuple, no
access-request change**. `bootstrap-openfga.sh` mints a new immutable model on the
next `deploy-infra` run from the changed hash; until `OPENFGA_AUTHORIZATION_MODEL_ID`
updates + the pod restarts, a check returns `authz_unavailable` (503), never a
silent allow.

### B. Operator-pod machine identity (the ONLY substrate change — additive)

A dedicated SA where the operator actually runs, bound to a **new** narrowly-scoped
OpenBao role. Add to `scripts/setup/reconcile-env-substrate.sh` (mirrors the
existing `ensure_sa` + `bao_policy` + `auth/kubernetes/role` block):

```hcl
# <env>-node-secrets-writer policy — multi-node (the operator writes for many
# nodes) but explicit-deny on the two shared paths a node grant must never reach.
path "cogni/data/<env>/*"          { capabilities = ["read","create","update","patch"] }
path "cogni/data/<env>/_system/*"  { capabilities = ["deny"] }
path "cogni/data/<env>/_shared/*"  { capabilities = ["deny"] }
```

```
auth/kubernetes/role/<env>-node-secrets-writer
  bound_service_account_names=operator-secrets-writer
  bound_service_account_namespaces=cogni-<env>
  policies=<env>-node-secrets-writer ttl=1h
```

Plus: a `serviceAccountName: operator-secrets-writer` patch in the operator overlay,
and a **projected SA-token volume** with `audience: cogni-openbao` (the default
`kubernetes.default.svc` audience is bound to no role — silent-auth-failure trap).
The pod self-logins over ClusterIP (`http://openbao.openbao.svc:8200/v1/auth/kubernetes/login`)
— **zero SSH, zero `kubectl create token`, no human.** This realizes the in-cluster
north-star already named in `secret-materialize.sh:122-131`.

The same SA gets a small additive **k8s RBAC** Role in `cogni-<env>` (`get` on
`externalsecrets` + `deployments`/`deployments/status`) so the operator can **report
propagation in-process** for the caller (§Closed loop) — replacing the human
`kubectl exec`. This Role can land in Phase 1 or defer to Phase 2; the synchronous
custody confirmation (API response with the KV version) needs no extra RBAC.

> Per-node scope is **not** an OpenBao policy (one shared operator identity writes
> for N nodes); it is enforced at the app layer (§Security boundary). The
> `_system`/`_shared` denies are the policy-layer floor of defense-in-depth.

### C. Operator-local secrets port + route (operator-app code)

The REST path is operator-only, so it mirrors `OperatorDeployPlanePort`
(`nodes/operator/app/src/ports/operator-deploy-plane.port.ts`) — the port the
flight **route** actually calls — **not** the `packages/ai-tools` `VcsCapability`
(that is the AI-tool layer, deferred to Phase 2). Keeping it app-local avoids a
premature cross-node package and the `ToolContract`/`redact` machinery the route
does not need (`packages-architecture.md`: packages are cross-node, ≥2 consumers).

- `nodes/operator/app/src/ports/operator-secrets-plane.port.ts` —
  `OperatorSecretsPlanePort` with `writeSecret({ nodeSlug, env, key, value, op })`;
  deps via constructor, no env loading.
- `OpenBaoSecretsAdapter` (operator-app adapter) — pod self-login → `bao kv patch`
  (or `put` only on a brand-new node path) → ESO force-sync annotation. Reuses
  `set-secret.sh`'s put-vs-patch gate verbatim. The writer token never leaves the
  adapter (the `NO_SECRETS_IN_CONTEXT` invariant).
- `createOperatorSecretsPlane(env)` inline factory in the route (mirrors
  `createOperatorDeployPlane`: throws → 503 if unconfigured). No shared-node stub
  needed — non-operator nodes do not expose this route.
- `POST /api/v1/nodes/[id]/secrets` — `wrapRouteHandlerWithLogging` + owner/authz
  gate → allowlist guard → port. **Both path coordinates are operator-derived, never
  caller-supplied: the node slug comes from the OpenFGA-authorized `resource` (the
  `[id]` the check passed for) and the env from the operator pod's own
  `serverEnv().APP_ENV`** — neither is read from the request body (no node- or
  env-path injection). Write/rotate only; a key-name listing (`GET`) is **not** in the
  minimum — defer.

## Security boundary — defense in depth (the #1 risk)

A scoping bug = cross-tenant secret write. Three independent gates, all mandatory:

1. **OpenFGA** — `check({ action: "node.manage_secrets", resource: "node:<id>" })`.
   `authz_unavailable` → 503, anything-not-allow → 403. Fail-closed; never skip on
   `authorization === undefined` (return 503, do not fall back to owner-only for a
   write this sensitive). **Hard precondition:** prod + preview have no OpenFGA
   store today, so every check there is `authz_unavailable` → the feature is
   **candidate-a-only** until OpenFGA is provisioned on those envs (same gating as
   the OpenBao identity gap — see Open Questions).
2. **Namespace ownership (denylist, not allowlist).** A `can_manage_secrets`
   owner owns their **entire** `cogni/<env>/<node>/*` namespace and may add / set /
   rotate **any** key there — including brand-new ones. That is the scope: a node
   controls its own secrets. So gate 2 is **not** a per-key allowlist (which would
   block "add a new key" _and_ require impossible per-node catalog codegen in an
   operator image that carries no node catalogs). It is a small, fixed,
   operator-domain **denylist** of the substrate-managed keys that live in a node's
   own path (`APP_DB_*`, `DOLTGRES_*`, `DATABASE*_URL`, `AUTH_SECRET`,
   `POSTGRES_ROOT_PASSWORD` — `node-secrets-reserved.data.ts`), so an owner can't
   clobber their own DB/DSN/auth. Everything else is allowed by default. This is a
   footgun guard, not the security floor — gates 1 + 3 + the operator-stamped path
   bound the blast radius to the node's own namespace.
3. **OpenBao policy** — explicit `deny` on `_system/*` and `_shared/*` (§B), so even
   an app-layer bypass cannot touch system seed or cross-node shared values.

Cross-node, shared-infra (`POSTGRES_ROOT`, `LITELLM_MASTER_KEY`, openfga/litellm
DB creds), and CI-tier keys are unreachable by construction.

**Cross-pollination is closed on both axes — node and env.** A `developer` grant is a
single OpenFGA tuple `{user, developer, node:X}`; gate 1 checks the **exact** `node:<id>`
from the URL, so a caller authorized on X gets 403 targeting Y. The **env** axis is closed
by deployment topology, not a tuple: each env runs its **own** operator pod against its
**own** OpenFGA store and self-logins with its **own** `<env>-node-secrets-writer` identity
(OpenBao policy scoped to `cogni/data/<env>/*`). The operator stamps the env from its own
`serverEnv().APP_ENV`, never the request body, so a candidate-a caller cannot write
preview/prod even by forging a path. And on any env with no OpenFGA store (preview/prod
today) **every** check is `authz_unavailable` → 503 — fail-closed by default until that
env is provisioned. Net: an unauthorized (node, env) pair never reaches the write step.

> **Per-node isolation is tuple-based, not token-based.** A `developer` grant on
> node X confers `can_manage_secrets` on **X only** (OpenFGA tuple
> `{user:X-owner, developer, node:X}`); gate 1 checks the specific `node:<id>` from
> the URL, so a caller authorized on X cannot target Y. The shared
> `OPENFGA_API_TOKEN` (= `OPENFGA_AUTHN_PRESHARED_KEYS`) is the operator pod's
> **client credential to the OpenFGA _server_**, seeded at
> `cogni/<env>/operator/OPENFGA_API_TOKEN` — it authenticates the operator _to_ the
> authz server, is never held by a node-owner, and is **not** what scopes nodes.
> Whoever holds it is authz-root, so it lives only in the operator pod (ESO), like
> the GitHub App key. The Phase-1 residual is the **env-wide OpenBao writer token**
> (OpenBao itself does not enforce node scope — the app does), mitigated by
> deriving the path from the authorized `resource` and closed by the Phase-2
> per-node writer role.

## Closed loop + E2E proof shape

```
caller (API key) → POST /api/v1/nodes/[id]/secrets
  → OpenFGA can_manage_secrets ✓  → allowlist ✓
  → operator pod self-login → bao kv patch cogni/<env>/<node>/<KEY>
  → ESO (force-sync annotation, else 1h) → k8s Secret <node>-env-secrets
  → Stakater Reloader rolls the annotated Deployment → process.env.<KEY> live
```

Parallel to flight's `developer→can_flight` proof. **The proof returns through the
product plane, not a shell** — `node-baas-architecture.md` (Supabase analogy:
"tools integrate through APIs and webhooks"). A caller who holds only an API key
must be able to confirm their own write **with that same API key**; requiring
`kubectl exec` would re-introduce the cluster custody the write step just removed.

| Axis                     | Value                                                                                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route                    | `POST /api/v1/nodes/[id]/secrets`                                                                                                                                                                                                |
| Authz                    | `authorization.check(action: "node.manage_secrets")` → `can_manage_secrets ← developer`                                                                                                                                          |
| Observable (custody)     | the API response: `{ written: true, version: N, path: cogni/<env>/<node>/<KEY> }` from the OpenBao KV-v2 write — synchronous, no cluster access                                                                                  |
| Observable (propagation) | the operator reads ESO + rollout **in-process** (its SA gets `get` on `externalsecrets` + `deployments/status` in `cogni-<env>`) and reports `propagation: "Ready"` on a follow-up `GET /api/v1/nodes/[id]/secrets/<KEY>/status` |
| Observable (running)     | the node's own product signal — `/readyz` / a value-derived behavior flips. Supabase-style "it just works."                                                                                                                      |

`kubectl exec` is an **agent dev-time debug aid only** (e.g. inside `/validate-candidate`),
never the contract observable. The product contract is: write is confirmed by the API
response; propagation is reported by the operator reading cluster state for the caller.

## Rotation

Same path, `op=rotate`: `bao kv patch` adds a new KV v2 version (≥10 retained;
never `destroy` pre-incident — `secrets-management.md` Invariant 7). Reloader rolls
the pod automatically (Invariant 11). The OpenBao audit device captures actor +
path + outcome (caveat: the Loki audit shipping is still maturing — `bug.0445`;
don't assume complete Loki rotation history until it closes).

## Phase 2 — hardening (deferred; out of freeze scope)

- Tighten the OpenBao policy from env-wide-with-denies toward a templated per-node
  scope if/when OpenBao identity templating lands.
- Distinct `secrets_manager` role (vs. conferring through `developer`) if owners
  want to grant secret-write without flight rights — needs `NODE_ACCESS_ROLES` +
  the DB CHECK-constraint extension (`node-access-requests.ts:43`).
- AI-tool path: a `packages/ai-tools` `SecretsCapability` + `core__node_secret_set`
  tool wired through `ToolBindingDeps` (with `stubSecretsCapability` on non-operator
  nodes), so the node's own assistant rotates values. The cross-node package is
  justified **only here** — where the tool layer (a package consumed by graphs)
  actually needs it; Phase 1's REST path does not.

## Phase 3 — Secrets across ALL envs (the node-BaaS requirement · `bug.5038`)

**The requirement, not a workaround.** A node spawns into **all three envs**
(candidate-a, preview, production) — that is the BaaS contract
([`node-baas-architecture.md`](../spec/node-baas-architecture.md): _"node declares
shape; operator wires environment"_, where _environment_ = every env). A node
developer holding **only an API key** must be able to set/rotate a `source: human`
secret value for their node on **any** of those envs, with zero kube. **Production
is never a testing ground** — a node's test envs are first-class, and the dev needs
to put a _test_ X-OAuth app's creds on candidate-a/preview and a _separate prod_
app's creds on production. Per-env values are the point, not a limitation.

This is the **Secrets row of the BaaS Substrate Map** (_node declares key names +
consumers; operator provides OpenBao values, ESO manifests, **rotation path**_) and
the gap is real and observed: the first prod node launch (beacon, 2026-06-16)
proved the **control plane** works but the **substrate lane** (DB + edge + secrets)
"needed manual intervention — nothing self-healed" (node-wizard-expert
substrate-gaps table; _"No LLM backend → provision the node's secret"_ is exactly a
`source: human` cross-env secret with no self-serve supply path).

**Why it's blocked today — two facts, both fixable:**

1. **The write primitive is per-env (correct) but only reachable where the node's
   identity + grant exist.** #1627's route stamps env from the operator's own
   `DEPLOY_ENVIRONMENT` (right — closes env-injection) and checks **that env's**
   OpenFGA store + `nodes` registry. The OpenFGA store is substrate on **every** env
   (`openfga-substrate-unification.md`: one `cogni-<env>-rbac` store per env; prod
   live 2026-06-14) — so the store is _not_ missing. What's missing is the node's
   **registry row + owner `can_manage_secrets` tuple in each env**.
2. **Node formation does not fan identity + authz across envs.** It wires (or should
   wire) DB, DNS, edge, and `source: agent` secrets per env — but the node's
   **registry row and the owner's OpenFGA grant are not provisioned into every
   env's store**. So self-serve is reachable only where formation happened to land
   them, and a dev hits a `403`/`404` (or the old kube fallback) everywhere else.

### The RIGHT plan

**Foundation (the actual fix — `OPERATOR_WIRES_EVERY_ENV`): node formation
provisions node-identity + the owner grant into all three envs.** Exactly as the
operator fans DB/DNS/edge/`source:agent`-secrets per env, formation (and each env's
provision/flight re-assert) must write the node's `nodes` row + the owner's
`developer`/`can_manage_secrets` tuple into **that env's** registry + OpenFGA store.
This is one invariant added to the substrate/wizard lane (`reconcile-node-substrate.sh`

- launch-pack + the OpenFGA tuple-write), idempotent and re-asserted on reprovision
  (so candidate-a's frequent rebuilds self-heal the grant instead of dropping it).
  **Without this, no per-env self-serve is reachable; with it, every env is.**

**Then the two secret classes both work on every env, no human kube:**

- **`source: agent`** (DB creds, `AUTH_SECRET`, `CONNECTIONS_ENCRYPTION_KEY`, …):
  the operator **generates** them per env via `secret-materialize` at flight/promote
  — already automated, and clobber-protected as of #1753. No dev action, all envs.
- **`source: human`** (X-OAuth secret, LLM/LiteLLM key, vendor tokens): the dev
  supplies the value **per env** via the shipped #1627 write against **that env's
  operator** — now reachable because the foundation fanned the grant. Each
  env-operator writes only its own `cogni/<env>/<node>/*` with its own in-cluster
  writer (env axis stays closed). Distinct values per env are supported and
  expected (test app vs prod app).

**Deliverables (one PR-sized task each; the foundation is the unblocker):**

1. **Formation fan-out** of node-identity + owner-grant to candidate-a + preview +
   production, idempotent + re-asserted on provision/flight. _(The real gap. Lives
   in the node-wizard/substrate lane — see node-wizard-expert substrate-gaps.)_
2. **Confirm #1627 is deployed on all three env-operators** and the per-env write
   succeeds end-to-end once (1) lands — the write primitive itself is done.
3. **Guide**: document per-env self-serve as THE path for `source: human` node
   secrets (call the env's own operator host); state that `source: agent` keys are
   auto-fanned and must never be hand-set.

**Rejected:**

- **Production as a node's test env** ("it has no users yet"). Rejected outright —
  every node gets first-class test envs; conflating them violates the BaaS contract
  and trains a prod-is-staging habit that breaks the first time a node has data.
- **Per-secret kube CLI** (the operator-admin `secrets-add-new.md` §3–8 fallback as
  the _standard_ path). It is the day-2 admin escape hatch, never the node-dev
  contract — it hard-gates every external dev on one person's `.local` creds.

### Convergence (deferred behind a trigger): single-pane `targetEnv` + operator mesh

Per-env hosts (above) deliver the capability. The **UX** convergence — a dev manages
all of their node's envs from **one** operator surface — is `targetEnv` +
operator-to-operator delegation. Promote the prod operator to the single control
plane for registry + RBAC and let a dev target any env from one host:

```
POST cognidao.org/api/v1/nodes/<id>/secrets { key, value, targetEnv: "candidate-a" }
  → prod operator: OpenFGA check (it knows the node + grant)  [GATE 1, here]
  → authz-scoped targetEnv  [NEW: targetEnv ∈ caller's grant]
  → delegate to test.cognidao.org internal endpoint (operator→operator service cred, mTLS)
  → candidate-a operator writes cogni/candidate-a/<node>/* via its OWN in-cluster writer
```

The target operator **trusts the control-plane operator's authz** (it can't
re-check — it doesn't know the node); the trust seam is a service credential held
**only by the control-plane operator pod** (ESO-sourced, like `OPENFGA_API_TOKEN`),
never by a dev. The value crosses operator→operator over TLS, lands in the target
env's OpenBao, and the env axis stays closed (each operator still writes only its
own env).

### Alignment with the operator control plane (the deploy port) — REQUIRED

This is **not a secrets one-off.** It is the secrets row of the same typed
operator control plane that owns deploy, framed in
[`cicd-platform-boundary.md`](../spec/cicd-platform-boundary.md) ("the deploy
brain goes into the `.ts` operator app as a hexagonal capability… the model is
Railway: the operator declares intent and sees live state; the substrate
executes") and [`operator-managed-deployments.md`](./operator-managed-deployments.md)
(SEE / DEPLOY / REMOVE). `OperatorSecretsPlanePort` (#1627) is already a **sibling
of `OperatorDeployPlanePort`**; Phase 3b is "give the secrets plane the same
cross-env targeting deploy already has" — `dispatchNodePromote({ env })` is the
precedent for `writeSecret({ targetEnv })`.

**But one axis differs, and it is the whole design tension.** The deploy port
reaches other envs **declaratively**: it writes intent to git, the GitHub App is
the only write credential, and Argo reconciles — _"git is the steering wheel;
a compromised operator token can look but not touch."_ **Secrets cannot ride that
rail** — a value can't transit a git commit or a `workflow_dispatch` input without
plaintext exposure (Non-goal). So cross-env secrets are the **one** control-plane
operation that needs a **live, custodial channel**, which is exactly why 3b is an
operator→operator call and not "write the value to a deploy branch." Any future
"operator owns VMs / logs / health / scaling" surface that is **read or
git-declarative** inherits the deploy port's safe non-custodial model; **secret
_values_ are the deliberate exception** and must stay on the narrow
authorized-mesh path. Build 3b as that sibling capability, reusing the deploy
plane's RBAC-gated, env-targeted shape — not a parallel mechanism.

> **OpenFGA control gap (the thing the operator doesn't yet own).** The store is
> on every env, but the operator app is **operator-only consumer per-env**
> today; it cannot manage another env's tuples. 3b's control-plane operator
> needs cross-env authz reach — track it with the all-node consumption path in
> [`openfga-substrate-unification.md`](./openfga-substrate-unification.md)
> (Phase B: relocate bootstrap to a self-owned Job, publish store/model to the
> `_shared` fan), so "operator authorizes any env" is a substrate capability,
> not a bespoke cross-env token.

**Rejected alternatives:**

- **Prod operator holds a writer + network path into _every_ env's OpenBao
  directly** (no mesh, one skeleton key). Rejected — makes the prod operator a
  single credential that can write all envs' secret planes; max blast radius,
  violates the per-env data-plane isolation the design is built on.
- **`secret-set.yml` GitHub Actions OIDC writer** (deploy-port-style dispatch).
  Rejected for human values — the value can't ride a `workflow_dispatch` input
  without plaintext exposure (Non-goal). Fine for `source: agent` keys, but those
  are already minted by `secret-materialize`; it adds nothing for the vendor-value
  case this bug is about.
- **Unify the operator DB + OpenFGA across all envs into one shared store.**
  Rejected for now — candidate-a/preview run _unmerged_ operator code; a shared
  control-plane schema would couple test envs to prod's migration state (the exact
  test-isolation the separate stores buy). 3b keeps registry on prod and delegates
  execution, getting the centralized UX without merging the data planes.

## Non-goals

- A generic secret-management UI (the wizard doc's non-goal still holds).
- A fourth secret write entry point or a parallel catalog — the per-node catalog
  is the SSOT; this consumes it.
- Letting the value transit a `workflow_dispatch` input (plaintext) — value goes
  caller→pod→OpenBao only, which is _why_ the machine identity is required.
- Touching the existing `<env>-writer` role, `secret-materialize`, or any workflow.

## Open questions

- [ ] Provision the new SA + role on **all** envs before prod go-live (prod lacks
      even `openbao-operator` today — `bug.5007`). Candidate-a first.
- [ ] Confirm `audience: cogni-openbao` matches OpenBao's `bound_audiences` on the
      k8s auth backend before wiring the projected token.
- [ ] **Phase 3a (`bug.5038`):** confirm an external agent can register a node +
      receive a grant on a test-env operator API-only (no kube), and that a
      candidate-a reprovision preserves the node row + grant (else prefer preview).
- [ ] **Phase 3b trigger:** define when per-env operation becomes painful enough to
      build the `targetEnv` + operator-mesh delegation (e.g. ≥2 external nodes, or a
      dev manages ≥3 envs). Until then, 3a holds.
- [x] Allowlist source resolved: A2 entries live in `infra/secrets-catalog.yaml`
      (per-node `.cogni/*.yaml` empty today) **and** the operator runtime image carries
      neither that file nor the loader — so gate 2 reads a **build-time-generated typed
      allowlist module** (codegen at build from the consolidated catalog's A2 entries,
      #1479 pattern), failing closed if absent. Never a runtime `fs` read. See
      §Security boundary gate 2.
