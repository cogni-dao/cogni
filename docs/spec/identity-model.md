---
id: identity-model-spec
type: spec
title: "Identity Model: System Identity Primitives"
status: draft
spec_state: proposed
trust: draft
summary: "Single source of truth for node-local human and AI identity: six orthogonal system keys plus bindings, credentials, stewardship, authorization, attribution, beneficiary, and wallet boundaries."
read_when: Working on identity, scoping, multi-project, ledger attribution, node-operator boundaries, or any code that references node_id, scope_id, user_id, or billing_account_id.
owner: derekg1729
created: 2026-02-22
verified: 2026-10-09
tags: [identity, architecture, governance]
---

# Identity Model: System Identity Primitives

> The system uses six orthogonal identity keys. Each has a single, non-overlapping purpose. This spec is the canonical reference for what each key means, where it lives, and what it must never be used for.

## Key References

|          |                                                                      |                                                                   |
| -------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Spec** | [Node vs Operator Contract](./node-operator-contract.md)             | Node/Operator boundaries, scope_id intro                          |
| **Spec** | [Attribution Ledger](./attribution-ledger.md)                        | Ledger scoping by (node_id, scope_id)                             |
| **Spec** | [User Identity + Account Bindings](./decentralized-user-identity.md) | user_id, user_bindings, identity_events                           |
| **Spec** | [Accounts Design](./accounts-design.md)                              | billing_account_id, credit ledger                                 |
| **Spec** | [DAO Enforcement](./dao-enforcement.md)                              | dao_address, payment rails                                        |
| **Spec** | [Tokenomics: Distribution Lifecycle](./tokenomics-distribution.md)   | distribution executor authority + recipient (actor_id) resolution |

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
│    │  ─ agent actors: RBAC subject agent:{node_id}/{actor_id}    │     │
│    │  ─ spawned-by and accepted steward are distinct relations │     │
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
│    │  user_id (UUID)                         per-node        │     │
│    │  ─ Canonical person identity                             │     │
│    │  ─ Stable inside one node, minted at first contact       │     │
│    │  ─ Auth-method-agnostic (wallet, Discord, GitHub)        │     │
│    │  ─ Lives in: users.id, sessions, human-account relations │     │
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
| `user_id`            | UUID | First user contact       | No      | Node-local human account identity          | `users.id`                                |
| `actor_id`           | UUID | Actor creation           | No      | Economic subject (earns/spends/attributed) | `actors.id`                               |
| `billing_account_id` | UUID | Account creation         | No      | Payment/subscription tenancy               | `billing_accounts.id`                     |
| `dao_address`        | TEXT | DAO contract deployed    | No      | On-chain contract identity                 | `.cogni/projects/*.yaml` → `dao.contract` |

