---
id: identity-model-spec
type: spec
title: "Identity Model: System Identity Primitives"
status: draft
spec_state: proposed
trust: draft
summary: "Single source of truth for all identity primitives in the Cogni system: node_id (deployment), scope_id (governance domain), user_id (person), billing_account_id (tenancy), dao_address (on-chain), actor_id (economic subject). Defines relationships, scoping rules, and prohibited overloading."
read_when: Working on identity, scoping, multi-project, ledger attribution, node-operator boundaries, or any code that references node_id, scope_id, user_id, or billing_account_id.
owner: derekg1729
created: 2026-02-22
verified: 2026-06-07
tags: [identity, architecture, governance]
---

# Identity Model: System Identity Primitives

> The system uses six orthogonal identity keys. Each has a single, non-overlapping purpose. This spec is the canonical reference for what each key means, where it lives, and what it must never be used for.

## Key References

|          |                                                                      |                                          |
| -------- | -------------------------------------------------------------------- | ---------------------------------------- |
| **Spec** | [Node vs Operator Contract](./node-operator-contract.md)             | Node/Operator boundaries, scope_id intro |
| **Spec** | [Attribution Ledger](./attribution-ledger.md)                        | Ledger scoping by (node_id, scope_id)    |
| **Spec** | [User Identity + Account Bindings](./decentralized-user-identity.md) | user_id, user_bindings, identity_events  |
| **Spec** | [Accounts Design](./accounts-design.md)                              | billing_account_id, credit ledger        |
| **Spec** | [DAO Enforcement](./dao-enforcement.md)                              | dao_address, payment rails               |

## Design

