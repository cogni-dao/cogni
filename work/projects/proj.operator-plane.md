---
id: proj.operator-plane
type: project
primary_charter:
title: "Operator Plane — Unified Actor Model, Multi-Tenant Gateway, and Economic Attribution"
state: Paused
priority: 3
estimate: 15
summary: "Establish actor_id as the canonical economic primitive (earns/spends/attributed) across billing, rewards, and budget delegation. Multi-tenant the existing billing stack as an OpenAI-compatible gateway. Unify usage metering, contribution attribution, and epoch rewards under one actor identity."
outcome: "External projects route LLM traffic through Cogni gateway, metered per-actor. Actors (human or agent) earn epoch rewards under the same actor_id that tracks their spend. Reward rollup policy keeps governance rights separate from economic attribution."
assignees: derekg1729
created: 2026-02-26
updated: 2026-10-09
labels: [dao, billing, gateway, multi-tenant, agents]
---

# Operator Plane — Unified Actor Model, Multi-Tenant Gateway, and Economic Attribution

> **STATUS: PAUSED** — Gate: paying gateway customer exists (MDI or equivalent). Node registration (task.0122) moved to proj.node-formation-ui.
>
> Research: [dao-gateway-sdk](../../docs/research/dao-gateway-sdk.md) (spike.0115)
> Launch customer: My Dead Internet (MDI) — 299+ AI agent collective (story.0118)

## Goal

Let any AI project — starting with MDI — meter AI usage, prepay credits, and track cost per agent through an OpenAI-compatible gateway. The first experience must be: **get API key → swap base URL → fund account → make metered calls**. No DAO formation required. No code changes for the project.

## Integration Contract (from MDI's perspective)

MDI's integration surface with Cogni is intentionally minimal:

```
MDI server.js
  │
  ├── OPENAI_BASE_URL = https://gateway.cogni.org/v1  (base URL swap)
  ├── Authorization: Bearer <mdi-api-key>              (gateway auth)
  ├── X-Cogni-Agent-Id: <agent-name>                   (per-agent attribution)
  │
  └── Cogni REST API (v0: manual calls from MDI server)
        ├── GET  /api/v1/gateway/balance
        ├── GET  /api/v1/gateway/usage?agent=<id>
        └── POST /api/v1/gateway/agents  (v1: create agent + allocate budget)
```

**v0 requires zero code changes in MDI** beyond a base URL + API key swap and adding an agent ID header. Everything else is optional API calls MDI can adopt incrementally.

## Unified Actor Model

`actor_id` is the canonical economic subject across all Cogni economic systems. See [identity-model.md](../../docs/spec/identity-model.md) for the full primitive definition.

### Core entities

| Entity                       | Key fields                                                                    | Purpose                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `actors`                     | `id, billing_account_id, kind, spawned_by_actor_id, parent_actor_id, status`  | Durable economic subject; spawn provenance and current steward stay distinct |
| `actor_bindings`             | `actor_id, provider, immutable_external_id, evidence_event_id, closed_at`     | One node-local ownership registry for human and AI external identities       |
| `actor_credentials`          | `id, actor_id, node_id, secret_hash, status, authenticate_until, renew_until` | Replaceable node-local authentication; never the actor or permission         |
| `budget_allocations`         | `actor_id, funded_by_actor_id, limit, spent, policy`                          | Delegated spend slices                                                       |
| `charge_receipts.actor_id`   | FK → actors (nullable, v1+; v0 uses `external_agent_ref` TEXT)                | Usage attribution: which actor made this LLM call                            |
| `epoch_allocations.actor_id` | FK → actors (planned, bridges to user_id)                                     | Reward attribution: which actor earned this epoch                            |
| signed allocation            | `earned_by_actor_id, beneficiary_actor_id, cutoff, policy_version`            | Immutable authorship and effective-time entitlement                          |
| distribution leaf            | `beneficiary_actor_id, claimant_wallet, binding_evidence_hash`                | Wallet pinned when the cumulative manifest is materialized                   |

### Actor kinds

