---
id: design.substrate-grafana-observability
type: design
title: "Grafana / Loki Substrate Access — RBAC-scoped logs across nodes, services, and environments"
status: draft
trust: draft
summary: Replace the node-only Loki proxy with a platform-style observability access plane: callers query logs through the operator, never receive Grafana tokens, and RBAC grants access to explicit node, service, environment, or network scopes backed by catalog/repo-spec identity.
owner: derekg1729
created: 2026-06-18
updated: 2026-06-18
tags: [observability, grafana, loki, rbac, substrate, node-identity]
spec_refs:
  - ../spec/identity-model.md
  - ../spec/ci-cd.md
  - ../spec/rbac.md
  - ../spec/grafana-observability-access.md
  - ../spec/substrate-access-grant.md
related:
  - ./openfga-substrate-unification.md
  - ./node-wizard-formation-wiring.md
  - ./secrets-catalog-per-node.md
---

# Grafana / Loki Substrate Access

## Decision

The operator's log-read surface must be a **platform observability access plane**, not a node-only helper route.

A caller sends a full LogQL log query to the operator. The operator authenticates the caller, evaluates RBAC against the **resources the query reaches**, runs the query server-side with its own Grafana/Loki credential, and returns log entries. The caller never receives a Grafana token.

Access is granted to explicit observability scopes:

| Scope       | Example resource           | What it permits                                                                   |
| ----------- | -------------------------- | --------------------------------------------------------------------------------- |
| Node        | `node:<repo-spec node_id>` | Logs attributable to that node across any service that carries the node identity. |
| Service     | `service:scheduler-worker` | Logs for one shared service, optionally narrowed by env.                          |
| Environment | `environment:candidate-a`  | Logs for all resources in one env.                                                |
| Network     | `observability:all`        | All logs across the operator-managed network. Operator/admin only.                |

This mirrors the pattern used by top platform products: access is attached to product resources such as project, deployment, environment, service, or team, and the logs UI/CLI/API sits behind that same permission model. Vercel exposes runtime logs at project/deployment level with environment/source/status filters and team/project roles; Railway's Environment RBAC makes logs, metrics, services, variables, and configs restricted resources inside an environment. Cogni's equivalent resource graph is node/service/environment/network.

## Non-negotiables

1. **No Grafana credential leaves the operator.** The proxy returns log results, never a token.
2. **Full LogQL parity is the target.** The route must not be a growing set of bespoke query parameters or hardcoded log routes.
3. **No app-only or node-only hardcoding.** `service="app"` may be an initial filter case, but not the access model.
4. **Repo-spec `node_id` is the node identity SSOT.** The operator DB may project it, index it, and join on it; it must not mint a second node identity.
5. **Catalog is deploy-shape, not node identity.** Catalog enumerates deployable services and environments; repo-spec owns node identity. For submodule/external nodes, catalog may carry a drift-gated `node_id` projection only because the parent cannot read the child repo-spec at render time.
6. **Every log stream must map to a resource.** If a stream cannot be classified as node/service/environment/network, it is operator-only until instrumentation is fixed.

## Current bug

The identity contract is **unstated**, not violated in live data — and an unstated contract is one bad insert away from a violation.

Existing contracts already say:

- `identity-model.md`: `node_id` is immutable deployment identity and lives in `.cogni/repo-spec.yaml`.
- `ci-cd.md`: `REPO_SPEC_IS_IDENTITY_SSOT`; catalog is deploy-shape, not identity.
- `scripts/ci/lib/image-tags.sh`: routing and billing derive `node_id` from repo-spec, with catalog only as a projection for submodule nodes.
- `getNodeId()` reads repo-spec `node_id` at runtime.

The operator `nodes` table has `id uuid().defaultRandom()` and **no** explicit `node_id` column. Several routes treat `nodes.id` as `{node_id}`:

