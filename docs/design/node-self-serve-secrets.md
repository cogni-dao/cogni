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

### The RIGHT plan — formation fans the grant per env; keep per-env isolation

> **Converged via three independent adversarial reviews (2026-06-18).** An earlier
> draft of this section proposed a global control-plane operator + an
> operator→operator mTLS delegated write. **All three reviewers rejected it** and
> they converged: (security) the mTLS "target trusts control-plane, can't re-check"
> delegation **is** the skeleton key this doc claims to reject — one service-cred
> leak = total cross-env compromise, plus a confused-deputy; (consistency) it
> contradicts Phase 1's env-axis-closed-by-topology floor and is **spec-blocked** by
> `openfga-substrate-unification.md`'s "one store per env, permanently"; (simplicity)
> it is a project-sized re-platforming where **one PR** suffices. The plan below is
> their converged answer.

Three planes, scoped correctly — but reached cheaply, **without** centralizing
identity:

| Plane                                            | Right scope                          | How it's reached                                                                         |
| ------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Identity** (API key + principal)               | _logically_ one dev relationship     | keep per-env identity infra; the operator **brokers/custodies** per-env creds (deferred) |
| **Authorization** (write key K on node Y, env E) | **per-(node, env)** — already is     | one OpenFGA tuple in **that env's own** store; prod grant gated on promotion             |
| **Data** (the value bytes)                       | **per-env** (`cogni/<env>/<node>/*`) | the **shipped #1627 route**, env operator-stamped — unchanged                            |

> **Architect correction (2026-06-18, Derek).** Do **not** create a separate node
> registration per env. **A node is registered ONCE — in the (prod/control-plane)
> operator — and that record is _env-aware_:** it knows which envs the node is
> deployed in, exactly as the deploy-port / node-awareness layer already tracks a
> node's per-env deploy state ("node X: candidate-a ✓, preview ✓, production —").
> Per-env `nodes` rows are incidental current state, **not** the target. The earlier
> "fan a registration into each env" framing is retracted.

**Foundation: ONE env-aware node record + ONE grant; per-env value writes
authorized against it.** Three layers, scoped to match Derek's correction:

1. **Node identity & awareness = singular + env-aware** (the deploy-port / node
   model). One `nodes` record in the control-plane operator; "which envs is it in"
   is an attribute of that record (derived from deploy state), never a second
   registration. _This is the real foundation, and it replaces "register per env."_
2. **Authorization = granted once on that node record.** The owner gets
   `can_manage_secrets` on node X one time. Env-scoping for **safety** is a separate,
   deliberate gate (below) — not a separate registration.
3. **Secret VALUE = per-env, written into that env's own vault.** The value never
   becomes a single super-operator's to push everywhere (that was the rejected
   skeleton key). The cross-env step carries only a **narrowly-scoped, signed,
   single-use, target-verified capability to write exactly `(node, env, key)`** — the
   target env validates the signature + its own `APP_ENV` + TTL + replay-nonce before
   writing its OpenBao (the security review's required shape; "verify the claim," not
   "trust the channel"). A leaked cred can write nothing beyond its one named tuple.

