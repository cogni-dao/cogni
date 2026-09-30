---
id: spec.multi-node-tenancy
type: spec
title: "Multi-Node Tenancy: Auth, Data Isolation, and Metering"
status: active
spec_state: proposed
trust: draft
summary: "Defines trust boundaries for multi-node deployments: shared identity with per-node sessions, DB-per-node isolation, node-local metering as authoritative source, and read-only inter-node communication."
read_when: Working on auth across nodes, per-node database provisioning, billing/metering aggregation, or inter-node API contracts.
implements: []
owner: derekg1729
created: 2026-04-01
verified: 2026-04-19
tags: [multi-node, auth, tenancy, data-isolation, metering]
---

# Multi-Node Tenancy: Auth, Data Isolation, and Metering

## Goal

Define trust boundaries for multi-node deployments across three concerns: authentication, data isolation, and metering/billing.

## Design

> [!CRITICAL]
> Shared identity, isolated sessions. DB-per-node, not tenancy columns. Node-local metering is authoritative; operator aggregation is derived.

## Context

Cogni runs multiple sovereign nodes (operator, poly, resy) on shared infrastructure. Each node is a full-platform Next.js app with its own domain, its own database, and its own billing. The operator provides shared identity and optional aggregation services.

### Current state (V0 — dev only)

- Single Postgres database `cogni_template_dev` shared by all nodes
- Single `AUTH_SECRET` shared across all apps
- 4 identical `auth.ts` files (operator, poly, resy, node-template)
- Cookie sharing on `localhost` across ports (:3000, :3100, :3300)
- Single LiteLLM proxy with one callback endpoint

### Key references

| Spec                                                  | Relevance                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| [Database RLS](./database-rls.md)                     | RLS policy mechanics — applies within each node's DB           |
| [Identity Model](./identity-model.md)                 | Identity primitive taxonomy — `user_id` is portable cross-node |
| [Node Operator Contract](./node-operator-contract.md) | DATA_SOVEREIGNTY, NO_CROSS_IMPORTS, WALLET_CUSTODY             |
| [Node Launch](./node-launch.md)                       | `provisionDatabase` step in node creation workflow             |
| [System Tenant](./system-tenant.md)                   | `cogni_system` account lives in operator's DB                  |
| [Billing Ingest](./billing-ingest.md)                 | LiteLLM callback pipeline — per-node routing = task.0256       |

---

## Non-Goals

- Runtime plugin system (nodes are separate Next.js apps, not dynamically loaded modules)
- Per-node Postgres servers **as the default shape**. The default stays one shared server per
  environment with one database per node. A _graduated_ node (see `NODE_GRADUATION_ON_THRESHOLD`)
  moving to dedicated capacity is explicitly IN scope — it is the sanctioned exception, not the norm.
  _(Amended 2026-09-30, bug.5299/bug.5293: the original blanket non-goal was written before any node
  crossed the critical/noisy threshold. poly has.)_
- Federation protocol design (V3 concern, not this spec)
- Operator repo extraction (ROADMAP Phase 6, gated on paying customer)

## Invariants

All invariants are detailed in their respective sections below. Summary:

| Invariant                         | Section                  |
| --------------------------------- | ------------------------ |
| SHARED_IDENTITY_ISOLATED_SESSIONS | Auth Model               |
| ORIGIN_SCOPED_COOKIES             | Auth Model               |
| SSO_THEN_LOCAL_SESSION            | Auth Model               |
| ENV_IS_A_FAILURE_DOMAIN           | Data Isolation           |
| MUTUAL_NONINTERFERENCE            | Data Isolation           |
| NODE_GRADUATION_ON_THRESHOLD      | Data Isolation           |
| SUBSTRATE_COST_DECLARED_AT_BIRTH  | Data Isolation           |
| DB_PER_NODE                       | Data Isolation           |
| DB_IS_BOUNDARY                    | Data Isolation           |
| NODE_LOCAL_METERING_PRIMARY       | Data Isolation           |
| NO_CROSS_NODE_QUERIES             | Data Isolation           |
| OPERATOR_AGGREGATES_ARE_DERIVED   | Data Isolation           |
| MISSING_NODE_ID_DEFAULTS_OPERATOR | Data Isolation           |
| CALLBACK_IS_ADAPTER_GLUE          | Data Isolation           |
| RUN_VISIBILITY_FOLLOWS_ORIGIN     | Data Isolation           |
| SHARED_COMPUTE_HOLDS_NO_DB_CREDS  | Data Isolation           |
| QUEUE_PER_NODE_ISOLATION          | Data Isolation           |
| NO_CROSS_IMPORTS                  | Inter-Node Communication |
| NODE_TO_OPERATOR_READ_ONLY        | Inter-Node Communication |
| OPERATOR_READS_NODE_VIA_VCS       | Inter-Node Communication |