### Identity Primitives

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INFRASTRUCTURE LAYER                         │
│                                                                     │
│  node_id (UUID)                                                     │
│  ─ Deployment/instance identity                                     │
│  ─ One node = one DB, one infra, one `docker compose up`           │
│  ─ Minted at node formation, immutable                              │
│  ─ Lives in: .cogni/repo-spec.yaml, all ledger tables              │
│                                                                     │
│    ┌──────────────────────────────────────────────────────────┐     │
│    │                  GOVERNANCE LAYER                         │     │
│    │                                                          │     │
│    │  scope_id (UUID)                        1:N per node     │     │
│    │  ─ Governance/payout domain (project)                    │     │
│    │  ─ Each scope has: DAO, weight policy, payment rails     │     │
│    │  ─ Deterministic: uuidv5(node_id, scope_key)            │     │
│    │  ─ scope_key = human slug (e.g. 'default')              │     │
│    │  ─ Lives in: .cogni/projects/*.yaml, epoch tables        │     │
│    │                                                          │     │
│    │    ┌──────────────────────────────────────────────┐      │     │
│    │    │  dao_address (TEXT)       1:1 per scope      │      │     │
│    │    │  ─ On-chain contract identity                │      │     │
│    │    │  ─ Aragon DAO address + chain_id             │      │     │
│    │    │  ─ Attribute of a scope, not a DB key        │      │     │
│    │    │  ─ Lives in: .cogni/projects/*.yaml          │      │     │
│    │    └──────────────────────────────────────────────┘      │     │
│    └──────────────────────────────────────────────────────────┘     │
│                                                                     │
│    ┌──────────────────────────────────────────────────────────┐     │
│    │                    TENANCY LAYER                          │     │
│    │                                                          │     │
│    │  billing_account_id (UUID)              1:N per node     │     │
│    │  ─ Payment/subscription tenancy                          │     │
│    │  ─ RLS boundary for user data isolation                  │     │
│    │  ─ = tenantId at runtime (same UUID)                     │     │
│    │  ─ Lives in: billing_accounts.id, all user-data tables   │     │
│    │                                                          │     │
│    │  Orthogonal to scope_id: a user's billing account        │     │
│    │  exists regardless of which projects they contribute to  │     │
│    └──────────────────────────────────────────────────────────┘     │
│                                                                     │
│    ┌──────────────────────────────────────────────────────────┐     │
│    │                   ECONOMIC LAYER                         │     │
│    │                                                          │     │
│    │  actor_id (UUID)                       per-node          │     │
│    │  ─ Economic subject (earns, spends, attributed)          │     │
│    │  ─ Kinds: user | agent | system | org                    │     │
│    │  ─ user actors: 1:1 FK to users.id                       │     │
│    │  ─ agent actors: parent_actor_id for hierarchy            │     │
│    │  ─ Lives in: actors.id, charge_receipts, epoch_allocs    │     │
│    │  ─ Bindings: actor_bindings (wallets, OAuth, ext refs)   │     │
│    │                                                          │     │
│    │  Orthogonal to governance: economic attribution does      │     │
│    │  not imply voting rights or political participation      │     │
│    └──────────────────────────────────────────────────────────┘     │
│                                                                     │
│    ┌──────────────────────────────────────────────────────────┐     │
│    │                    PERSON LAYER                           │     │
│    │                                                          │     │
│    │  user_id (UUID)                         cross-node       │     │
│    │  ─ Canonical person identity                             │     │
│    │  ─ Stable, minted at first contact                       │     │
│    │  ─ Auth-method-agnostic (wallet, Discord, GitHub)        │     │
│    │  ─ Lives in: users.id, ledger attribution, payouts       │     │
│    │  ─ Bindings: user_bindings (provider + external_id)      │     │
│    └──────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

## Definitions

| Key                  | Type | Minted When              | Mutable | Purpose                                    | Canonical Location                        |
| -------------------- | ---- | ------------------------ | ------- | ------------------------------------------ | ----------------------------------------- |
| `node_id`            | UUID | Node formation           | No      | Deployment/instance identity               | `.cogni/repo-spec.yaml`                   |
| `scope_id`           | UUID | Project manifest created | No      | Governance/payout domain (project)         | `.cogni/projects/*.yaml`                  |
| `scope_key`          | TEXT | Project manifest created | No      | Human-readable scope slug                  | `.cogni/projects/*.yaml`, repo-spec.yaml  |
| `user_id`            | UUID | First user contact       | No      | Person identity                            | `users.id`                                |
| `actor_id`           | UUID | Actor creation           | No      | Economic subject (earns/spends/attributed) | `actors.id`                               |
| `billing_account_id` | UUID | Account creation         | No      | Payment/subscription tenancy               | `billing_accounts.id`                     |
| `dao_address`        | TEXT | DAO contract deployed    | No      | On-chain contract identity                 | `.cogni/projects/*.yaml` → `dao.contract` |

## Relationships

```
node_id (1) ──── (N) scope_id          A node hosts multiple projects
scope_id (1) ──── (1) dao_address       Each project has one DAO
node_id (1) ──── (N) billing_account_id A node serves multiple tenants
user_id (1) ──── (1) billing_account_id Each user has one billing account
user_id (1) ──── (N) user_bindings      A user has multiple auth methods
user_id (N) ──── (N) scope_id           Users contribute to multiple projects
                                         (via activity_events + epoch_allocations)
actor_id (1) ──── (1) user_id           For human actors (kind=user)
actor_id (1) ──── (0..1) parent_actor_id Agent hierarchy (kind=agent)
actor_id (1) ──── (N) actor_bindings    Wallets, external refs
actor_id (N) ──── (1) billing_account_id Multiple actors per tenant
```

**Orthogonality:** `scope_id` and `billing_account_id` are independent dimensions. A user's billing account is for paying for AI service consumption. A scope's DAO is for paying contributors. These never intersect — contributing to a project does not require a billing account, and using the AI service does not require contributing to a project.

## Runtime Authorization Principals

Runtime RBAC uses string principal identifiers. These are not database primary
keys, and `actorId` is not the same thing as the `actor_id` economic-subject
column.

| Runtime Field | Format                    | Source of Truth                                               | Purpose                                     |
| ------------- | ------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| `actorId`     | `user:{user_id}`          | Browser session or HMAC machine bearer token `sub`            | Direct human/user-bound machine execution   |
| `actorId`     | `agent:{agent_id}`        | Server-issued execution grant                                 | Autonomous agent execution                  |
| `actorId`     | `service:{service_name}`  | Internal service bootstrap                                    | Internal service execution                  |
| `subjectId`   | `user:{user_id}`          | Server-issued delegation/grant/session context only           | On-behalf-of authority for delegated runs   |
| `tenantId`    | `{billing_account_id}`    | Billing resolver / execution grant / API-originated run input | Authorization tenant boundary and audit key |
| `graphId`     | `{provider}:{graph_name}` | Graph catalog / execution request                             | Graph-scoped authorization context          |

Current operator chat and API-originated graph runs bind direct users as
`actorId = user:{user_id}` and `tenantId = billing_account_id` before
`toolRunner.exec()` can call `AuthorizationPort.check()`. Machine bearer tokens
are user-bound keys; they resolve to the same `SessionUser.id` shape as browser
sessions. They are not standalone `agent:{id}` principals until an execution
grant issues that identity server-side.

**Subject binding:** `subjectId` never comes from a request body, tool args, or
`RunnableConfig.configurable`. It is attached only by trusted server launchers
after validating a session or execution grant.

## AI Agent Node Developer Identity

V0 external AI agents enter through `POST /api/v1/agent/register`. Registration
mints a canonical `user_id`, a billing account, and an HMAC bearer token. That
credential authenticates the request; it does not by itself grant authority over
any node.

Node-scoped developer control is a separate OpenFGA relationship:

| Step           | Actor                        | System Fact                                                                                                                                  |
| -------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Register       | External AI agent            | `users.id = agent_user_id`; bearer token resolves to `SessionUser.id`                                                                        |
| Request        | `user:{agent_user_id}`       | Agent files an access request (`role=developer`) on one `node:{node_id}` → durable `node_access_requests` row (tracking only; not authority) |
| Approve/reject | Node creator/admin           | `POST /api/v1/nodes/{node_id}/developers` writes or removes the OpenFGA tuple for that node                                                  |
| Flight         | `user:{agent_user_id}` in V0 | `POST /api/v1/vcs/flight` checks `node.flight` on `node:{node_id}`                                                                           |

The node creator/admin is the human RLS owner for the node registry row in V0.
That RLS ownership authorizes the approval act; it must not be confused with
ongoing flight authority. After approval, the flight route uses RBAC, not
`nodes.owner_user_id = caller`, so an external agent can flight exactly the node
it was approved for.

**Principal-agnostic by design (not a migration debt):** the `node` model accepts
both principal types — `node.developer: [user, agent]` — so V0's user-backed
machine principals (`actorId = user:{agent_user_id}`) and a later
`actorId = agent:{actor_id}` form coexist **additively**: introducing
agent-actor principals writes new `@agent:` tuples without a model change or
tuple rewrite. V0 registers agents as users (user-bound bearer), which is a
legitimate principal representation, not a stopgap. Agent-actor principals — with
`subjectId = user:{approver_user_id}` for explicit on-behalf-of delegation —
become meaningful once the actors table + execution grants are the registration
authority; that is a forward capability, not a correction of V0.

### Operator node-registry projection (OPERATOR_NODE_ROW_ID_IS_NODE_ID)

The repo-spec `.cogni/repo-spec.yaml::node_id` is authoritative. The operator's `nodes`
table is a **projection** of it (same relationship as `SPECS_GIT_AUTHORITATIVE` → derived
index): the projection is rebuildable, never a second authority.

That projection is keyed under the **same** identity — `nodes.id` **is** the node's
repo-spec `node_id`, not a private surrogate. So the OpenFGA resource `node:<nodes.id>`,
the Loki `node` label, the flight `nodeRef.nodeId`, and `NodeSummary.nodeId` are all the
one repo-spec `node_id`. There is no separate "registry row id."

- **Wizard-born nodes:** `nodes.id`'s `defaultRandom()` UUID _is_ the act of minting the
  `node_id`; `publish` writes that same value into the node's minted repo-spec. Authority
  flows row → repo-spec, then the repo-spec is authoritative forever after.
- **Externally-formed nodes:** the operator inserts the row with `id = <child repo-spec
node_id>` (read from the child repo), never a fresh UUID — so identity cannot fork.
- **Addressing vs authority:** `nodes.slug` is the human/agent-friendly handle used to
  _address_ a node in API paths and UIs; the UUID `node_id` is the immutable _authority_
  that reaches OpenFGA tuples and Loki labels. A slug is unique but not guaranteed
  immutable, so it must never be an OpenFGA resource or a ledger key. Resolve `{id}` path
  segments by `node_id` **or** `slug`, then use the UUID downstream.

## Scoping Rules

### Where Each Key Appears

| Table / Context            | `node_id` | `scope_id`  | `user_id` | `actor_id`       | `billing_account_id` |
| -------------------------- | --------- | ----------- | --------- | ---------------- | -------------------- |
| `epochs`                   | PK part   | PK part     | —         | —                | —                    |
| `activity_events`          | PK part   | Column      | —         | —                | —                    |
| `activity_curation`        | Column    | (via epoch) | Column    | —                | —                    |
| `epoch_allocations`        | Column    | (via epoch) | Column    | Column (planned) | —                    |
| `payout_statements`        | Column    | (via epoch) | —         | —                | —                    |
| `source_cursors`           | PK part   | PK part     | —         | —                | —                    |
| `actors`                   | —         | —           | FK (user) | PK               | FK (tenant)          |
| `budget_allocations`       | —         | —           | —         | FK               | —                    |
| `actor_bindings`           | —         | —           | —         | FK               | —                    |
| `billing_accounts`         | —         | —           | FK        | —                | PK                   |
| `credit_ledger`            | —         | —           | —         | —                | FK                   |
| `charge_receipts`          | —         | —           | —         | Column (planned) | FK                   |
| `ai_threads`               | —         | —           | FK        | —                | FK                   |
| Runtime: `tenantId`        | —         | —           | —         | —                | = billing_account_id |
| Runtime: `GraphRunContext` | Available | Available   | Available | Available        | Available            |

### Composite Keys

| Invariant           | Composite Key                                       | Spec Reference        |
| ------------------- | --------------------------------------------------- | --------------------- |
| ONE_OPEN_EPOCH      | `(node_id, scope_id, status) WHERE status='open'`   | attribution-ledger.md |
| EPOCH_WINDOW_UNIQUE | `(node_id, scope_id, period_start, period_end)`     | attribution-ledger.md |
| ACTIVITY_IDEMPOTENT | `(node_id, id)` on activity_events                  | attribution-ledger.md |
| CURSOR_PK           | `(node_id, scope_id, source, stream, source_scope)` | attribution-ledger.md |

## Invariants

### Prohibited Overloading

These are hard constraints. Violating any of them is a design error.

| Key                  | Must Never Be Used For                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `node_id`            | Governance domain, epoch scoping, project identity, DAO ownership. It is infrastructure only.                    |
| `scope_id`           | Deployment identity, infra routing, DB tenancy. It is governance only.                                           |
| `user_id`            | Replaced by `wallet_address`, Discord snowflake, GitHub numeric ID, or DID. Those are bindings.                  |
| `billing_account_id` | Governance scoping, contribution attribution, deployment identity. It is payment tenancy only.                   |
| `actor_id`           | Auth/login identity, payment tenancy, governance voting rights, wallet address. It is economic attribution only. |
| `dao_address`        | Database primary key, tenant scoping, deployment routing. It is an on-chain attribute only.                      |

**Synonym prohibition:** Do not introduce `org_id`, `account_id`, `tenant_id` (DB column), `project_id` (DB column), or `contributor_id` as new terms. The six keys above are the complete set. External provider IDs (e.g., WalletConnect project ID, Terraform workspace ID) must be namespaced (e.g., `walletconnect_project_id`) to avoid collision with `scope_id`.

## V0 Defaults

In V0 (single-project nodes), most keys resolve to a single value:

| Key         | V0 Value                                                       | Multi-Project Behavior           |
| ----------- | -------------------------------------------------------------- | -------------------------------- |
| `node_id`   | From `.cogni/repo-spec.yaml`                                   | Unchanged — one per deployment   |
| `scope_id`  | `uuidv5(node_id, 'default')` — deterministic UUID in repo-spec | One per `.cogni/projects/*.yaml` |
| `scope_key` | `'default'`                                                    | Human slug per project manifest  |

`scope_id` is a deterministic UUID derived from `uuidv5(node_id, scope_key)`. The UUID is declared in `repo-spec.yaml` (V0) or `.cogni/projects/*.yaml` (multi-scope). `scope_key` is the human-readable slug used for display, logging, and as the derivation input.

**Inline-until-second-scope:** V0 inlines the default scope's governance fields (`cogni_dao`, `operator_wallet`, `payments`, `activity_ledger.approvers`, weight policy) directly in the node-spec. A `.cogni/projects/<scope_key>.yaml` file materializes only when a second scope is declared — until then it would merely duplicate the inline default. Adding the first non-default scope moves **all** scopes, including `default`, into per-scope manifests.

## Spec File Layering

Three altitudes, one file per altitude. Closest file wins; a higher tier never restates a lower tier's fields.

| Tier              | File                                            | Cardinality  | Owns                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repo manifest** | `.cogni/repo-spec.yaml` (repo root)             | 1 per repo   | Monorepo-wide concerns only: review `gates`, `fail_on_error`. Node registry SSOT is `infra/catalog/*.yaml` (`CATALOG_IS_SSOT`); any `nodes:[]` here is a derived convenience carrying runtime endpoints, never a second authority. |
| **Node-spec**     | `nodes/<node>/.cogni/repo-spec.yaml`            | 1 per node   | Deployment identity: `node_id`, `providers`, `llm_proxy`, `secrets`. Loaded at runtime via `COGNI_REPO_PATH`.                                                                                                                      |
| **Scope-spec**    | `nodes/<node>/.cogni/projects/<scope_key>.yaml` | 1:N per node | Governance + money + permissions: `scope_id`, `cogni_dao`, `operator_wallet`, `payments`, `activity_ledger.approvers`, weight policy. Inlined into the node-spec while a node has only the `default` scope.                        |

**SINGLE_HOME:** a node's identity and governance fields live in exactly one tier. The operator is both the hub (repo manifest) and a node (node-spec); its `node_id` and governance fields belong to its node-spec — never duplicated at the repo root.

## Lineage & Cross-Layer Proof

Specs are **git-authoritative**. The system spans four hash-linked stores — **git** (merkle DAG: code + `.cogni/` specs), **Dolt** (prolly tree: knowledge + work items), **Postgres append-only ledgers** (`ingestion_receipts`, `epoch_pool_components`), and the **chain** (EIP-712 → DAO signal). Lineage across them is preserved by **pinning hashes, never by copying data**.

| Rule                    | Constraint                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPECS_GIT_AUTHORITATIVE | `.cogni/*.yaml` live only in git. They are never synced into Dolt or Postgres as a second source of truth. An operator needing queryable spec history derives a rebuildable Postgres projection — never authoritative (same relationship as `DOLT_IS_SOURCE_OF_TRUTH` → derived search index).                            |
| LINEAGE_PINS_HASHES     | When a Dolt / Postgres / on-chain artifact depends on a spec or evidence, it records the upstream **content hash + ref** (git SHA + path; Dolt commit), not a copy. Mirrors `ENRICHER_SNAPSHOT_RULE`: if it isn't pinned, it doesn't exist for proof.                                                                     |
| SIGNATURE_BINDS_SOURCES | At a signing inflection point, the EIP-712 typed data binds the source hashes of every layer that defined the outcome — extending `SIGNATURE_SCOPE_BOUND` to `node_id + scope_id + scope_spec_git_sha + evidence_dolt_commit + final_allocation_set_hash`. One signature is the merkle-join anchor: git ↔ dolt ↔ chain. |

## Goal

Provide a single, unambiguous reference for every identity primitive in the system. Eliminate confusion between deployment identity, governance domain, person identity, and payment tenancy. Prevent key overloading that leads to painful retrofits.

## Non-Goals

- DID/VC portability (see [User Identity spec](./decentralized-user-identity.md#did-readiness-p2))
- Federation identity protocol (P2+)
- Smart contract registry design
- UI for identity management

## Related

- [Node vs Operator Contract](./node-operator-contract.md) — Node/Operator boundaries, scope_id in definitions
- [Attribution Ledger](./attribution-ledger.md) — Ledger scoping by (node_id, scope_id)
- [User Identity + Account Bindings](./decentralized-user-identity.md) — user_id, bindings, identity_events
- [Accounts Design](./accounts-design.md) — billing_account_id, credit ledger
- [DAO Enforcement](./dao-enforcement.md) — dao_address, repo-spec authority, payment rails
- [RBAC](./rbac.md) — Actor/subject model references user_id and tenantId
- [ROADMAP.md §Tenant Scoping](../../ROADMAP.md#terminology--id-mapping) — Terminology table
- [proj.spec-layering](../../work/projects/proj.spec-layering.md) — Tier layering rollout + cross-layer lineage roadmap