- `POST /api/v1/nodes/{id}/developers` writes OpenFGA tuples to `node:{id}`.
- `POST /api/v1/vcs/flight` resolves `nodeRef.nodeId` against `nodes.id`.
- `GET /api/v1/nodes/{id}/observability/logs` resolves via `NodeRegistryPort`, whose DB adapter maps `NodeSummary.nodeId = row.id`.

**Crucial fact (verified):** there is exactly one insert path into `nodes` — the wizard `POST /api/v1/nodes` — and `publish` then mints the node's repo-spec identity _from_ that row's id (`identity.nodeId = node.id`). So for **every row that exists today, `nodes.id` already equals the repo-spec `node_id`.** Those route usages are therefore _correct_, not buggy — `node:<nodes.id>` already is `node:<repo-spec node_id>`, and the deploy plane's `prepareNodeRefCandidateFlight` proves it by re-reading the child repo-spec and throwing `node_id_mismatch` (422) on any disagreement.

The risk is not present data; it is the **absent contract**. Nothing in the schema or the type names says "`nodes.id` _is_ the repo-spec `node_id`," so a future external/imported-node insert that mints `id` with `defaultRandom()` while the child repo carries its own `node_id` would silently fork identity — wrong OpenFGA resource, empty Loki joins. The fix is to **make the contract explicit and structural**, not to add a parallel identity column.

| Meaning                  | Value                      | Status today                                    |
| ------------------------ | -------------------------- | ----------------------------------------------- |
| Public node identity     | repo-spec `node_id` (UUID) | `= nodes.id` for every row (wizard-minted)      |
| Public addressing handle | `slug`                     | `nodes.slug` (unique)                           |
| OpenFGA resource         | `node:<node_id>`           | correct (`node:<nodes.id>` == `node:<node_id>`) |
| Loki node label          | `node="<node_id>"`         | correct (app stamps repo-spec `node_id`)        |

The job is to **ratify `nodes.id` as the operator's projection of repo-spec `node_id`** so it can never fork, and to make the read surface ergonomic (slug) and the log proxy first-class (full LogQL).

## Target resource model

Observability is a substrate with its own resource graph:

```text
observability:all
  └── environment:<env>
        ├── service:<service_id>
        │     └── stream labels: env=<env>, service=<service_id>
        └── node:<node_id>
              └── stream labels: env=<env>, node=<node_id>
```

`node:<node_id>` and `service:<service_id>` are peer scopes. A node developer is not automatically entitled to every shared service; they are entitled to node-attributable lines. An operator or service owner may be entitled to shared service logs.

### Resource IDs

| Resource               | ID source                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `node:<node_id>`       | repo-spec `.cogni/repo-spec.yaml::node_id`, projected into operator DB.                 |
| `service:<service_id>` | catalog service name for deployable services; fixed substrate names for infra services. |
| `environment:<env>`    | canonical deploy env enum.                                                              |
| `observability:all`    | singleton network-wide resource.                                                        |

The operator's `nodes` row IS the node read model. There is no separate `registry_row_id`:
**`nodes.id` is the operator's projection of repo-spec `node_id`** (one immutable UUID, keyed to
the deployment-identity SSOT — consistent with `identity-model.md`'s "projection, never a second
authority"). `slug` is the human/agent addressing handle. `service_id`/`env` resource rows come from
the catalog and the deploy-env enum, not from `nodes`.

## RBAC model

Add explicit observability actions instead of reusing `node.flight`.

```text
logs.query       read log lines
logs.share       create/share a saved query link, if built
logs.admin       bypass normal scope constraints, operator only
```

OpenFGA-style resources:

```text
type observability
  relations
    define admin: [user, service]
    define can_query_all: admin

type environment
  relations
    define admin: [user, service]
    define observer: [user, agent, service] or admin
    define can_query_logs: observer

type service
  relations
    define admin: [user, service]
    define observer: [user, agent, service] or admin
    define environment: [environment]
    define can_query_logs: observer or can_query_logs from environment

type node
  relations
    define admin: [user]
    define developer: [user, agent] or admin
    define log_reader: [user, agent, service] or developer
    define can_query_logs: log_reader
```

