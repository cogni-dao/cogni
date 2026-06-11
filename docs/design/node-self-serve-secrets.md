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

| Surface                                                                           | Verdict                       | Anchor                                                                         |
| --------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| OpenFGA `check` call-site (`action`/`resource`/`context`, 503-vs-403)             | **reuse verbatim**            | `vcs/flight/route.ts:206-221`                                                  |
| `developer` grant loop (approve → `writeRelation` tuple)                          | **reuse — no new tuple/role** | `nodes/[id]/developers/route.ts:202-211`                                       |
| `relationForAuthzAction` SSOT + immutable-model auto-roll                         | **reuse**                     | `authorization-core/src/index.ts:115`, `bootstrap-openfga.sh:141-164`          |
| Capability/port + bootstrap factory + stub-on-non-operator                        | **reuse pattern**             | `bootstrap/capabilities/vcs.ts:61`, `operator-deploy-plane.ts:17`              |
| `wrapRouteHandlerWithLogging` + owner-gating + Loki events                        | **reuse pattern**             | `nodes/[id]/developers/route.ts`                                               |
| `set-secret.sh` guards (env enum, `_system` refusal, KEY regex, put-vs-patch)     | **reuse logic**               | `scripts/secrets/set-secret.sh:51-137`                                         |
| `openBaoPathFor()` path resolution                                                | **reuse**                     | `secrets-catalog-loader.ts:327-344`                                            |
| Per-node catalog = the allowlist                                                  | **reuse as data**             | `infra/secrets-catalog.yaml` (A2 entries)                                      |
| ExternalSecret + Reloader closed loop (cluster-wide, opt-in, already on node-app) | **reuse — already live**      | `infra/k8s/argocd/reloader/values.yaml`, `base/node-app/deployment.yaml:15-20` |
| **Operator-pod OpenBao machine identity**                                         | **NET-NEW**                   | —                                                                              |
| `SecretsCapability` + `OpenBaoSecretsAdapter`                                     | **NET-NEW**                   | —                                                                              |
| `node.manage_secrets` action + `can_manage_secrets` relation                      | **NET-NEW (tiny)**            | —                                                                              |
| Catalog-membership + path-scope + tier guard in the write path                    | **NET-NEW**                   | —                                                                              |
| `POST /api/v1/nodes/[id]/secrets` route                                           | **NET-NEW**                   | —                                                                              |

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
  gate → allowlist guard → port. **The target node slug is taken from the
  OpenFGA-authorized `resource`, never from the request body** (no path injection).
  Write/rotate only; a key-name listing (`GET`) is **not** in the minimum — defer.

## Security boundary — defense in depth (the #1 risk)

A scoping bug = cross-tenant secret write. Three independent gates, all mandatory:

1. **OpenFGA** — `check({ action: "node.manage_secrets", resource: "node:<id>" })`.
   `authz_unavailable` → 503, anything-not-allow → 403. Fail-closed; never skip on
   `authorization === undefined` (return 503, do not fall back to owner-only for a
   write this sensitive). **Hard precondition:** prod + preview have no OpenFGA
   store today, so every check there is `authz_unavailable` → the feature is
   **candidate-a-only** until OpenFGA is provisioned on those envs (same gating as
   the OpenBao identity gap — see Open Questions).
2. **Catalog allowlist** — resolve `<KEY>` in the granted node's catalog; require
   `tier == "A2"` and that `openBaoPathFor()` yields exactly `cogni/<env>/<node>/<KEY>`
   for the **granted** node slug. Refuse undeclared keys and any `B/D/E/F/G` tier.
   (`set-secret.sh` validates `_system`/KEY-regex but **not** catalog membership —
   that check is net-new and lives here.)
3. **OpenBao policy** — explicit `deny` on `_system/*` and `_shared/*` (§B), so even
   an app-layer bypass cannot touch system seed or cross-node shared values.

Cross-node, shared-infra (`POSTGRES_ROOT`, `LITELLM_MASTER_KEY`, openfga/litellm
DB creds), and CI-tier keys are unreachable by construction.

## Closed loop + E2E proof shape

```
caller (API key) → POST /api/v1/nodes/[id]/secrets
  → OpenFGA can_manage_secrets ✓  → allowlist ✓
  → operator pod self-login → bao kv patch cogni/<env>/<node>/<KEY>
  → ESO (force-sync annotation, else 1h) → k8s Secret <node>-env-secrets
  → Stakater Reloader rolls the annotated Deployment → process.env.<KEY> live
```

Parallel to flight's `developer→can_flight` proof:

| Axis       | Value                                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route      | `POST /api/v1/nodes/[id]/secrets`                                                                                                                                                                        |
| Authz      | `authorization.check(action: "node.manage_secrets")` → `can_manage_secrets ← developer`                                                                                                                  |
| Observable | **primary:** `kubectl exec <pod> -- test -n "$KEY"` on candidate-a + `/readyz` green post-roll. **secondary (only once `bug.0445` ships audit→Loki):** the agent's own write in the OpenBao audit stream |

ESO sync proves the k8s Secret; only the `kubectl exec` (or a value-derived runtime
behavior) proves the **running process** sees it.

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
- [ ] Per-node catalog files are empty today (A2 entries consolidated in
      `infra/secrets-catalog.yaml`); the allowlist check must read the consolidated
      catalog, not assume `nodes/<node>/.cogni/secrets-catalog.yaml` exists.
