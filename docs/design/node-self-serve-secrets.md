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
(the per-node catalog that _is_ the allowlist). It mirrors the **flight triangle**
(`developer → can_flight` → operator-held GitHub App creds → dispatch) one rung
over: `developer → can_manage_secrets` → operator-held OpenBao writer → write.

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
 │ GATE 1  OpenFGA: is THIS caller `developer` on node <id>?  ────────────┼───┼─► OpenFGA store
 │ GATE 2  allowlist: is FOO declared in <id>'s catalog (tier A2)?        │   │  (per-node tuples)
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
2. **Catalog allowlist (defense-in-depth, not the floor).** Resolve `<KEY>` in the
   granted node's A2 catalog and require `openBaoPathFor()` to yield exactly
   `cogni/<env>/<node>/<KEY>` for the **granted** slug; refuse undeclared keys and any
   `B/D/E/F/G` tier. (`set-secret.sh` validates `_system`/KEY-regex but **not** catalog
   membership — that check is net-new and lives here.) **Runtime-image constraint:** the
   operator container copies only `nodes/operator/.cogni` — **not**
   `infra/secrets-catalog.yaml` nor `secrets-catalog-loader.ts` (verified against
   `nodes/operator/app/Dockerfile`; same finding as the #1479 homepage showcase). So
   this gate **must not** `fs`-read the consolidated catalog at runtime. It reads a
   **build-time-generated typed allowlist module** bundled into the app — codegen at
   build from `infra/secrets-catalog.yaml`'s A2 entries (the #1479 typed-module pattern)
   — never a runtime glob, never the empty per-node `.cogni/*.yaml`. If that module is
   absent, **fail closed** (refuse the write); never fall back to a runtime read.
   **This gate is depth, not the security floor:** gates 1 + 3 already bound the blast
   radius — an undeclared key can only land at `cogni/<env>/<node>/*` (the granted
   node's own path → its own namespace/pod), so a missing or stale allowlist is
   self-inflicted on the caller's own node, never cross-tenant.
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
- [x] Allowlist source resolved: A2 entries live in `infra/secrets-catalog.yaml`
      (per-node `.cogni/*.yaml` empty today) **and** the operator runtime image carries
      neither that file nor the loader — so gate 2 reads a **build-time-generated typed
      allowlist module** (codegen at build from the consolidated catalog's A2 entries,
      #1479 pattern), failing closed if absent. Never a runtime `fs` read. See
      §Security boundary gate 2.