Action mapping:

| Action       | Resource               | Check            |
| ------------ | ---------------------- | ---------------- |
| `logs.query` | `node:<node_id>`       | `can_query_logs` |
| `logs.query` | `service:<service_id>` | `can_query_logs` |
| `logs.query` | `environment:<env>`    | `can_query_logs` |
| `logs.query` | `observability:all`    | `can_query_all`  |

Policy rule: a query is allowed only when every selected stream is within at least one granted scope. If the query selector is broader than the caller's grants, the server either intersects it with the allowed label set or rejects it. MVP should reject ambiguous/broader queries unless a safe rewrite is straightforward.

## Query API

Replace the node-only route with a generic route:

```text
GET /api/v1/observability/logs?env=<env>&query=<LogQL>&start=&end=&limit=&direction=
```

The current node route may remain as a compatibility wrapper only if it delegates to the generic route with a constructed query. It must not be the implementation center.

### Request contract

| Field       | Requirement                                                                              |
| ----------- | ---------------------------------------------------------------------------------------- |
| `env`       | Required until multi-env query support is designed.                                      |
| `query`     | Full LogQL log query. Metric queries are out of scope for v1 unless explicitly admitted. |
| `start/end` | Optional range bounds; defaults are server-owned and bounded.                            |
| `limit`     | Bounded by server max.                                                                   |
| `direction` | `backward` or `forward`.                                                                 |

### Query evaluation

The route must:

1. Parse LogQL enough to extract every stream selector and label matcher.
2. Reject unsupported query types if safe rewriting cannot be proven.
3. Resolve selector reach to observability resources:
   - `node="<uuid>"` maps to `node:<uuid>`.
   - `service="<id>"` maps to `service:<id>`.
   - `env="<env>"` maps to `environment:<env>`.
   - selectors without a resource-bearing label are network-wide and require `observability:all`.
4. Check RBAC for the resolved resources.
5. Intersect the query with server-owned constraints where safe, or reject if it cannot preserve semantics.
6. Run the query server-side against Loki/Grafana.
7. Return entries plus the effective query and authorization scope summary.

Do not hand-roll an ever-growing LogQL parser if an OSS parser or Loki-native tenant boundary can do the job. For the Grafana Cloud stopgap, a minimal parser may be acceptable only for log queries and only with a tight unsupported-query rejection path.

## Stream labeling contract

The access plane only works if labels identify resources consistently.

Required low-cardinality stream labels:

| Label     | Meaning                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------- |
| `env`     | `candidate-a`, `preview`, `production`, etc.                                                      |
| `service` | stable service/catalog identifier: `app`, `scheduler-worker`, `litellm`, `openfga`, `caddy`, etc. |
| `node`    | repo-spec `node_id` when a line is attributable to one node.                                      |
| `source`  | ingestion source, e.g. `docker`, `k8s`, `ci`, where useful.                                       |

Rules:

- Node app logs must carry `node=<repo-spec node_id>`.
- Node-aware shared services must bind `node` before their logs become available to node developers.
- Shared infra logs with no node attribution are service/environment/network scoped only.
- A stream missing `service` or `env` is ingestion-broken and operator-only.

## Grafana Cloud stopgap

In the current Grafana Cloud setup, the operator can proxy `query_range` using its own service account token. This is acceptable if:

- the token is never returned;
- the query is authorized before execution;
- upstream errors never echo credentials;
- limits/timeouts are server-bounded;
- all returned logs are from authorized scopes.

This stopgap will require query parsing/rewrite because Grafana Cloud does not know Cogni's OpenFGA graph.

## OSS Loki target

The cleaner target is self-hosted OSS Loki with an operator-owned auth gateway. Use Loki's tenant header (`X-Scope-OrgID`) where it removes query rewriting risk.

Likely tenant shapes:

| Tenant                 | Use                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `env:<env>`            | env-wide operator/debug access.                                                        |
| `node:<node_id>`       | node developer access when every node-attributable line is written to the node tenant. |
| `service:<service_id>` | service-owner access for shared services.                                              |

