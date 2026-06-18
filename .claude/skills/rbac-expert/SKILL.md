---
name: rbac-expert
description: "Authorization/RBAC navigation for cogni-template — points at the canon (OpenFGA model, AuthorizationPort, rbac.md invariants, the access-request flow, the hardening roadmap) and captures the durable mental model + hard-won gotchas that aren't obvious when you read it: OpenFGA is the sole authority, principal→role→capability, deny-by-default / fail-closed-with-distinction, why authorization is `undefined`, immutable hashed models, the request→approve→flight grant loop, and which checks aren't wired yet. Use when adding an authz check to a route/tool, designing a new protected action or role, debugging authz_denied vs authz_unavailable, deciding why authorization is undefined, granting/revoking node access, or touching packages/authorization-core / OpenFgaAuthorizationAdapter / infra/openfga/rbac-model.json / scripts/ci/bootstrap-openfga.sh / node_access_requests / POST /api/v1/nodes/{id}/{access-requests,developers} / POST /api/v1/vcs/flight. Triggers: 'OpenFGA', 'RBAC', 'ReBAC', 'authorization', 'AuthorizationPort', 'authz check', 'node.flight', 'can_flight', 'developer role', 'access request', 'approve agent', 'grant access to a node', 'tuple write', 'writeRelation', 'authz_denied', 'authz_unavailable', 'deny by default', 'fail closed', 'subjectId', 'on-behalf-of', 'delegation', 'OPENFGA_STORE_ID', 'authorization model', 'immutable model', 'bootstrap-openfga', 'rbac-model.json', 'add a role', 'add a permission', 'why is authz undefined', 'why 503 authz_unavailable', 'production_promoter', 'preview_promoter', 'can_promote_production', 'NODE_ACCESS_ROLES', 'validate an rbac extension', 'prove a grant works', 'candidate-flight-infra', 'two-lever bootstrap', 'role-grant workflow'."
---

# RBAC Expert

Navigation for authorization in cogni-template. **This file deliberately does NOT restate the model, the invariant text, the action map, or the roadmap — those live in canon and rot if copied. It points at canon and captures what isn't obvious once you're reading it.**

## Read the canon (don't duplicate it here)