- `source: agent` keys: still operator-generated per env by `secret-materialize`
  (no dev; clobber-protected since #1753).
- `source: human` keys: the dev sets the value once, env-targeted; it lands in that
  env's vault. Distinct values per env (test X-app vs prod X-app) are the point.

**Test↔prod isolation stays hard:** the **production** secret-write is a separate,
deliberate grant (mirror `production_promoter`); a test grant can never authorize a
prod write, and a `source: human` prod value is never auto-asserted from test-env
code.

**Honest size (correcting my "~1 PR" claim):** Derek's correction makes this a small
**project, not one PR**. It needs (a) the env-aware single node model in the
operator's node-awareness layer, (b) one identity that the per-env write path can
trust, and (c) the scoped/signed cross-env write. The simplicity review preferred a
1-PR per-env fan-out, but that path **is** "register/grant per env," which the
architect rejected — so we take the larger, correct shape.

**Deliverables (sequenced):**

1. **Env-aware node model** — the operator's node-awareness (deploy-port layer)
   exposes, for the single `nodes` record, which envs the node is deployed in. One
   registration, env-presence as an attribute. _The foundation; Derek's correction._
2. **One grant, prod-gated** — `can_manage_secrets` granted once on the node record;
   the **production** secret-write is a separate deliberate grant (mirror
   `production_promoter`), so test authz can never reach prod.
3. **Scoped, signed cross-env write** — env-targeted `writeSecret`, where the value
   lands in the target env's own vault via a single-use, signed, target-verified
   `(node, env, key)` capability (verify the claim, not trust the channel). Reuses
   the shipped #1627 per-env write as the executor.
4. **Guide** — `source: human` secrets are set through this path, env-targeted;
   `source: agent` keys are auto-generated per env, never hand-set.
5. **(Deferred, triggered)** smooth the dev to a single login (operator key-broker /
   audience-scoped tokens — discard per-env _keys_, keep per-env _credential scope_).

**Rejected (with the reviews' teeth):**

- **A second node registration per env.** _Architect-rejected._ One env-aware record;
  per-env `nodes` rows are incidental state, not the model.
- **Blind operator→operator mTLS delegated write** (target trusts the channel, can't
  re-check). The skeleton key — one leaked service cred writes any env's secrets.
  Replaced by the scoped/signed/target-verified capability in deliverable 3.
- **Production as a node's test env** ("no users yet"). Every node gets first-class
  test envs; conflating them violates the BaaS contract and trains prod-is-staging.
- **Per-secret kube CLI** as the standard path — the day-2 admin escape hatch only.

### Port alignment — secrets is a sibling of the deploy + observability planes

The shape is already established by the operator's existing primitives. Every
node-scoped, env-targeted operator action follows **one pattern**, and secrets is
the lone outlier that breaks it:

| Operator action                      | Port / surface                                             | Node resolved                                                  | Env                               | Authz (on `node:<id>`)                      | Dev holds                          |
| ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------- | ------------------------------------------- | ---------------------------------- |
| Deploy **read** (state)              | `DeployCapability.getDeployState({env, node})`             | once                                                           | **param**                         | —                                           | nothing                            |
| Deploy **write** (promote)           | `OperatorDeployPlanePort.dispatchNodePromote({env, slug})` | once                                                           | **param**                         | `node.promote_*` (prod is a distinct grant) | nothing                            |
| Observability **read** (logs, #1766) | `…/observability/logs?env=` → Loki reader                  | once (`resolveNodeRegistry().listPublic()`, by id **or** slug) | **param** (`FLIGHT_ENVS`)         | `node.flight`                               | nothing (operator holds the token) |
| **Secrets write** (#1627 today)      | `OperatorSecretsPlanePort.writeSecret(...)`                | once (direct `nodes` select)                                   | **stamped from `serverEnv()` ❌** | `node.manage_secrets`                       | nothing                            |

**The fix is to make secrets obey the same pattern** — that _is_ the alignment
Derek asked for:

1. **`env` becomes a parameter, not a stamp.** `writeSecret({ nodeId, env, key,
value, op })`, `env` validated against the shared **`FLIGHT_ENVS`** enum — exactly
   like `dispatchNodePromote({ env })` and the logs proxy's `?env=`. This is the one
   change that turns secrets from "only my own env" into "any env, like its siblings."
2. **One env-aware node identity, reused — not a new registration.** The route
   resolves the node through the **same `resolveNodeRegistry()` resolver the logs
   proxy uses** (by id **or** slug), so it inherits #1766's published-node fix and
   Derek's "one record" invariant for free. Today #1627 does a direct `nodes` select —
   **migrate it onto the registry port.** "Which envs is the node in" is **not** a new
   field to denormalize: compose **`DeployCapability.getDeployState({env, node})`** —
   the existing env-aware read — to confirm the `(node, env)` cell is live before a
   write. Identity (registry) × env-presence (deploy state) = the env-aware node model,
   built from two primitives that already exist.
3. **Prod is a distinct grant, mirroring deploy.** Deploy already splits
   `node.promote_production` from ordinary flight (a separate `production_promoter`
   tuple). Secrets mirrors it: a **`node.manage_secrets_production`** scope distinct
   from the test/preview grant, so the prod write is a deliberate, separately-approved
   capability — the test↔prod isolation, expressed the way the deploy port already
   expresses it.
4. **The write executor is adapter-swappable** (like `DeployCapability`, whose
   interface "never names a provider"). For the operator's own env: the shipped #1627
   direct OpenBao write. For a remote env: the **scoped/signed/target-verified
   `(node, env, key)` capability** (the security review's safe shape). The port
   interface is identical either way — the adapter owns _how_ the value reaches env
   E's vault. **No skeleton key in the interface**; the cross-env delivery is one
   swappable adapter, fail-closed until built.

**Net:** secrets stops being a special case and becomes the **secrets row** of the
same typed, node-scoped, env-parameterized operator control plane that deploy and
observability already are — `cicd-platform-boundary.md`'s Railway model, realized.
The only secrets-specific part is the value-delivery adapter (4); everything else is
the established pattern.

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
- [ ] **`bug.5038` D1 — env param:** migrate the #1627 secrets route off the direct
      `nodes` select onto `resolveNodeRegistry()` and accept `env` as a `FLIGHT_ENVS`
      parameter (drop the `serverEnv()` stamp). Verify against the logs-proxy shape.
- [ ] **D3 — prod scope:** add `node.manage_secrets_production` to the OpenFGA model
      as a distinct grant (mirror `production_promoter`); confirm a test grant returns
      `authz_denied` for an `env=production` write.
- [ ] **D4 — cross-env adapter:** design the scoped/signed/target-verified
      `(node, env, key)` write capability (security review's required shape); operator's
      own env uses the shipped direct write. Fail-closed until built.
- [ ] **Env-aware identity:** confirm one global dev identity the per-env write path
      can trust (audience-scoped child tokens vs. operator key-broker) — the deferred
      single-relationship UX, not a D1 blocker.
- [x] Allowlist source resolved: A2 entries live in `infra/secrets-catalog.yaml`
      (per-node `.cogni/*.yaml` empty today) **and** the operator runtime image carries
      neither that file nor the loader — so gate 2 reads a **build-time-generated typed
      allowlist module** (codegen at build from the consolidated catalog's A2 entries,
      #1479 pattern), failing closed if absent. Never a runtime `fs` read. See
      §Security boundary gate 2.