| Kind     | Description                                                                         | Example                 |
| -------- | ----------------------------------------------------------------------------------- | ----------------------- |
| `user`   | Human person. 1:1 FK to `users.id`.                                                 | Connor (MDI operator)   |
| `agent`  | AI agent. Has immutable spawner provenance and optional accepted human/org steward. | MDI agent "Kai"         |
| `system` | Internal system processes. Sentinel.                                                | `cogni_system`          |
| `org`    | Treasury / collective. No direct login.                                             | MDI collective treasury |

### Reward rollup policy

Four facts, kept strictly separate:

1. **`earned_by_actor_id`** — who did the work (always an actor_id, human or agent)
2. **`beneficiary_actor_id`** — who is entitled under the effective allocation policy
3. **`claimant_wallet`** — where value is sent (resolved and pinned at cumulative manifest materialization)
4. **parent/steward relationship evidence** — policy input, never the beneficiary field itself

**Default policy:** Agents accrue rewards (`earned_by_actor_id` is always the
agent). Provenance is never rewritten — the agent earned it, period. The policy
may select an accepted human/org steward or treasury as beneficiary; an unclaimed
agent defaults to self. These facts are never collapsed. Governance rights
(voting, proposals), OBO subject, account ownership, and OpenFGA permission are
separate policy layers — economic attribution implies none of them.

**`beneficiary_actor_id` is derived by policy but persisted on the signed reward
record.** The policy evaluates accepted-steward state effective at the canonical
contribution/receipt cutoff, not the parent current when allocation happens.
Persist the cutoff, policy version, and relationship evidence. Reassignment
affects only work after its effective time. Historical ambiguity is adjudicated;
it never falls back to the current parent. At cumulative materialization, resolve
the beneficiary's current verified wallet and pin it with evidence. Finalized
allocations and published leaves are never re-derived or moved.

### Relationship to proj.transparent-credit-payouts

`epoch_allocations.user_id` is the current canonical reward subject (humans only). When `actors` ships (v1), allocations gain `actor_id` alongside `user_id`. Human actors bridge 1:1 via `actors WHERE kind='user'`. Agent actors enable a new attribution path: gateway usage → actor → epoch rewards. No changes to existing epoch invariants (STATEMENT_DETERMINISTIC, ALL_MATH_BIGINT).

### Shared human–AI identity standard

The actor roadmap now has one cross-node contract:

- Each node mints local users, actors, credentials, bindings, and grants. Stable
  provider bindings are re-proved across nodes; local UUIDs and bearers are never
  copied.
- `agent:{actor_id}` is the durable AI OpenFGA principal. `credential_id` is a
  replaceable authenticator. `billing_account_id` remains tenancy only.
- Spawn issuance creates a one-use pending grant; idempotent redemption creates
  the actor and first credential. `spawned_by_actor_id` is immutable provenance;
  `parent_actor_id` is an effective-dated accepted human/org stewardship
  projection. Neither implies permission or beneficiary.
- P0 credentials are 256-bit opaque bearers stored hashed and resolved in the
  target node's store. Two-phase rotation and renew-only grace keep the same actor
  and grants; recovery never re-registers. Ed25519/DPoP plus 15-minute access-token
  exchange is deferred hardening.
- OpenFGA is the sole permission/delegation authority. Direct AI account access
  checks `agent:A` on exact account `B`; OBO execution additionally binds and
  checks human `H`, account `B`, capability, and grant `G`. Local rows and RLS are
  workflow/defense only.
- `actor_bindings` enforces one active actor per `(provider,
immutable_external_id)` inside a node. A credential key is never a binding.

This contract is specified in [identity-model.md](../../docs/spec/identity-model.md),
[decentralized-user-identity.md](../../docs/spec/decentralized-user-identity.md),
and [rbac.md](../../docs/spec/rbac.md). This paused project's v1 actor lane may
consume it; it must not create a gateway-specific identity fork.

## Roadmap

### Shared Identity P0 — Cross-Node Acceptance (story.5075)

The smallest acceptance-preserving path is ordered; downstream nodes consume the
shared contract rather than designing local variants.

1. **Shared seams:** publish the discriminated `RequestPrincipal`, spawn/redeem/
   rotate/recover wire contract, `ExecutionIdentity`, and account-scoped OpenFGA
   contract (including conditional expiry and consistency controls).
2. **Operator identity vertical:** implement actor, spawn grant, opaque credential,
   two-phase rotation/recovery, and one additive `flock-leader` migration. Prove
   old/revoked/cross-node credentials fail while actor and grants remain stable.