If a log line must be queryable through multiple scopes (for example node and env), prefer multi-write or a gateway that fans out authorized tenant queries over trusting caller-supplied label filters. The goal is to move reach enforcement down into Loki/gateway tenancy, not keep string surgery in route handlers forever.

## Platform comparison

High-quality platforms do not expose raw observability backend credentials to normal developers. They model logs as a product surface inside the same resource hierarchy used for deploys and secrets.

| Platform pattern                                                       | Cogni translation                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Team/workspace roles plus project-level roles.                         | `observability:all`, `environment:<env>`, `node:<node_id>`, `service:<id>` resources. |
| Runtime logs are project/deployment scoped, with filters.              | Full LogQL behind RBAC, scoped by node/service/env/network.                           |
| Environments can restrict logs, metrics, services, variables, configs. | `environment:<env>#observer/admin` gates logs and later metrics/secrets/config views. |
| Agents/CLI use the same permission model as the dashboard.             | API, UI, MCP, and agents call the same operator route and OpenFGA checks.             |

## Phasing

### Phase 0 — ratify node identity + make the node log proxy first-class

The only phase in scope for the first PR. It does **not** add the generic
`/api/v1/observability/logs` route, multi-scope (service/env/network) access, or any new RBAC action.
It does two things: (1) make "`nodes.id` is the repo-spec `node_id`" an explicit, structural contract
so it can never fork; (2) upgrade the existing node-scoped log proxy from a bespoke pipeline-only
`filter=` dialect to the **same full LogQL** an agent already writes against `loki-query.sh` / the MCP.

#### Identity: ratify, do not add a column (Option B)

`nodes.id` already equals the repo-spec `node_id` for every row (see Current bug). So **define it that
way** rather than introducing a parallel `node_id` column that only ever holds the PK's value:

- **No schema change to identity.** `nodes.id` is the operator's projection of repo-spec `node_id`.
- **Ratify the contract where it's enforced + read:**
  - `identity-model.md` § Spec File Layering / projection: add a one-line invariant —
    `OPERATOR_NODE_ROW_ID_IS_NODE_ID`: the operator `nodes.id` is the projection of the node's repo-spec
    `node_id`; for an externally-formed node the operator inserts the child's `node_id` as the row PK,
    never a fresh `defaultRandom()`. The repo-spec stays authoritative; the row mirrors it under the
    same id.
  - `shared/db/nodes.ts` header: state the invariant + that wizard creation's `defaultRandom()` _is_
    the act of minting the node_id (the value `publish` writes into the repo-spec).
- **No backfill, no migration, no second-id resolution.** Existing OpenFGA tuples (`node:<id>`), the
  Loki `node` label, the deploy plane's `node_id_mismatch` guard, and `NodeSummary.nodeId = row.id` are
  all already correct under this definition.
- **Why not a column:** a separate `node_id` whose only job is to equal `id` institutionalizes the
  split-brain instead of closing it, and earns a migration + backfill + dual-UUID resolver for zero
  divergence. The one place divergence could enter — a future external-import insert — is closed by the
  invariant above (insert `id = child node_id`), not by a column.

#### Addressing: slug is the handle, UUID is the authority

| Layer             | Key                           | Used for                                                         |
| ----------------- | ----------------------------- | ---------------------------------------------------------------- |
| Public addressing | `slug` (`beacon`)             | API path `{id}`, UI, what a human/AI types                       |
| Authority / wire  | `node_id` UUID (= `nodes.id`) | OpenFGA `node:<uuid>`, Loki `node="<uuid>"`, deploy-plane checks |

`slug` is not the authority (unique but not guaranteed immutable; no rename gate exists today but none
is promised). So: **address by slug, authorize and join by UUID.** Add one shared
`resolveNodeIdentity(idOrSlug) → { id, slug } | null` helper (matches on `nodes.id` **or** `nodes.slug`)
and route the node `{id}` paths through it, so every endpoint accepts both forms consistently and the
UUID is what reaches OpenFGA + Loki. `observability-logs` and `flight-status` already do
`n.nodeId === id || n.slug === id`; this generalizes that to developers / access-requests / flight.