Supporting records have local IDs such as `credential_id`, `grant_id`, binding
row ID, and relationship-event ID. These locate authentication or policy state;
they are not additional system identity primitives and must never substitute for
`user_id`, `actor_id`, or an evidenced external binding.

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
actor_id (1) ──── (1) spawned_by_actor_id Immutable creation provenance
actor_id (1) ──── (0..1) parent_actor_id Current accepted human/org steward
actor_id (1) ──── (N) actor_bindings    Wallets, external refs
actor_id (N) ──── (1) billing_account_id Multiple actors per tenant
```

**Orthogonality:** `scope_id` and `billing_account_id` are independent dimensions. A user's billing account is for paying for AI service consumption. A scope's DAO is for paying contributors. These never intersect — contributing to a project does not require a billing account, and using the AI service does not require contributing to a project.

## Runtime Authorization Principals

Runtime RBAC uses typed string references to durable local subjects. The typed
reference may contain a database identifier; the reference is not a credential,
secret, external identity, or global identity.

| Runtime Field  | Format                             | Source of Truth                                    | Purpose                                      |
| -------------- | ---------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| `actorId`      | `user:{node_id}/{user_id}`         | Browser session + serving node                     | Direct human execution                       |
| `actorId`      | `agent:{node_id}/{actor_id}`       | Active node-local agent credential                 | Direct or delegated AI execution             |
| `actorId`      | `service:{node_id}/{service_name}` | Internal service bootstrap + serving node          | Internal service execution                   |
| `subjectId`    | `user:{node_id}/{user_id}`         | Server-issued execution grant/session context only | Human authority for on-behalf-of execution   |
| `tenantId`     | `{billing_account_id}`             | Authorized account selection or execution grant    | Tenancy/RLS boundary and audit key           |
| `credentialId` | `{credential_id}`                  | Node-local credential lookup                       | Authentication lifecycle and audit reference |
| `graphId`      | `{provider}:{graph_name}`          | Graph catalog / execution request                  | Graph-scoped authorization context           |

`actor_id` is the one durable node-local AI identity; do not create a parallel
durable `agent_id`. The OpenFGA store is shared within an environment, while
users, actors, and accounts are node-local, so every OpenFGA subject is encoded
with the serving `node_id` as the object-ID prefix after OpenFGA's single type
separator (for example `agent:{node_id}/{actor_id}`). Bare `agent:{actor_id}` and
`user:{user_id}` strings must never enter the shared graph. Credentials rotate
and access contexts expire
while the node-qualified OpenFGA subject, attribution, and bindings remain stable.

Two execution modes are intentionally distinct:

- **Direct agent:** authenticate local actor `A` at node `N`, derive
  `agent:N/A`, let the caller select an explicit account from its authorized
  self-list, and check `agent:N/A` on that exact
  `billing_account:N/B`. Caller input selects a resource; it never authorizes it.
- **On-behalf-of (OBO):** the server closes over an immutable
  `ExecutionIdentity { actorPrincipal: agent:N/A, subjectPrincipal: user:N/H,
billingAccountId: B, grantId: G }`. Authorization checks both `H` on `B` and
  the exact scoped delegation from `A` to `H` for `B` and the action.

`subjectId`, OBO `billingAccountId`, and `grantId` never come from request data,
model output, tool arguments, or `RunnableConfig.configurable`. Direct API input
may name `billing_account_id`, but the server derives the actor from the
credential and re-authorizes that exact account before cache or query. Omission
never silently substitutes an agent-owned account for a delegated account.

**Legacy boundary:** the current 30-day HMAC machine bearer resolves to a fake
`SessionUser` and `user:{user_id}`. That is migration input, not the target
standard. The target resolver returns a discriminated human-or-agent principal;
it never counterfeits a human session for an AI.

## Human–AI Relationship Model

Creation provenance, stewardship, permission, attribution, and payout are five
different relationships. No relationship implies another.

| Relationship           | Meaning                                | Mutation rule                                               | Never implies                            |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| `spawned_by_actor_id`  | Actor that authorized creation         | Immutable creation fact                                     | parentage, permission, beneficiary       |
| `parent_actor_id`      | Current accepted human/org steward     | Effective-dated append-only events; pointer is a projection | account access, OpenFGA role, authorship |
| OpenFGA relation       | Permission on an exact resource/action | Authoritative grant/revoke in OpenFGA                       | parentage, beneficiary, source ownership |
| `earned_by_actor_id`   | Actor that produced the contribution   | Frozen when source evidence resolves                        | wallet ownership or political rights     |
| `beneficiary_actor_id` | Actor entitled under allocation policy | Selected from effective-time policy and signed              | authorship or authorization              |

### Spawn state machine

1. An authenticated human, or an agent holding `agent.spawn`, issues a hashed,
   one-use, 10-minute spawn grant bound to node, environment, tenant, issuer, and
   idempotency key. Issuance creates no actor.
2. Redemption proves possession of the grant and transactionally creates exactly
   one `kind=agent` actor plus its first credential. Concurrent or retried
   redemption returns the same actor; altered credential material fails closed.
3. `spawned_by_actor_id` records the issuer. A human-issued grant may also carry
   that human's explicit parent acceptance. An agent issuer never becomes parent
   or beneficiary implicitly; a server-bound human/org steward must independently
   accept, otherwise the child starts unclaimed.
4. Active-agent and outstanding-grant limits are enforced at issuance. Anonymous
   `{name}`-only registration is not a recovery or bootstrap path.

Parent acceptance, revocation, and reassignment are append-only effective-dated
events. `parent_actor_id` is only their current projection. Parentage may authorize
a recovery ceremony under node policy, but does not itself authorize account reads
or node operations.

### Credential lifecycle

P0 uses a node-local, statefully revocable opaque credential because it solves
expiry-driven re-registration with the smallest complete state machine:

```text
spawn grant → active credential → pending successor → successor confirmed
                         │                         └─ old credential revoked
                         ├─ authenticate_until → renew-only grace
                         └─ renew_until → steward/governance recovery
