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
updated: 2026-02-26
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

| Entity                       | Key fields                                                     | Purpose                                                      |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| `actors`                     | `id, tenant_id, kind, parent_actor_id, label, status`          | Economic subject — who earned, who spent, who was attributed |
| `actor_bindings`             | `actor_id, provider, external_id`                              | External refs: wallets, OAuth IDs, platform identities       |
| `budget_allocations`         | `actor_id, funded_by_actor_id, limit, spent, policy`           | Delegated spend slices                                       |
| `charge_receipts.actor_id`   | FK → actors (nullable, v1+; v0 uses `external_agent_ref` TEXT) | Usage attribution: which actor made this LLM call            |
| `epoch_allocations.actor_id` | FK → actors (planned, bridges to user_id)                      | Reward attribution: which actor earned this epoch            |
| `claims`                     | `actor_id, statement_id, wallet, amount` (future)              | On-chain reward claiming                                     |

### Actor kinds

| Kind     | Description                                    | Example                 |
| -------- | ---------------------------------------------- | ----------------------- |
| `user`   | Human person. 1:1 FK to `users.id`.            | Connor (MDI operator)   |
| `agent`  | AI agent. Has `parent_actor_id` for hierarchy. | MDI agent "Kai"         |
| `system` | Internal system processes. Sentinel.           | `cogni_system`          |
| `org`    | Treasury / collective. No direct login.        | MDI collective treasury |

### Reward rollup policy

Three layers, kept strictly separate:

1. **`earned_by_actor_id`** — who did the work (always an actor_id, human or agent)
2. **`beneficiary_actor_id`** — who can claim the reward (defaults to self for humans, parent for agents)
3. **`claimant_wallet`** — where value is sent (resolved from actor_bindings at claim time)

**Default policy:** Agents accrue rewards (`earned_by_actor_id` is always the agent). Provenance is never rewritten — the agent earned it, period. `beneficiary_actor_id` determines who may benefit (defaults to parent human or org treasury for agents). `claimant_wallet` is resolved from `actor_bindings` only at claim time. These three fields are never collapsed into one. Governance rights (voting, proposals) are a separate policy layer — economic attribution does NOT imply political participation.

**`beneficiary_actor_id` is derived by policy but persisted on the reward record.** Resolution rule: nearest claimable ancestor, explicit override, or tenant treasury — evaluated at allocation time and stored. Not re-derived at read time. If ownership/governance changes after allocation, existing records are immutable — only future allocations reflect the new policy. This preserves auditability: a third party can verify who was entitled to what, when.

### Relationship to proj.transparent-credit-payouts

`epoch_allocations.user_id` is the current canonical reward subject (humans only). When `actors` ships (v1), allocations gain `actor_id` alongside `user_id`. Human actors bridge 1:1 via `actors WHERE kind='user'`. Agent actors enable a new attribution path: gateway usage → actor → epoch rewards. No changes to existing epoch invariants (STATEMENT_DETERMINISTIC, ALL_MATH_BIGINT).

## Roadmap

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

**Goal:** Agents become DB entities with their own API keys and budget allocations. Parent can allocate credits to child. Child blocked when budget exhausted.

**Big rocks:**

- `actors` table — agent as a first-class entity (kind: user | agent | system)
- `budget_allocations` — parent carves N credits for child, child burns independently
- `actor_credentials` — per-agent API keys (not just per-tenant)
- Spawn endpoint — create agent + allocate budget in one call
- Budget enforcement — preflight checks agent's allocation, not just tenant pool

**Funding model:** Still USDC-funded by human at the top. The human's credits are the tenant pool. Agents get slices of that pool. No on-chain token usage yet.

**Contract change for MDI:** Instead of `X-Cogni-Agent-Id` header (freeform), each agent gets a real API key. MDI's `spawn_agent` moot action calls Cogni API to create the agent + allocate budget. More structured, more enforceable.

| Deliverable                                       | Status      | Est | Work Item  |
| ------------------------------------------------- | ----------- | --- | ---------- |
| `actors` table + domain model                     | Not Started | 2   | story.0117 |
| `budget_allocations` + delegation logic           | Not Started | 2   | story.0117 |
| `actor_credentials` + per-agent API keys          | Not Started | 2   | story.0117 |
| Spawn endpoint (create agent + budget)            | Not Started | 1   | story.0117 |
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
- Federated identity — actor recognized across multiple DAOs
- SDK extraction — `@cogni/billing-core`, `@cogni/gateway-middleware` for self-hosted mode

## Constraints

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
