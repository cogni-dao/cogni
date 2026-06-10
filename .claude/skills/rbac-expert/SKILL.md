---
name: rbac-expert
description: "Authorization/RBAC reference for cogni-template — how OpenFGA is the sole permission authority, the ReBAC model (types + relations + computed permissions), the AuthorizationPort contract + deny-by-default / fail-closed-with-distinction invariants, the core check + tuple-write workflows (tool.execute, node.flight direct route + graph tool, node access request→approve→flight), how the store/model are bootstrapped per env (immutable models, OPENFGA_STORE_ID gate), the access-request tracking schema (principal/role/capability split), and the Crawl/Walk/Run roadmap. Use when adding an authz check to a route/tool, designing a new protected action or role, debugging authz_denied vs authz_unavailable, deciding why authorization is undefined, writing or revoking a node access grant, touching packages/authorization-core / OpenFgaAuthorizationAdapter / infra/openfga/rbac-model.json / scripts/ci/bootstrap-openfga.sh / node_access_requests / POST /api/v1/nodes/{id}/{access-requests,developers} / POST /api/v1/vcs/flight, or evaluating any change that grants, checks, or delegates authority. Triggers: 'OpenFGA', 'RBAC', 'ReBAC', 'authorization', 'AuthorizationPort', 'authz check', 'node.flight', 'can_flight', 'developer role', 'access request', 'approve agent', 'grant access to a node', 'tuple write', 'writeRelation', 'authz_denied', 'authz_unavailable', 'deny by default', 'fail closed', 'subjectId', 'on-behalf-of', 'delegation', 'OPENFGA_STORE_ID', 'authorization model', 'immutable model', 'bootstrap-openfga', 'rbac-model.json', 'add a role', 'add a permission', 'why is authz undefined', 'why 503 authz_unavailable'."
---

# RBAC Expert

One-page reference for anyone touching authorization in cogni-template. Read this BEFORE the spec; it points at what to actually read.

## North star

[`docs/spec/rbac.md`](../../../docs/spec/rbac.md) is canon. [`docs/spec/identity-model.md`](../../../docs/spec/identity-model.md) governs the principals authz acts on. The shared contract + adapter live in [`packages/authorization-core`](../../../packages/authorization-core/src/index.ts). Roadmap + as-built status: [`work/projects/proj.rbac-hardening.md`](../../../work/projects/proj.rbac-hardening.md).

> **OpenFGA is the SOLE source of truth for permission + delegation.** ToolPolicy and grant-intersection are capability/safety gates that run _before_ OpenFGA — they answer "does this capability exist?", never "is this actor permitted?". Don't add a second authority (no per-service role tables; the `node_access_requests` row is tracking/UX only — see below).

## Load-bearing invariants — gate every authz decision

Canonical numbering is rbac.md "Core Invariants" 1–6; these are the ones that bite day to day.

| Rule                                                                                                                                                                                                | Where it bites                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **DENY_BY_DEFAULT** — no explicit relation ⇒ DENY. Never "allow if not denied".                                                                                                                     | New protected action starts denied until a tuple exists.                                         |
| **AUTHZ_FAIL_CLOSED_WITH_DISTINCTION** — infra failure ⇒ `deny`, with `authz_unavailable` (infra) vs `authz_denied` (OpenFGA said no). Never `allow` on failure.                                    | A timeout is `authz_unavailable` (503), NOT `authz_denied` (403). Masking the two hides outages. |
| **OPENFGA_IS_AUTHORITY** — only OpenFGA tuples grant/deny.                                                                                                                                          | Approval routes _write tuples_; everything else _reads_ them.                                    |
| **OBO_SUBJECT_MUST_BE_BOUND** — `subjectId` is set ONLY by trusted server launchers (session JWT, execution grant, scheduler), never from request body / tool args / `RunnableConfig.configurable`. | On-behalf-of impersonation-by-parameter is the attack this blocks.                               |
| **MODELS_ARE_IMMUTABLE** — OpenFGA authorization models can't be mutated; the bootstrap hashes the canonical JSON and reuses the model id when unchanged, writes a new one when the hash changes.   | "Editing" the model = authoring a new immutable version, not a patch.                            |
| **AUTHZ_CHECK_BEFORE_SIDE_EFFECT** — check runs before tool exec / token mint / dispatch, never after.                                                                                              | Checking after `broker.resolve` = token already materialized.                                    |