---

## Auth Model

### Auth invariants

| Invariant                         | Rule                                                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHARED_IDENTITY_ISOLATED_SESSIONS | One identity provider (operator), per-node app sessions. A user signs in once via the operator IdP; each node mints and verifies its own local session.                                                                                   |
| ORIGIN_SCOPED_COOKIES             | No parent-domain (`.cognidao.org`) session cookie. Each node's session cookie is scoped to its own origin (`poly.cognidao.org`, `resy.cognidao.org`). OWASP: parent-domain cookies expose all subdomains to cross-subdomain session risk. |
| SSO_THEN_LOCAL_SESSION            | After IdP verification, the node creates a local JWT/session. The node never trusts a cookie from another origin.                                                                                                                         |

### Architecture: three realms

**Operator realm** — shared identity provider, shared `user_bindings` database, user account management. The operator is the IdP.

**Node realm** — local authorization, local RLS, local metering. Each node mints its own session after the operator IdP confirms identity. The node's session cookie is origin-scoped and never shared.

**Federation realm** (future) — sovereign nodes can trust the same IdP, a different IdP, or none at all. Trust relationships between nodes are explicit contracts, not shared sessions. Session model does not collapse when a node forks.

### As-built gap analysis

| Aspect            | V0 (before task.0256)                                    | V1 (task.0256 — dev)                        | V1 (production — task.0248)                  |
| ----------------- | -------------------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| Auth config       | 4 identical `auth.ts` files doing full NextAuth per-node | Same (functional for dev)                   | Operator = IdP, nodes = SSO relying parties  |
| Session sharing   | Implicit via `localhost` cookie sharing                  | **Built:** per-port origin-scoped cookies   | Per-domain origin-scoped cookies             |
| AUTH_SECRET       | Single shared secret                                     | **Built:** per-node secrets via dev scripts | Per-node secrets; operator IdP has its own   |
| SIWE verification | Domain-bound to `NEXTAUTH_URL.host`                      | Same (dev uses localhost)                   | Verify against domain in signed SIWE message |
| OAuth callbacks   | Per-port in dev (`localhost:3100/api/auth/callback`)     | Same (functional for dev)                   | Per-domain registration with providers       |

### Production multi-domain requirements

- **SIWE:** Verify against the domain field in the signed SIWE message itself, not a hardcoded `NEXTAUTH_URL.host`. Each node signs for its own domain.
- **OAuth:** Per-node callback URLs registered with providers (GitHub, Discord, Google). Alternative: redirect proxy on operator that dispatches to correct node.
- **Cookies:** Origin-scoped per node. `poly.cognidao.org` cookie is never sent to `resy.cognidao.org`. No `Domain=.cognidao.org` attribute.

---

## Data Isolation Model

### Data invariants