```

- The bearer is 256 bits of random material, shown once and stored only as a hash
  server-side. Its row binds `credential_id`, `actor_id`, node/audience, status,
  issuance, `authenticate_until`, `renew_until`, revocation, and replacement.
- Before `authenticate_until`, the old credential creates a pending successor.
  The client atomically installs the successor in its shared credential store;
  proof with the successor confirms it and revokes the old credential. Failed
  installation leaves the old credential usable. Confirmation is idempotent.
- Renew-only grace authorizes rotation only, never account data or tools. After
  `renew_until`, accepted-steward or governance recovery attaches a new credential
  to the same actor. Rotation and recovery never mint a new actor, billing account,
  binding, or permission.
- Every target node resolves the bearer through its own credential store. Agent
  authentication does not use `AUTH_SECRET`; a credential from another node fails
  even when fleet HMAC secrets are accidentally equal. Any status cache is
  invalidated before confirm/revoke returns, so the old bearer cannot authorize
  another request after the operation is acknowledged.

Ed25519 proof-of-possession, nonce/jti exchange, 15-minute access tokens, and
per-installation credentials are deferred hardening. They may replace the P0
authenticator without replacing `agent:{node_id}/{actor_id}` or replaying permissions.
A credential key or thumbprint is never cross-node identity because credentials
rotate.

## Distribution Authority + Recipient

Token distribution adds two identity concerns beyond the six primitives — one on the
**authority** side (who may publish on-chain), one on the **recipient** side (who receives
the tokens). Neither is a new identity KEY; both compose existing primitives. Mechanism +
lifecycle: [tokenomics-distribution.md](./tokenomics-distribution.md).

**Authority — three distinct roles, do NOT conflate:**

| Role                      | Identity                                                                                                                                           | Authorizes                                                                       | Plane                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------- |
| **Approver**              | wallet(s) in `activity_ledger.approvers` (bound to `scope_id`)                                                                                     | WHAT is owed — signs the per-epoch EIP-712 statement (`SIGNATURE_BINDS_SOURCES`) | off-chain governance truth |
| **Distribution executor** | a wallet / Safe / `EmissionsExecutor` granted a SCOPED authority on `dao_address` — EXECUTE-via-`IPermissionCondition`, granted ONCE at activation | the on-chain PUBLISH (`mint` + `setMerkleRoot`) and nothing else                 | on-chain                   |
| **RBAC node-admin**       | OpenFGA principal (`user:`/`agent:`) with `node.flight` etc.                                                                                       | operational (flight / secrets / promote)                                         | off-chain operational      |

The DAO (`dao_address`) is the on-chain root; the executor is a scoped, revocable DAO
delegation, NOT the DAO. An `agent` actor CAN hold the executor role (e.g. a Privy agent
wallet) precisely because the on-chain condition caps it to publishing — the scope is what
makes agent custody safe.

**Recipient — attribution, beneficiary, and wallet are three frozen facts at two
different times.**

1. `earned_by_actor_id` is fixed when immutable source evidence resolves. AI work
   remains attributed to the AI actor even when a human controls its provider
   account, approves its work, or ultimately receives value.
2. Beneficiary policy evaluates the accepted-steward/policy state effective at
   the canonical contribution or receipt cutoff captured by the evidence, but
   stewardship is input only. The policy must explicitly select and pin either
   the agent, a human/org actor, or treasury as `beneficiary_actor_id`; it cannot
   derive the beneficiary from parentage alone. It persists the beneficiary,
   cutoff, policy version, and relationship evidence no later than allocation
   signing. It never looks up the parent current at a later allocation or claim
   time. For the `flock-leader` migration, the claim ceremony must explicitly
   select Derek's human actor if Derek is to receive its rewards.
3. At cumulative distribution materialization, the system resolves the pinned
   beneficiary's current verified wallet and pins `claimant_wallet` plus binding
   evidence in the manifest leaf. If no verified wallet exists, the liability
   remains unresolved; no fallback wallet is invented. Published leaves never
   move.

An agent may own tokens itself, and a scope policy may select an accepted
human/org steward or treasury, but the chosen rule and its result are explicit.
There is no identity-level "parent receives rewards" default. OBO `subjectId`,
billing ownership, OpenFGA tuples, and wallet control never choose the beneficiary
implicitly.
Reassignment affects only contributions after its effective time. Historical
evidence without a trustworthy cutoff or relationship state requires explicit
governance adjudication, never a current-parent lookup.

The current claimant resolver remains user-centric
(`user:{user_id}` / `identity:{provider}:{externalId}`). Actor earners and the
versioned earned-by/beneficiary statement are target work. Existing signed
statements and `identity.attestation.v1` remain byte-for-byte valid. Once an epoch
has a cumulative manifest, that manifest is frozen. An unresolved or late-resolved
beneficiary becomes an append-only pending claimant liability consumed exactly
once by a later cumulative fold; it never rewrites the old statement or manifest.
The durable liability reader/consume-once path is required target work and must not
be inferred from the current per-epoch finalize implementation.

## AI Agent Node Developer Identity

The target developer principal is the node-qualified shared-store reference to
the same durable AI subject used everywhere else: `agent:{node_id}/{actor_id}`.
Authentication proves the local actor and serving node; OpenFGA separately
grants it a role on one `node:{node_id}`. Registration, parentage, billing tenancy,
and source bindings grant no node authority.

| Step           | Principal                    | Authoritative fact                                                                                                  |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Spawn/redeem   | local `actor_id`             | Node-local actor and active credential; no node role                                                                |
| Request        | `agent:{node_id}/{actor_id}` | `node_access_requests` workflow row plus evidenced GitHub binding; row is not authority                             |
| Approve/revoke | Human/admin                  | Write/delete `node:{node_id}#developer@agent:{node_id}/{actor_id}` in OpenFGA; GitHub collaborator is a side-effect |
| Flight         | `agent:{node_id}/{actor_id}` | `node.flight` check on exact `node:{node_id}`                                                                       |