## The model — types, relations, computed permissions

Authored in [`infra/openfga/rbac-model.json`](../../../infra/openfga/rbac-model.json); DSL mirror in rbac.md §"Schema". Current types/relations:

| Type               | Relations                                            | Computed permission                                                 |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `user`             | `delegates: [agent]`                                 | —                                                                   |
| `agent`, `service` | (principals only)                                    | —                                                                   |
| `tenant`           | `admin: [user, service]`, `member: [user] or admin`  | —                                                                   |
| `node`             | `admin: [user]`, `developer: [user, agent] or admin` | **`can_flight: developer`**                                         |
| `graph`            | `owner: [user]`, `tenant: [tenant]`                  | `can_invoke: [user, agent, service] or owner or member from tenant` |
| `tool`             | `graph: [graph]` (parent)                            | `can_execute: [user, agent, service] or can_invoke from graph`      |
| `connection`       | `owner: [user]`, `tenant: [tenant]` (parent)         | `can_use: [user, agent, service] or owner or member from tenant`    |

**Role vs capability.** A _role_ is a directly-assignable relation (`developer`, `admin`, `member`, `owner`). A _capability_ is a computed relation (`can_flight`, `can_execute`, `can_invoke`, `can_use`). You **grant a role** (write a `developer` tuple); the engine **derives the capability** (`can_flight from developer`). Add an access level = add a role relation + the `can_X from <role>` it confers (new immutable model), then map it.

## Action → relation mapping

`relationForAuthzAction()` in `authorization-core` is the SSOT for check relations:

| Action (`AuthzAction`) | Resource          | Checked relation | Deny code      |
| ---------------------- | ----------------- | ---------------- | -------------- |
| `tool.execute`         | `tool:{id}`       | `can_execute`    | `authz_denied` |
| `connection.use`       | `connection:{id}` | `can_use`        | `authz_denied` |
| `graph.invoke`         | `graph:{id}`      | `can_invoke`     | `authz_denied` |
| `user.act_as`          | `user:{user_id}`  | `delegates`      | `authz_denied` |
| `node.flight`          | `node:{node_id}`  | `can_flight`     | `authz_denied` |

## The contract — `AuthorizationPort`

[`packages/authorization-core/src/index.ts`](../../../packages/authorization-core/src/index.ts). Three methods; everything else is helpers + the adapter/fake.

- `check({ actorId, subjectId?, action, resource, context })` → `AuthzDecision`. When `subjectId` present, **dual-check**: subject has permission AND actor `delegates` for subject (`user.act_as`). Either deny ⇒ reject. Returns `{ decision, code, checks[] }` — `code` ∈ `authz_allowed | authz_denied | authz_unavailable`.
- `writeRelation(tuple)` / `deleteRelation(tuple)` → `AuthzWriteDecision` (`authz_write_success | authz_write_unavailable`). This is how approval/revocation materialize.
- Principal strings (identity-model §Runtime Principals): `user:{user_id}` (browser session OR HMAC machine bearer — both resolve to `SessionUser.id`), `agent:{agent_id}` (server-issued grant, VNext), `service:{name}`. **`actorId` (the string) ≠ `actor_id` (the economic-subject DB column).** Don't conflate.

## How OpenFGA runs + bootstraps

rbac.md §"Runtime Deployment". OpenFGA is **shared VM runtime infra**, not a per-node k8s app.