#### Log proxy: full LogQL, not a pipeline-only dialect (parity option 1)

Replace the node proxy's `?filter=<pipeline>` with `?query=<full LogQL>` — the **identical string** a
dev writes for `loki-query.sh` / the MCP. The operator does not _construct_ the selector; it
**authorizes the query's reach**:

1. Parse the LogQL **stream selector** (labels only — not a full pipeline parser).
2. Enforce node scope on the selector, rejecting anything it cannot safely contain:
   - `node`: must be absent or equal the caller's resolved `node_id`; the operator pins it to the
     caller's `node_id` either way (so `{service="app"} | json | level="error"` and
     `{service="app",node="<uuid>"} | …` both resolve to the caller's node).
   - `service`: must be within the node-attributable allowlist (Phase 0: `app`); reject otherwise.
   - `env`: must equal the `env` arg.
   - any selector that would reach beyond the node (e.g. a different `node`, a non-allowlisted
     `service`, or a bare `{env=…}`) → `400 query_out_of_scope` with the offending label.
3. Run the rewritten/validated query server-side with the operator's token; return **raw Loki lines**
   (same output shape as `loki-query.sh`), plus the effective query.

This is 1:1 with the MCP/`loki-query.sh` _language and output_ for the node's slice — same selector
syntax, same `| json | …` pipeline, same JSON lines — the only difference is the operator runs it
under an OpenFGA check instead of handing over a Grafana token. No bespoke param, no lesser dialect.
The selector parser is deliberately tiny (label matchers on one selector); the "do not hand-roll an
ever-growing LogQL parser" caution applies to the **Phase 1 multi-scope** route, not this label gate.

`buildNodeScopedLogQL` (`features/nodes/observability-logs.ts`) flips from _building_ a selector to
_validating + pinning_ the caller's selector; the route swaps `filter` → `query` and maps the new
`ObservabilityQueryError` codes (`query_out_of_scope`, `invalid_query`) to `400`.

#### Per-site changes

- `identity-model.md` + `shared/db/nodes.ts` header — ratify `OPERATOR_NODE_ROW_ID_IS_NODE_ID`.
- new `resolveNodeIdentity(idOrSlug)` helper (slug **or** UUID) — used by developers / access-requests
  / flight; the two registry-backed routes already resolve both forms.
- `features/nodes/observability-logs.ts` — `buildNodeScopedLogQL` → parse + scope-validate + pin a full
  LogQL selector; add `query_out_of_scope` / `invalid_query` error codes.
- `nodes/[id]/observability/logs/route.ts` — accept `?query=` (the full LogQL), drop `?filter=`; map the
  new error codes to `400`.
- **No** change to `developers`/`flight` OpenFGA resource strings or the registry adapter — they are
  already `node:<nodes.id>` == `node:<node_id>`; only their `{id}` resolution gains slug support.

#### What becomes E2E-achievable at the end of Phase 0

A node dev (any node — wizard-born or a future external import, since identity can no longer fork):

1. `POST /api/v1/nodes/{slug}/access-requests` (role `developer`) — addressed by the friendly slug;
2. owner approves via `POST /api/v1/nodes/{slug}/developers` → OpenFGA tuple on `node:<node_id>`;
3. dev runs the **same LogQL they'd paste into `loki-query.sh`** through the proxy:

   ```bash
   curl -H "Authorization: Bearer $COGNI_API_KEY" \
     "$OP/api/v1/nodes/beacon/observability/logs?env=production&query=$(jq -rn --arg q \
       '{service="app"} | json | level="error"' '$q|@uri')"
   ```

   and gets back Beacon's error lines as raw Loki JSON — no Grafana token, scope enforced server-side.
   It reads and behaves like the operator-scope MCP/`loki-query.sh` path, not a node-wizard helper.