3. **Operator attribution vertical:** bind the `flock-leader` provider identity to
   the AI actor and carry one new real contribution through a versioned allocation:
   AI earner, effective-time human beneficiary, verified pinned wallet. Preserve
   all prior signed bytes.
4. **Node-template reference:** consume the shared contracts with target-local
   actors, credentials, bindings, and OpenFGA tuples. An operator credential must
   fail there even in an equal-`AUTH_SECRET` regression fixture.
5. **Poly proof:** move one read-only capability behind the shared direct/OBO
   authorization seam. Prove exact-account allow, decoy-account non-disclosure,
   authorize-before-cache, transaction-local RLS defense, immediate confirmed
   revoke, and credential rotation without reapproval.
6. **Cross-node close gate:** record exact build SHAs and correlate the same human,
   AI, grant, account read, contribution, signed allocation, pinned wallet leaf,
   publish, claim, and replay denial across operator, node-template, and Poly.

P0 deliberately defers DPoP/asymmetric client installations, sophisticated
rate-limit infrastructure, every Poly capability, fleet bulk migration, and the
historical backlog fold. Those follow the contiguous proof; they do not weaken
the append-only migration contract.

### v0 — Metered Gateway (MDI as Tenant #1)

**Goal:** MDI routes LLM traffic through Cogni. Every call metered. Cost tracked per agent via header. Human operator funds account via USDC on Cogni website.

**Big rocks:**

- Gateway proxy route — OpenAI-compatible passthrough with billing middleware
- API key → tenant resolution (replaces Auth.js session for gateway callers)
- `X-Cogni-Agent-Id` header → `charge_receipts.external_agent_ref` attribution (nullable TEXT, freeform — NOT an actor_id FK)
- Spend cap on the tenant account (hard limit, preflight rejects when exhausted)
- MDI onboarding — create billing account, issue API key, seed initial credits

**Funding model:** Human (Connor/moonbags) pays USDC via existing Cogni payments page. Credits land in MDI's billing account. Gateway calls debit from that pool. No per-agent funding yet — just per-agent cost _tracking_.

**What MDI does NOT need for v0:**

- DAO formation (optional, can do in parallel via cognidao.org/setup/dao)
- Actor/agent tables (agent ID is a freeform header, not a DB entity)
- Budget delegation (single pool, single spend cap)
- OpenClaw skill (MDI calls REST API directly from server.js)

| Deliverable                                                                       | Status      | Est | Work Item  |
| --------------------------------------------------------------------------------- | ----------- | --- | ---------- |
| Unified repo-spec reader package (`@cogni/repo-spec`)                             | In Review   | 3   | task.0120  |
| Node registration lifecycle (discovery, fetch, persist, reconcile)                | Not Started | 5   | task.0122  |
| Operator node registry DB (registrations, capabilities, scopes)                   | Not Started | —   | task.0122  |
| GitHub webhook handlers (review + admin routes, multi-app capability tracking)    | Not Started | —   | task.0122  |
| Scope reconciliation with Temporal schedule management                            | Not Started | —   | task.0122  |
| Gateway proxy route (OpenAI-compatible, billing middleware)                       | Not Started | 3   | story.0116 |
| API key management (generation, hashed storage, gateway auth)                     | Not Started | 2   | story.0116 |
| `charge_receipts.external_agent_ref` column (nullable TEXT, freeform from header) | Not Started | 1   | story.0116 |
| Tenant-level spend cap (preflight enforcement)                                    | Not Started | 1   | story.0116 |
| MDI onboarding (billing account + API key + seed credits)                         | Not Started | 1   | story.0118 |
| Usage/balance API endpoints (GET balance, GET usage by agent)                     | Not Started | 1   | story.0116 |

### v1 — Agent Budgets (First-Class Actors)

**Goal:** Agents become DB entities with their own API keys and budget allocations. An explicitly authorized funder can allocate credits to an agent; stewardship alone grants no spend authority. The agent is blocked when its budget is exhausted.

**Big rocks:**

- `actors` table — first-class subject (kind: user | agent | system | org),
  immutable spawner provenance, effective-dated accepted steward events
- `budget_allocations` — authorized funder carves N credits for an agent, which burns independently
- `actor_credentials` — stateful node-local opaque bearer, two-phase rotation,
  renew-only grace, revoke, and steward recovery onto the same actor