- Compose runs `openfga-migrate` then `openfga` against the shared Postgres `openfga` DB (`infra/compose/runtime/docker-compose.yml`).
- `scripts/ci/deploy-infra.sh` → [`scripts/ci/bootstrap-openfga.sh`](../../../scripts/ci/bootstrap-openfga.sh): finds/creates store `cogni-<env>-rbac`, writes/reuses the immutable model from `rbac-model.json`, and records `OPENFGA_STORE_ID` + `OPENFGA_AUTHORIZATION_MODEL_ID` into `cogni/<env>/operator` for ESO delivery to the pod.
- **The `authorization` adapter is constructed ONLY when both `OPENFGA_API_URL` AND `OPENFGA_STORE_ID` are present** (`container.ts` ~L842). Reachability can ship before policy activation, so `getContainer().authorization` is `undefined` until the store is bootstrapped.

## Core workflows

### A. Check before a protected side effect (tools)

`toolRunner.exec()` order is cheapest-first: **ToolPolicy** (`policy_denied`) → **AuthorizationPort.check** (`authz_denied`/`authz_unavailable`) → **grant intersection** (`policy_denied`) → **broker.resolve** → exec. Authz runs after policy, before args/token. Denied tools emit a result-only `tool_call_result` error; the tool never runs.

### B. Node flight (two paths)

1. **Direct route** `POST /api/v1/vcs/flight` (`nodes/operator/app/src/app/api/v1/vcs/flight/route.ts`): auth (session or machine bearer) → resolve node via **service DB** (caller may be an approved external agent, not the RLS owner) → if `authorization` configured, `check({ action: 'node.flight', resource: 'node:{id}', context:{ tenantId: billing_account_id, nodeId } })` → only then preflight + dispatch `candidate-flight.yml`. **V0 fallback:** if `authorization` is `undefined`, legacy owner-only check (`nodes.owner_user_id === caller`).
2. **Graph tool** `core__vcs_flight_candidate`: runs through `toolRunner.exec()`, so it's gated by `tool.execute` on `tool:core__vcs_flight_candidate`.

### C. Node access request → approve → flight (the human-facing grant loop)

rbac.md §6 "Node Access Request Flow". This is the product surface (replaces the old browser-session cookie-curl hack).

1. Agent registers (`POST /api/v1/agent/register`) → user-backed bearer (`user:{agent_user_id}`).
2. Agent files a request: `POST /api/v1/nodes/{id}/access-requests { role? }` (`role` defaults to `developer`). Upserts one idempotent `node_access_requests` row → owner sees it in the node **Agents** section. **Tracking/UX only — never authority.**
3. Owner approves/denies in-UI: `POST /api/v1/nodes/{id}/developers { agentUserId, decision }` (owner-gated by registry ownership). Approve ⇒ `writeRelation(node:{id}#developer@user:{agent_user_id})` + row→`approved`; reject ⇒ `deleteRelation(...)` + row→`denied`/`revoked`. The row transition is **best-effort**; the tuple write is the authority.
4. Flight enforces `node.flight` (`can_flight from developer`).

Empirical proof of a working grant: a flight that returns `403 authz_denied` **before** approval and flips to a _downstream_ error (e.g. `catalog_missing` / preflight) **after** approval — RBAC passed, failure moved past it.

## Schema (Postgres) — `node_access_requests`

[`nodes/operator/app/src/shared/db/node-access-requests.ts`](../../../nodes/operator/app/src/shared/db/node-access-requests.ts) + helpers in `features/nodes/access-requests.ts`. One row per `(node_id, agent_user_id)`; columns: `role` (the OpenFGA relation requested; v0 CHECK `('developer')`), `status` (`pending|approved|denied|revoked`), timestamps. RLS-forced, **no app_user policy** — all access via the service-role DB after app-layer ownership/identity checks (`app_service` is BYPASSRLS). It mirrors OpenFGA for display; it is **not** read by any `check()`.

## Roadmap (Crawl → Walk → Run)

`proj.rbac-hardening.md`.

