---
name: rbac-expert
description: "Authorization/RBAC navigation for cogni-template — points at the canon (OpenFGA model, AuthorizationPort, rbac.md invariants, the access-request flow, the hardening roadmap) and captures the durable mental model + hard-won gotchas that aren't obvious when you read it: OpenFGA is the sole authority, principal→role→capability, deny-by-default / fail-closed-with-distinction, why authorization is `undefined`, immutable hashed models, the request→approve→flight grant loop, and which checks aren't wired yet. Use when adding an authz check to a route/tool, designing a new protected action or role, debugging authz_denied vs authz_unavailable, deciding why authorization is undefined, granting/revoking node access, or touching packages/authorization-core / OpenFgaAuthorizationAdapter / infra/openfga/rbac-model.json / scripts/ci/bootstrap-openfga.sh / node_access_requests / POST /api/v1/nodes/{id}/{access-requests,developers} / POST /api/v1/vcs/flight. Triggers: 'OpenFGA', 'RBAC', 'ReBAC', 'authorization', 'AuthorizationPort', 'authz check', 'node.flight', 'can_flight', 'developer role', 'access request', 'approve agent', 'grant access to a node', 'tuple write', 'writeRelation', 'authz_denied', 'authz_unavailable', 'deny by default', 'fail closed', 'subjectId', 'on-behalf-of', 'delegation', 'OPENFGA_STORE_ID', 'authorization model', 'immutable model', 'bootstrap-openfga', 'rbac-model.json', 'add a role', 'add a permission', 'why is authz undefined', 'why 503 authz_unavailable'."
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

`rbac.md §6`. `register` → agent `POST /nodes/{id}/access-requests` (files a tracking row; owner sees it in the **Agents** UI) → owner `POST /nodes/{id}/developers {decision}` (writes/deletes the OpenFGA tuple — _the authority_; the row transition is best-effort) → `POST /vcs/flight` enforces `node.flight`. Two flight paths share the check: the **direct route** and the **`core__vcs_flight_candidate` graph tool** (gated as `tool.execute`).

> **Proof a grant actually works:** flight returns `403 authz_denied` _before_ approval and flips to a _downstream_ error (e.g. `catalog_missing` / preflight) _after_ — RBAC passed; the failure moved past it.

## Gotchas (hard-won, not in the spec)

- **`authorization` is `undefined` until `OPENFGA_STORE_ID` exists.** `container.ts` (~L842) builds the adapter only when `OPENFGA_API_URL` **and** `OPENFGA_STORE_ID` are both set — reachability ships before policy. **Prod + preview have no store today** → `/developers` returns `503 authz_unavailable` and flight falls back to the V0 owner-only check. The full RBAC loop is provable on **candidate-a** only, until the prod/preview substrate is bootstrapped.
- **`authz_unavailable` (503) ≠ `authz_denied` (403).** A timeout/outage is _unavailable_, not _denied_.
- **Models are immutable + hashed.** Editing `rbac-model.json` mints a new model version on next bootstrap; tuples reference relations _by name_, so **renaming a live relation (e.g. `developer`) is a migration, not an edit.** Add relations; don't rename live ones.
- **The model is principal-agnostic — `node.developer: [user, agent]` accepts both today.** V0 grants `user:{agent_user_id}` (agents register as users); an `agent:{actor_id}` form later is **additive** (new `@agent:` tuples — no model change, no tuple rewrite). Not debt, not split-brain. **Never narrow `developer` to `[user]`.**
- **Not every action is enforced yet.** `node.flight` + `tool.execute` are wired; `graph.invoke` and `connection.use` checks are still pending (see `proj.rbac-hardening.md`). **Don't assume a capability is gated — verify in the route** before relying on it.
- **Don't overload reserved identity terms.** `scope` → reserved for `scope_id` (governance); `actor` → reserved for `actor_id` (economic) + the `actorId` principal string. Principals are agent/user/service — which is why the access-request column is `role`, not `scope`.
- **Never read `node_access_requests` to authorize** — it's display/UX; the OpenFGA tuple is the authority.

## Where each surface lives

| Surface                                        | File                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Authz construction (and when it's `undefined`) | `nodes/operator/app/src/bootstrap/container.ts` (~L842)                                         |
| `node.flight` enforcement + V0 owner fallback  | `nodes/operator/app/src/app/api/v1/vcs/flight/route.ts`                                         |
| Owner tuple write/delete (approve/deny/revoke) | `nodes/operator/app/src/app/api/v1/nodes/[id]/developers/route.ts`                              |
| Agent access request                           | `nodes/operator/app/src/app/api/v1/nodes/[id]/access-requests/route.ts`                         |
| Tracking schema + query helpers                | `nodes/operator/app/src/shared/db/node-access-requests.ts`, `features/nodes/access-requests.ts` |
| OpenFGA adapter + deterministic fake           | `packages/authorization-core/src/adapters/`, `.../test/`                                        |
| Per-env store/model bootstrap                  | `scripts/ci/bootstrap-openfga.sh` (via `scripts/ci/deploy-infra.sh`)                            |