- Spawn grant + redemption — authenticated, one-use, limited, idempotent actor creation
- `actor_bindings` — unique external-owner registry shared by humans and AIs
- OpenFGA account/delegation seam — direct and server-bound OBO modes
- Budget enforcement — preflight checks agent's allocation, not just tenant pool

**Funding model:** Still USDC-funded by human at the top. The human's credits are the tenant pool. Agents get slices of that pool. No on-chain token usage yet.

**Contract change for MDI:** Instead of `X-Cogni-Agent-Id` header (freeform), each agent gets a real API key. MDI's `spawn_agent` moot action calls Cogni API to create the agent + allocate budget. More structured, more enforceable.

| Deliverable                                       | Status      | Est | Work Item  |
| ------------------------------------------------- | ----------- | --- | ---------- |
| `actors` + spawn/steward event domain model       | Not Started | 2   | story.0117 |
| `budget_allocations` + delegation logic           | Not Started | 2   | story.0117 |
| `actor_credentials` + rotate/recover lifecycle    | Not Started | 2   | story.0117 |
| Spawn issue/redeem endpoint + limits              | Not Started | 1   | story.0117 |
| Unique human/AI `actor_bindings` ownership        | Not Started | 2   | story.0117 |
| OpenFGA exact-account direct/OBO authorization    | Not Started | 2   | story.0117 |
| Budget enforcement in preflight                   | Not Started | 1   | story.0117 |
| OpenClaw skill (getBalance, getUsage, spawnAgent) | Not Started | 2   | story.0118 |

### v2 — Epochs + Activity Rewards

**Goal:** Activity-based credit rewards. MDI activity data feeds into valuation engine. Agents earn credits each epoch.

**Big rocks:**

- Data ingestion plugin for MDI activity (fragments contributed, quality scores, moot participation)
- Valuation engine plugin — maps MDI activity → credit rewards per epoch
- Epoch-based distribution to actors (existing epoch infra, extended to agents)
- All DB-based — no on-chain settlement yet

**Funding model:** Credits still enter via USDC top-up. But now credits also flow _inward_ as epoch rewards. Agents that contribute more earn more budget.

| Deliverable                         | Status      | Est | Work Item            |
| ----------------------------------- | ----------- | --- | -------------------- |
| MDI activity ingestion adapter      | Not Started | 3   | (create at v2 start) |
| Valuation engine plugin for MDI     | Not Started | 3   | (create at v2 start) |
| Epoch rewards distributed to actors | Not Started | 2   | (create at v2 start) |

### v3 — On-Chain $SNAP

**Goal:** Agents can claim $SNAP token rewards to a wallet. Agents can make DAO proposals and vote.

**Big rocks:**

- Wallet management for agents (1 wallet per actor — Coinbase AgentKit or similar, Privy gets expensive at scale)
- $SNAP claim flow — actor claims earned credits as on-chain tokens
- DAO proposal + voting — agents participate in governance via $SNAP
- x402 middleware — per-request crypto payments for agent-to-agent commerce

**Open questions:**

- Wallet custody model for 299+ agents — managed wallets (Coinbase/Privy) vs derived keys?
- Gas sponsorship for agent transactions? (Base: transactions are <$0.01, but still requires ETH funding). futarchy..?
- Voting weight model — 1 token = 1 vote, or MDI's existing quality-weighted model?

### v4 — Recursive Sub-DAO Spawning

**Goal:** An agent collective can spawn a child DAO with its own treasury, governance, and agent pool.

**Big rocks:**

- Sub-DAO factory — parent DAO spawns child with initial treasury allocation
- Cross-DAO agent mobility — agents can operate across DAO boundaries
- Federated identity — external binding re-proved into each node's local actor;
  never a copied global `actor_id` or credential
- SDK extraction — `@cogni/billing-core`, `@cogni/gateway-middleware` for self-hosted mode

## Constraints

- **Version labels are project-local.** This roadmap's gateway v0/v1 predates the
  shared identity P0. Any first-class actor implementation follows the shared P0
  contract above even if delivered under this project's v1 milestone.