| Invariant                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENV_IS_A_FAILURE_DOMAIN           | **production, preview and candidate-a MUST NOT share a database failure domain.** A lane's databases, provisioning jobs and workloads live on that lane's own host. A non-production lane must be structurally unable to consume production's connections, disk, I/O or page cache. Violated as-built: production hosts 13 databases including every node's `_candidate_a` and `_preview` lane, because the fleet control env custodies all lanes (bug.5206/task.5132). Restoring this is the FIRST correction (bug.5299) and it covers **all** nodes, not only the noisiest.      |
| MUTUAL_NONINTERFERENCE            | **A node must not be able to crash the operator, and the operator must not be able to crash a node.** Shared substrate is permitted; a shared _blast radius_ is not. Proven violated 2026-09-30: poly's workload on the shared production Postgres coincided with ~73 postmaster crash-recoveries/24h, each taking every operator route to 502 — and the same crashes broke poly. Mitigate by bounding the shared resource, never by degrading a node's mission (do not delete a node's data, disable its production function, or hand-tune engine settings to throttle it).       |
| NODE_GRADUATION_ON_THRESHOLD      | A node that crosses the critical/noisy threshold **graduates to dedicated database capacity**; it is not throttled in place. The threshold is a declared, measured trigger (relative share of host memory/IO, sustained temp-file spill, connection share, or designation as mission-critical) — not a judgement call in an incident. Graduation REQUIRES a proven backup **and a proven restore** before cutover. First graduate: poly production (measured 2026-09-30 at 4.3 GB in one table ≈ 73% of a 5.9 GB host, ~20 GB block reads and 487 MB temp spill per stats window). |
| SUBSTRATE_COST_DECLARED_AT_BIRTH  | A node's substrate cost must be **declared and bounded when the node is born** — connection ceiling, statement/idle timeouts, and a data-retention policy for append-only tables. Birth currently provisions unbounded databases, connections and disk with no quota, no retention and no per-node visibility, so cost scales `O(nodes × lanes)` against fixed capacity. Unbounded-by-default is the defect that makes every future spawn a latent incident.                                                                                                                       |
| DB_PER_NODE                       | 1 Postgres server per environment, 1 database per node. Each node has its own database, its own migrations, its own schema version. Per-environment, not per-fleet (see `ENV_IS_A_FAILURE_DOMAIN`); the shared-server default yields to `NODE_GRADUATION_ON_THRESHOLD` for a graduated node.                                                                                                                                                                                                                                                                                       |
| DB_IS_BOUNDARY                    | The database itself is the node boundary. No `node_id` columns needed in node-local tables — the DB already scopes to this node. User/account-scoped RLS within the node is still legitimate and expected.                                                                                                                                                                                                                                                                                                                                                                         |
| NODE_LOCAL_METERING_PRIMARY       | Each node's local billing/metering data is authoritative. Operator aggregation is derived, never the source of truth. If operator aggregate diverges from node-local, **node-local wins**.                                                                                                                                                                                                                                                                                                                                                                                         |
| MISSING_NODE_ID_DEFAULTS_OPERATOR | If `node_id` is absent from callback metadata (e.g., direct LiteLLM call, legacy client), the custom callback defaults to the operator node and logs a warning. This prevents silent data loss while making misrouted callbacks detectable.                                                                                                                                                                                                                                                                                                                                        |
| CALLBACK_IS_ADAPTER_GLUE          | The LiteLLM custom callback class (`cogni_callbacks.py`) is adapter glue only: extract routing metadata, validate it, forward the canonical callback POST, fail loudly. No pricing logic, no policy logic, no reconciliation logic.                                                                                                                                                                                                                                                                                                                                                |
| NO_CROSS_NODE_QUERIES             | Nodes never query each other's database. The operator never queries a node's database directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| OPERATOR_AGGREGATES_ARE_DERIVED   | Cross-node views are read-only projections from node-local data, not independent records. They may lag, they may be incomplete, they are never primary.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| RUN_VISIBILITY_FOLLOWS_ORIGIN     | A graph run originated on node X is persisted in node X's database and is never retrievable from another node's API, regardless of bearer origin. Run-record placement is the source of truth; there is no cross-node filter/scope.                                                                                                                                                                                                                                                                                                                                                |
| SHARED_COMPUTE_HOLDS_NO_DB_CREDS  | Shared compute services (scheduler-worker, future attribution/ledger workers) hold no per-node DB credentials. All node-owned state is mutated through the owning node's internal HTTP API (SCHEDULER_API_TOKEN-authenticated). Data-plane isolation follows from data placement, not from application-level filtering.                                                                                                                                                                                                                                                            |
| QUEUE_PER_NODE_ISOLATION          | Each node submits Temporal workflows to a per-node task queue (`${TEMPORAL_TASK_QUEUE}-${nodeId}`). The shared scheduler-worker pod runs one Temporal Worker per node, polling each queue independently. A flapping or offline node grows its own queue without starving healthy nodes. Worker boot depends only on Temporal reachability; per-node HTTP reachability is a metric (`scheduler_worker_node_reachable_at_boot`), not a gate.                                                                                                                                         |

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Shared Postgres Server (1 instance, cost-efficient) │
│                                                       │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────┐ │
│  │ operator_db  │  │  poly_db   │  │  resy_db     │ │
│  │              │  │            │  │              │ │
│  │ - users      │  │ - users    │  │ - users      │ │
│  │ - billing    │  │ - billing  │  │ - billing    │ │
│  │ - ai_threads │  │ - ai_...   │  │ - ai_...     │ │
│  │ - aggregation│  │            │  │              │ │
│  │   (derived)  │  │            │  │              │ │
│  └──────────────┘  └────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────┘
```

- **Node-scoped DB, user/account-scoped RLS within that DB.** Multiple users and billing accounts exist per node. RLS (per [Database RLS spec](./database-rls.md)) isolates them from each other within the node's database.
- **Operator DB** contains operator-specific tables (node registry, derived aggregation views, system tenant account). It does not contain copies of node data.

### As-built gap analysis

| Aspect          | V0 (before task.0256)                           | Current (task.0256 — built)                                                                            |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Database        | Single `cogni_template_dev` shared by all nodes | **Built:** `cogni_operator`, `cogni_poly`, `cogni_resy` via `provision.sh` + `COGNI_NODE_DBS`          |
| `DATABASE_URL`  | Same connection string for all nodes            | **Built:** per-node env in dev scripts (`DATABASE_URL_POLY`, `DATABASE_URL_RESY`)                      |
| Provisioning    | Manual                                          | **Built:** `pnpm db:setup:nodes` provisions + migrates + seeds all 3 DBs                               |
| Schema          | Single shared schema                            | **Built:** per-node schema via `db:migrate:nodes` (same base, will diverge over time)                  |
| Billing routing | Single `GENERIC_LOGGER_ENDPOINT` to operator    | **Built:** custom LiteLLM callback (`CogniNodeRouter`) routes per `node_id` via `COGNI_NODE_ENDPOINTS` |
| Seed data       | Single DB seeded with governance + credits      | **Built:** system tenant via migration; `db:seed-money:nodes` tops up all 3 DBs                        |

### Operator aggregation plane

The operator needs cross-node cost visibility for gateway metering (proj.operator-plane v0). This is an **aggregation plane**, not a primary data store.

**Principles:**

- The aggregation plane is **derived** (NODE_LOCAL_METERING_PRIMARY)
- Data flows **from** node DBs **to** operator aggregation, never the reverse
- Populated by:
  - LiteLLM callback routing that identifies source node (task.0256)
  - Periodic sync/ETL from node DBs (future, respects DATA_SOVEREIGNTY)
- **NOT** by adding `node_id` columns to every node's `charge_receipts`
- Aggregate records **must** retain a source receipt ref (`source_node_id` + `source_receipt_id` or `source_litellm_call_id`) back to the node-local record, enabling reconciliation

---

## Inter-Node Communication

### Communication invariants

| Invariant                   | Rule                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NO_CROSS_IMPORTS            | Compile-time: no import paths between `nodes/poly/**` and `nodes/resy/**`, or between `nodes/**` and `apps/**`/`services/**`. Enforced by dep-cruiser.                                                     |
| NODE_TO_OPERATOR_READ_ONLY  | Node → Operator runtime calls are **read-only by default**. Any write operation requires an explicit, versioned API contract. No implicit state sync, no fire-and-forget writes, no silent coupling creep. |
| OPERATOR_READS_NODE_VIA_VCS | Operator → Node only via VCS API (read repo-spec, read manifests). Never direct DB access. Never wallet access.                                                                                            |

### Patterns

- **AI representatives:** Each node's graphs can call operator read-only API endpoints (e.g., query work items, read node registry). Write operations (e.g., dispatch work) require explicit contracts.
- **Operator → Node:** Read repo-spec and project manifests via VCS API. Never read node DB. Never access node wallet.
- **Node → Node:** No direct communication. If poly needs resy data, it goes through operator as intermediary (future federation pattern).

---

## Migration Path

| Phase              | What changes                                                                      | Gate                                             |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| **V0** (current)   | Shared DB, shared auth. Works for dev, not production.                            | —                                                |
| **V1** (this spec) | Per-node DB provisioning. SSO with per-node origin-scoped sessions.               | Multi-node CICD proven (task.0247)               |
| **V2**             | Operator aggregation plane for cross-node metering. Derived, not primary.         | Paying gateway customer (proj.operator-plane v0) |
| **V3**             | Federation. Sovereign nodes trust external IdPs. Inter-node contracts formalized. | Multiple independent node operators              |