| Source                                                                                          | Owns — go here for the current truth                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`docs/spec/rbac.md`](../../../docs/spec/rbac.md)                                               | Numbered invariants, the ReBAC model + DSL, the action→relation table, §6 Node Access Request Flow, the candidate-flight use case                                                                |
| [`infra/openfga/rbac-model.json`](../../../infra/openfga/rbac-model.json)                       | The authored, immutable model — the real SSOT for what's grantable                                                                                                                               |
| [`packages/authorization-core/src/index.ts`](../../../packages/authorization-core/src/index.ts) | `AuthorizationPort` (`check` / `writeRelation` / `deleteRelation`), decision codes, **`relationForAuthzAction()`** (the action→relation SSOT — read it, don't memorize a copy), resource helpers |
| [`docs/spec/identity-model.md`](../../../docs/spec/identity-model.md)                           | Principals; `actorId` (runtime string) vs `actor_id` (economic-subject column)                                                                                                                   |
| [`work/projects/proj.rbac-hardening.md`](../../../work/projects/proj.rbac-hardening.md)         | Live roadmap + as-built status (what's wired vs pending) — **the authority on "is X enforced yet"**                                                                                              |
| [`docs/spec/access-control-charter.md`](../../../docs/spec/access-control-charter.md)           | Layer-cake framing (Identity → AuthN → AuthZ → Secrets → DAO)                                                                                                                                    |

## The mental model (the durable part)

- **OpenFGA is the SOLE authority** for permission + delegation. ToolPolicy + grant-intersection run _before_ it as capability/safety gates ("does this capability exist?"), never as authz. **Never add a second authority** — no per-service role tables; tracking rows (`node_access_requests`) are display state, never read by a `check()`.
- **Principal → role → capability.** You _grant a role_ (a directly-assignable relation, e.g. `developer`); OpenFGA _derives the capability_ (a computed relation, e.g. `can_flight from developer`); a route _checks the capability_ via `relationForAuthzAction()`. Adding an access level = add a role relation + its `can_X from <role>` in the model, then map the action. The **principal** (who: `user:` / `agent:` / `service:`) is orthogonal to the role.
- **Dual-check on-behalf-of:** when a `check()` carries `subjectId`, BOTH must pass — subject has the permission AND actor `delegates` for subject. `subjectId` is bound server-side only (never from a body/arg).
- **Two invariants bite hardest** (full numbered set in rbac.md "Core Invariants"): **deny-by-default** (no tuple ⇒ deny) and **fail-closed-with-distinction** (infra failure ⇒ deny, coded `authz_unavailable` = 503, distinct from `authz_denied` = 403). Conflating those two hides outages. Also: check _before_ the side effect, never after.

## The grant loop (node access — the product surface)

`rbac.md §6`. `register` → agent `POST /nodes/{id}/access-requests {role}` (files a tracking row; owner sees it in the **Agents** UI) → owner `POST /nodes/{id}/developers {agentUserId, decision, role}` (writes/deletes the OpenFGA **role** tuple — _the authority_; the row transition is best-effort) → the gated route enforces the capability. The flow is **role-general**: `role ∈ NODE_ACCESS_ROLES` (`developer`→`can_flight`, `production_promoter`→`can_promote_production`); the approve route writes `relation:<role>` (default `developer`). Two flight paths share the `node.flight` check: the **direct route** and the **`core__vcs_flight_candidate` graph tool** (gated as `tool.execute`).

> **A capability relation with no grantable role is inert.** Adding `can_X from <role>` to the model is only half the work — the role must ALSO be in `NODE_ACCESS_ROLES` + the access-request CHECK + writable by the approve route, or no principal can ever hold it. (This is why `production_promoter` shipped _with_ the role-grant path, not after.)

> **Proof a grant actually works:** the gated route returns `403 authz_denied` _before_ approval and flips to a _downstream_ error (e.g. `catalog_missing` / preflight) _after_ — RBAC passed; the failure moved past it.

## Validate an RBAC extension end-to-end (API + Grafana — NEVER SSH)

Every new role/capability is proven on **candidate-a** entirely over HTTP, observed in Loki. **Do not SSH the VM to write tuples or read OpenFGA** — the grant API _is_ the surface. If a role can't be granted via API, that's the bug to fix (see grant loop), not an SSH workaround.

**Setup** — one owner session + one fresh requester agent:

- Owner session = captured `.local-auth/candidate-a-operator.storageState.json` (Bearer also works; the gated routes resolve Bearer→session).
- Requester = `POST /api/v1/agent/register {name}` → `{userId, apiKey}`.
- **Billing-before-authz gotcha:** the gated routes check a billing account _before_ the authz check (mirrors flight). A fresh principal 403s `billing_account_missing` and never reaches the gate — masking it. Provision one by hitting any BYO-AI status route once with the principal's Bearer: `GET /api/v1/auth/openai-compatible/status` get-or-creates the billing account.
- Need a node you own → `POST /api/v1/nodes {slug, chainId}` returns its `id`.

**The four-state proof** (gated route = the one your action maps to, e.g. `POST /api/v1/deploy/promote {nodeId, env:"production"}` for `can_promote_production`):

1. **deny-by-default** → `403 authz_denied` (billing present, no role tuple).
2. **grant** → requester `POST /nodes/{id}/access-requests {role}`; owner `POST /nodes/{id}/developers {agentUserId, decision:"approve", role}`.
3. **flip** → re-hit the gated route → flips _off_ `authz_denied` to a downstream code (`catalog_missing`, preflight, 200). RBAC passed.
4. **revoke** → owner `…{decision:"reject", role}` → back to `403 authz_denied`. Deny restored.

**Observability (tier-1, ties to YOUR request):** each route logs `route="<routeId>"` — `deploy.promote`, `nodes.developers`, `nodes.access-requests`, `vcs.flight`. Query `{namespace="cogni-candidate-a", pod=~"operator-node-app-.*"} | json | route="deploy.promote"` and match the status ladder (403→…→403) to your exercise window. `scripts/loki-query.sh '<logql>' <mins> <limit>` — export `GRAFANA_URL`+`GRAFANA_SERVICE_ACCOUNT_TOKEN` **inline** (`.env.cogni` has placeholder lines that break `set -a; source`).

**The two-lever bootstrap trap (503-vs-403 tell) — the reason you'd be tempted to SSH:** `candidate-flight` (app lever) deploys only the app image; it does **NOT** bootstrap the OpenFGA model. A PR that adds/renames a **relation** ships the app, but the deployed store still runs the old model → your gated route returns **`503 authz_unavailable`** (the check resolves a relation the model lacks → fail-closed), NOT `authz_denied`. Fix is a second lever, not a hand-edit: **`gh workflow run candidate-flight-infra.yml --ref <your-branch>`** → `deploy-infra.sh` → `bootstrap-openfga.sh` mints the new model, repoints `OPENFGA_AUTHORIZATION_MODEL_ID` in the operator config, and `rollout restart`s the pods. **Diagnostic:** an _existing_-relation route (`vcs/flight`→`can_flight`) returning `403 authz_denied` while your _new_-relation route returns `503` proves the adapter is healthy and only your relation is missing → model-bootstrap lever, not a code bug. candidate-a mirrors preview/prod only when **both** levers run (preview/prod get the model via `promote-and-deploy`'s `deploy-infra` job on merge).

## Gotchas (hard-won, not in the spec)

- **`authorization` is `undefined` until `OPENFGA_STORE_ID` exists.** `container.ts` (~L842) builds the adapter only when `OPENFGA_API_URL` **and** `OPENFGA_STORE_ID` are both set — reachability ships before policy. **Prod has a LIVE OpenFGA store since 2026-06-14** — RBAC is enforced on prod (e.g. `production_promoter` was exercised end-to-end there), NOT candidate-a-only. Where a store is absent, `/developers` returns `503 authz_unavailable` and flight falls back to the V0 owner-only check. **Verify per env before relying on it** — candidate-a + prod have stores; preview's store status should be confirmed against the env, not assumed. (Corrects the prior "prod + preview have no store" note.)
- **`authz_unavailable` (503) ≠ `authz_denied` (403).** A timeout/outage is _unavailable_, not _denied_.
- **Models are immutable + hashed.** Editing `rbac-model.json` mints a new model version on next bootstrap; tuples reference relations _by name_, so **renaming a live relation (e.g. `developer`) is a migration, not an edit.** Add relations; don't rename live ones.
- **The model is principal-agnostic — `node.developer: [user, agent]` accepts both today.** V0 grants `user:{agent_user_id}` (agents register as users); an `agent:{actor_id}` form later is **additive** (new `@agent:` tuples — no model change, no tuple rewrite). Not debt, not split-brain. **Never narrow `developer` to `[user]`.**
- **Not every action is enforced yet.** `node.flight` + `tool.execute` are wired; `graph.invoke` and `connection.use` checks are still pending (see `proj.rbac-hardening.md`). **Don't assume a capability is gated — verify in the route** before relying on it.
- **Don't overload reserved identity terms.** `scope` → reserved for `scope_id` (governance); `actor` → reserved for `actor_id` (economic) + the `actorId` principal string. Principals are agent/user/service — which is why the access-request column is `role`, not `scope`.
- **Never read `node_access_requests` to authorize** — it's display/UX; the OpenFGA tuple is the authority.

## Where each surface lives

| Surface                                                       | File                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Authz construction (and when it's `undefined`)                | `nodes/operator/app/src/bootstrap/container.ts` (~L842)                                           |
| `node.flight` enforcement + V0 owner fallback                 | `nodes/operator/app/src/app/api/v1/vcs/flight/route.ts`                                           |
| Role tuple write/delete (approve/deny/revoke), **role-aware** | `nodes/operator/app/src/app/api/v1/nodes/[id]/developers/route.ts`                                |
| Agent access request (role enum)                              | `nodes/operator/app/src/app/api/v1/nodes/[id]/access-requests/route.ts`                           |
| Tracking schema + `NODE_ACCESS_ROLES` + CHECK                 | `nodes/operator/app/src/shared/db/node-access-requests.ts`, `features/nodes/access-requests.ts`   |
| OpenFGA adapter + deterministic fake                          | `packages/authorization-core/src/adapters/`, `.../test/`                                          |
| Per-env store/model bootstrap                                 | `scripts/ci/bootstrap-openfga.sh` (via `scripts/ci/deploy-infra.sh`)                              |
| Re-bootstrap the model on candidate-a                         | `gh workflow run candidate-flight-infra.yml --ref <branch>` (the infra lever; app lever skips it) |