- **v0 is maximally simple.** Freeform agent ID header, single tenant pool, human-funded. No new tables beyond charge_receipts column.
- **v1 adds structure.** Actor table, budget delegation, per-agent keys. Still off-chain, still human-funded.
- **v2 adds economics.** Epoch rewards create a feedback loop. Still DB-based settlement.
- **v3 goes on-chain.** Token claims, voting, wallet management. First real $SNAP utility.
- **v4 is recursive.** Sub-DAOs, federation, SDK. Only if v0-v3 prove the model.
- **OpenAI-compatible API at every stage.** Gateway is always a drop-in base URL swap.
- **Single LiteLLM instance shared across tenants** for v0-v1. Per-tenant isolation is v2+.

## Dependencies

- [x] Existing billing infrastructure (credit_ledger, charge_receipts, payment_attempts)
- [x] LiteLLM proxy + OpenRouter
- [x] USDC payment flow (existing)
- [ ] MDI partnership coordination (story.0118)
- [ ] DAO formation wizard tested with real user (v0, optional parallel track)

## Multi-Node Infrastructure (integration/multi-node branch)

Nodes are sovereign app instances sharing operator infrastructure. Each node
has a Next.js app + graph package under `nodes/{name}/`. Per DB_PER_NODE:
each node gets its own database on a shared Postgres server. Per
ORIGIN_SCOPED_COOKIES: each node has its own auth session.
See: `docs/spec/multi-node-tenancy.md`

| Deliverable                                                        | Status         | Work Item |
| ------------------------------------------------------------------ | -------------- | --------- |
| Absorb cogni-resy-helper into monorepo                             | Done           | task.0244 |
| nodes/ bounded context + dep-cruiser                               | Done           | task.0245 |
| Rename apps/web → apps/operator                                    | Done           | task.0246 |
| Node-template + poly + resy platform apps                          | In Review      | PR #682   |
| Per-node billing pipeline (DB+auth+routing)                        | Needs Closeout | task.0256 |
| Fix node identity via repo-spec                                    | Done           | task.0257 |
| Multi-node stack test infrastructure                               | Needs Design   | task.0258 |
| Multi-node CI/CD deployment                                        | Needs Design   | task.0247 |
| Extract shared platform package (Phase 2 deferred — see review)    | In Progress    | task.0248 |
| Port resy reservations feature                                     | Needs Design   | task.0253 |
| Node landing page auth flow                                        | Needs Triage   | bug.0255  |
| Auto-generate COGNI_NODE_ENDPOINTS from repo-spec                  | TODO (future)  | —         |
| Graduate nodes to standalone repos (submodules or full extraction) | TODO (roadmap) | —         |

## As-Built Specs

- [Multi-Node Dev Guide](../../docs/guides/multi-node-dev.md) — layout, commands, testing

## Design Notes

### Why v0 avoids the actor table

The simplest thing that works for MDI is a freeform `X-Cogni-Agent-Id` header logged to `charge_receipts.external_agent_ref` (nullable TEXT). This gives per-agent cost visibility immediately. No schema migration beyond a nullable column. `external_agent_ref` is explicitly NOT `actor_id` — it's a freeform tag with no FK constraint. When the `actors` table ships (v1), a real `actor_id` FK column is added and `external_agent_ref` values are mapped to actors via `actor_bindings`.

The actor table (v1) adds _enforcement_ — real API keys per agent, budget caps, spawn delegation. But enforcement without visibility is useless. Ship visibility first.

### What repo-spec IS in this project

**Not** a first-run dependency. Optional import/export for portable declarative policy:

- treasury wallet address
- spend policy defaults
- model/provider allowlist

Parsed at onboarding/sync time, normalized into gateway DB. Live source of truth is the **gateway DB/API**, not git.

### Relationship to existing projects

- **proj.ai-operator-wallet**: Cogni's own outbound payments (OpenRouter top-up). Tenants don't need operator wallets.
- **proj.accounts-api-keys**: Existing sentinel virtual_keys. Gateway API keys are a superset.

### Open questions for MDI (TBD before v0)

1. How do they currently make LLM calls? (OpenAI SDK? OpenRouter? direct?)
2. How many of 299 agents actually make LLM calls?
3. Does Kai stay independent or route through gateway?
4. Priority: cost visibility (v0) or budget enforcement (v1)?
5. For `spawn_agent` moot — what does MDI need from Cogni at spawn time?