**Two planes from one approval (`TWO_PLANE_DEVELOPER_GRANT`, rbac.md §6a).**
OpenFGA controls operational capability; GitHub controls branch push for the
agent's evidenced GitHub binding. The operator App is the privilege bridge and
the agent never holds GitHub admin. Branch push cannot substitute for OpenFGA,
and OpenFGA cannot prove the GitHub account. Merge, deploy, and secrets remain
separate protected capabilities.

**Legacy migration:** current registration mints a fake `users` row, a billing
account, and a 30-day HMAC bearer, while developer tuples use
`user:{agent_user_id}`. Upgrade must prove that exact legacy principal and an
accepted steward/recovery ceremony, create one agent actor/credential while
preserving the billing account, read the authoritative tuple set from OpenFGA,
add equivalent node-qualified `agent:{node_id}/{actor_id}` tuples, verify exact
capability behavior, then remove the legacy tuples after a grace period. Existing
human and node-local resource tuples follow the same additive qualify, verify,
remove sequence. Historical receipts, claimant
keys, bindings, and signed statements are not rewritten. Never discover machine
users by nullable wallet, display name, or GitHub login; prove `flock-leader`
first, then migrate the fleet from evidence.

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

| Key                  | Must Never Be Used For                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node_id`            | Governance domain, epoch scoping, project identity, DAO ownership. It is infrastructure only.                                                                                      |
| `scope_id`           | Deployment identity, infra routing, DB tenancy. It is governance only.                                                                                                             |
| `user_id`            | Replaced by `wallet_address`, Discord snowflake, GitHub numeric ID, or DID. Those are bindings.                                                                                    |
| `billing_account_id` | Governance scoping, contribution attribution, deployment identity. It is payment tenancy only.                                                                                     |
| `actor_id`           | Secret/authenticator, payment tenancy, governance voting rights, wallet address. OpenFGA references it only through `agent:{node_id}/{actor_id}`; the bare ID never authenticates. |
| `dao_address`        | Database primary key, tenant scoping, deployment routing. It is an on-chain attribute only.                                                                                        |

**Synonym prohibition:** Do not introduce `org_id`, `account_id`, `tenant_id` (DB column), `project_id` (DB column), or `contributor_id` as new terms. The six keys above are the complete set. External provider IDs (e.g., WalletConnect project ID, Terraform workspace ID) must be namespaced (e.g., `walletconnect_project_id`) to avoid collision with `scope_id`.

### BINDING_IS_THE_MULTI_ENV_KEY (resolve through the binding, never author a surrogate)

`user_id` / `actor_id` are **node/environment-local surrogates** — a fresh UUID is minted by each
node at first contact (SIWE, OAuth, or agent spawn). The **binding** (`wallet_address`, Discord
snowflake, immutable GitHub provider id, DID) is the **stable, cross-boundary identity**. Therefore:

- **Any cross-env artifact** (seed migration, config, ownership grant, RLS row) that needs "who" MUST
  **resolve through the binding** (`… WHERE wallet_address = <stable>`), never hardcode a per-env `user_id`.
  A "different migration per env" or a committed surrogate UUID is the anti-pattern — one binding-resolved
  artifact is correct on every env at once, and SIWE reuses the binding's row on next login so the surrogate
  lines up automatically.
- This is the top-0.1% multi-env pattern (Stripe/Auth0/Clerk): one external identity, per-env internal ids,
  joined by the external ref. Applied to node ownership in
  [`docs/design/node-wizard-formation-wiring.md`](../design/node-wizard-formation-wiring.md) § Owner binding
  and proven in `pm.prod-reprovision-nodes-registry-reseed.2026-08-05`.
- One node has exactly one active owner for `(provider, immutable_external_id)`.
  The canonical `actor_bindings` ownership registry enforces this across human
  and AI actors; legacy `user_bindings` may be a compatibility projection but
  cannot independently claim the same provider identity. Transfers are evidenced
  state transitions. Credentials and key thumbprints are never bindings.

Historical [PR #2267](https://github.com/cogni-dao/cogni/pull/2267) helped expose
the stale cross-node wording. It is evidence only; this canonical spec and its
eventual implementation stand independently of that unapproved branch.

## V0 Defaults

In V0 (single-project nodes), most keys resolve to a single value:

| Key         | V0 Value                                                       | Multi-Project Behavior           |
| ----------- | -------------------------------------------------------------- | -------------------------------- |
| `node_id`   | From `.cogni/repo-spec.yaml`                                   | Unchanged — one per deployment   |
| `scope_id`  | `uuidv5(node_id, 'default')` — deterministic UUID in repo-spec | One per `.cogni/projects/*.yaml` |
| `scope_key` | `'default'`                                                    | Human slug per project manifest  |

`scope_id` is a deterministic UUID derived from `uuidv5(node_id, scope_key)`. The UUID is declared in `repo-spec.yaml` (V0) or `.cogni/projects/*.yaml` (multi-scope). `scope_key` is the human-readable slug used for display, logging, and as the derivation input.

**Inline-until-second-scope:** V0 inlines the default scope's governance fields (`governance`, `operator_wallet`, `payments`, `activity_ledger.approvers`, weight policy) directly in the node-spec. A `.cogni/projects/<scope_key>.yaml` file materializes only when a second scope is declared — until then it would merely duplicate the inline default. Adding the first non-default scope moves **all** scopes, including `default`, into per-scope manifests.

## Spec File Layering

Three altitudes, one file per altitude. Closest file wins; a higher tier never restates a lower tier's fields.

| Tier              | File                                            | Cardinality  | Owns                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repo manifest** | `.cogni/repo-spec.yaml` (repo root)             | 1 per repo   | Monorepo-wide concerns only: review `gates`, `fail_on_error`. Node registry SSOT is `infra/catalog/*.yaml` (`CATALOG_IS_SSOT`); any `nodes:[]` here is a derived convenience carrying runtime endpoints, never a second authority. |
| **Node-spec**     | `nodes/<node>/.cogni/repo-spec.yaml`            | 1 per node   | Deployment identity: `node_id`, `providers`, `llm_proxy`, `secrets`. Loaded at runtime via `COGNI_REPO_PATH`.                                                                                                                      |
| **Scope-spec**    | `nodes/<node>/.cogni/projects/<scope_key>.yaml` | 1:N per node | Governance + money + permissions: `scope_id`, `governance`, `operator_wallet`, `payments`, `activity_ledger.approvers`, weight policy. Inlined into the node-spec while a node has only the `default` scope.                       |

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