**Parity boundary (crisp):** the proxy now has full LogQL language + output parity with
`loki-query.sh`/MCP **for the caller's node slice** (`service` ∈ allowlist, `node` pinned). It is
**not** yet multi-scope — querying _other_ nodes, shared services, or env-wide is the **Phase 1**
generic `/api/v1/observability/logs` route with the `logs.query` RBAC action. `logs.md` is updated now
to route node devs to this first-class proxy; the "all agents drop the MCP" switch lands with Phase 1.

#### Credential wiring — as-built, verified on candidate-a (2026-06-18)

The proxy returns `503 observability_unwired` until the operator pod holds `GRAFANA_URL` +
`GRAFANA_SERVICE_ACCOUNT_TOKEN`. The verified delivery path (no overlay change on any env):

- **Custody = operator service path, not `_shared`.** The operator's ExternalSecret already pulls
  `extract: key: <env>/operator`; nothing pulls `_shared` as a k8s bank, and the only OpenBao consumer
  of these creds is the operator pod (`loki-query.sh` / `grafana-postgres-datasource.sh` read a local
  `.env`). So the creds live at **`cogni/<env>/operator/{GRAFANA_URL,GRAFANA_SERVICE_ACCOUNT_TOKEN}`**
  and the catalog classifies them `service: operator`. The token must be a Grafana **stack `glsa_`**
  SA token with `datasources:query`; `GRAFANA_URL` has no trailing slash.
- **To light up any env:** `pnpm secrets:set <env> operator GRAFANA_URL` + `… GRAFANA_SERVICE_ACCOUNT_TOKEN`,
  force-sync `operator-env-secrets`; Reloader rolls the operator pod. **No manifest/overlay change** —
  this is why merge→promote→`secrets:set production operator …` lights up prod with nothing else.
- **Verified on candidate-a:** creds written to `cogni/candidate-a/operator`, ESO synced, operator pod
  confirmed holding both env vars, and the operator queried candidate-a Loki via the exact reader path
  (`/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/query_range`) → **HTTP 200, real app log
  lines**. The full proxy chain (auth → registry → `node.flight` → scope → reader) additionally needs an
  **active registered node** in the env's operator `nodes` table; candidate-a has none today, so the
  end-user line-return is proven on prod (Beacon registered) or via a throwaway registered node — the
  RBAC/scope/identity logic is covered by unit + contract tests.

### Phase 1 — generic Grafana Cloud proxy

- Add `GET /api/v1/observability/logs`.
- Add explicit `logs.query` RBAC action mapping.
- Build an allow/reject LogQL parser for log queries.
- Support node, service, environment, and network scopes.
- Keep the old node route as a wrapper if needed.

### Phase 2 — label coverage

- Audit every log stream for `env` and `service`.
- Bind `node` in node-aware shared services, starting with `scheduler-worker`.
- Mark unattributable infra streams as service/environment scoped only.

### Phase 3 — OSS Loki gateway

- Deploy self-hosted Loki or a Loki auth gateway.
- Enforce tenant reach with `X-Scope-OrgID` wherever possible.
- Reduce or delete query rewrite logic.

## Open questions

- Which actors should get env-wide production log access by default: operator admins only, or production promoters too?
- Do service observers exist as a separate role, or is service access operator-only until there are service-owning teams?
- Should the generic route support metric LogQL queries, or logs only for v1?
- Do we multi-write logs to node/service/env tenants in OSS Loki, or keep a single env tenant plus an auth gateway?

## External references

- Vercel Runtime Logs: https://vercel.com/docs/logs/runtime
- Vercel Access Roles: https://vercel.com/docs/rbac/access-roles
- Vercel CLI logs: https://vercel.com/docs/cli/logs
- Railway Environment RBAC: https://docs.railway.com/enterprise/environment-rbac
- Railway Projects: https://docs.railway.com/projects
- Loki log queries: https://grafana.com/docs/loki/latest/query/log_queries/
- Loki HTTP API: https://grafana.com/docs/loki/latest/reference/loki-http-api/