- **Crawl / P0 — DONE:** shared `AuthorizationPort` + OpenFGA adapter + fake; tool-exec check wired; direct `node.flight` route + `core__vcs_flight_candidate` tool covered; node access request→approve→flight surface; env + per-env store/model bootstrap.
- **Walk / P1 — NOT STARTED:** `graph.invoke` check at `GraphExecutorPort.runGraph()`; `connection.use` check in `ConnectionBroker.resolveForTool()` (token-mint gate); durable `authz.check` audit event + `authz.unavailable` metric; 5s LRU cache keyed `actor:subject:action:resource`; batch check for tool-catalog filtering; **scoped delegation** via a `delegation` type bound to `{tenant, graph}` (closes the P0 global-delegation hole).
- **Run / P2+:** delegation management UI, delegation scopes, time-bounded delegations.

## Gotchas + anti-patterns

- **Prod operator has no `OPENFGA_STORE_ID`** ⇒ `authorization` is `undefined` ⇒ `/developers` returns `503 authz_unavailable` and flight uses the owner-only fallback. The full RBAC loop is provable on **candidate-a** (OpenFGA bootstrapped there), not prod, until the prod substrate is bootstrapped.
- **`authz_unavailable` ≠ `authz_denied`.** 503 vs 403. Treating a timeout as denied masks an outage (violates FAIL_CLOSED_WITH_DISTINCTION).
- **Never overload reserved identity terms.** `scope`→ reserved for `scope_id` (governance); `actor`→ reserved for `actor_id` (economic subject) and the `actorId` principal string. UI/schema names for principals use **agent / user / service**, not "actor". (This is why the access table column is `role`, not `scope`.)
- **Models are immutable + hashed.** Editing `rbac-model.json` mints a new model version on next bootstrap; existing tuples reference relations by name, so renaming a relation (e.g. `developer`) is a migration, not an edit. Add relations; don't rename live ones.
- **Don't read `node_access_requests` to authorize.** It's display state. Authority is the OpenFGA `developer` tuple.
- **`subjectId` from a request body is a security bug.** Bind it server-side only.
- **The model is principal-agnostic — do not read "V0 user-backed" as debt.** `node.developer: [user, agent]` accepts both principal types **today** (verified in `rbac-model.json`), in every env it bootstraps to. V0 grants `user:{agent_user_id}` because external agents register as users; introducing `agent:{actor_id}` principals later is **additive** (write `@agent:` tuples — no model change, no tuple rewrite, no split-brain). Nothing encodes user-only, and prod/preview have no store or tuples yet, so nothing is locked. Keep it that way: never narrow `developer` to `[user]`.

## Pointers

| File / Resource                                                             | Why                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `docs/spec/rbac.md`                                                         | Canon: invariants, model, action→relation, §6 access flow, candidate-flight use case |
| `docs/spec/identity-model.md`                                               | Principals, `actorId` vs `actor_id`, V0→VNext agent migration                        |
| `packages/authorization-core/src/index.ts`                                  | `AuthorizationPort`, codes, `relationForAuthzAction`, resource helpers               |
| `packages/authorization-core/src/adapters/openfga-authorization.adapter.ts` | The OpenFGA adapter; `FakeAuthorizationAdapter` for tests                            |
| `infra/openfga/rbac-model.json`                                             | The authored (immutable) model                                                       |
| `scripts/ci/bootstrap-openfga.sh`                                           | Store/model bootstrap; writes `OPENFGA_STORE_ID` for ESO                             |
| `nodes/operator/app/src/bootstrap/container.ts` (~L842)                     | Where `authorization` is constructed (and when it's `undefined`)                     |
| `nodes/operator/app/src/app/api/v1/vcs/flight/route.ts`                     | `node.flight` enforcement + V0 owner fallback                                        |
| `nodes/operator/app/src/app/api/v1/nodes/[id]/developers/route.ts`          | Owner-gated tuple write/delete (approve/deny/revoke)                                 |
| `nodes/operator/app/src/app/api/v1/nodes/[id]/access-requests/route.ts`     | Agent files an access request                                                        |
| `work/projects/proj.rbac-hardening.md`                                      | Roadmap + as-built status                                                            |
| `docs/spec/access-control-charter.md`                                       | Layer-cake framing (Identity → AuthN → AuthZ → Secrets → DAO)                        |
