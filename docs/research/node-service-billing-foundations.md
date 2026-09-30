---
id: research.node-service-billing-foundations
type: research
title: "Node Service Billing Foundations — payer accounts, charge envelope, node↔node services"
status: draft
trust: draft
summary: Why the PR-review plane has been silently dead since ~2026-09-24 (insolvency, not infra), and what foundation lets nodes bill services to each other and reliably fund themselves. The keystone is one missing primitive — a payer account that is not a human — plus an explicit effective-dated liability binding.
read_when: Designing node billing/treasury, node→node service metering, credit top-up reliability, or resolving the three contradictory billing futures in docs/spec.
owner: derekg1729
created: 2026-09-30
tags: [billing, payments, compute, x402, nodes, ledger]
---

# Research: Node Service Billing Foundations

> date: 2026-09-30 · repo `Cogni-DAO/cogni` · all claims below are live-verified or file-cited

## Question

Two questions, one root.

1. **Why is `Cogni Git PR Review` failing?** Derek's recollection was that PR review runs on a _free_
   model. It does not. Establishing why exposes the real subject.
2. **Does our node-based billing foundation support the operator north star** — nodes that form and
   _sell services_ to each other, where (e.g.) `beacon` provides a metered service to `poly`, with
   named humans _and_ agents authorized to administer that node's spend? What would a top-tier team
   build here, and how do nodes _reliably_ stay funded?

They are the same question. Q1 is what an unfunded, unmonitored, human-shaped billing plane looks
like when a machine tries to use it.

## Context — what exists today (verified, not assumed)

### The Q1 causal chain

Every AI review gate on every open PR reports `Graph execution failed` and lands **NEUTRAL**.
Only the deterministic `review_limits` gate works. Six defects are stacked:

| #      | Defect                                                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | Review is pinned to a **paid** model that **does not exist in the platform catalog**.                                                                | `.cogni/repo-spec.yaml:115-117` → `review: {enabled: true, model: gpt-4o-mini}`. Live prod `GET /api/v1/ai/models` returns 10 models; `gpt-4o-mini` is **not** among them. `infra/compose/runtime/configs/litellm.config.yaml` (curated 2026-08-27) has no such route.                                                                                                      |
| **D2** | Nothing validates `review.model` against the catalog — not at spec parse, not at gate time. A stale pin degrades silently instead of failing loudly. | `reviewConfigSchema` (`packages/repo-spec/src/schema.ts:752`) is `z.string().min(1)` — any string passes. `DEFAULT_REVIEW_MODEL = "gpt-4o-mini"` (`review-handler.ts:32`) is _also_ stale, so omitting the field does not help.                                                                                                                                             |
| **D3** | `isModelFree()` **fails to "paid"** for an unknown id, and the preflight estimate is model-blind.                                                    | `model-catalog.server.ts:340` → `model?.isFree ?? false`. Estimate = `(baseTokens + 10_000) / 1000 × $0.02 × markup 2.0`. For the observed run: `11_222/1000 × 0.04 = $0.44888` = **4,488,800 credits** — matching the log exactly. Real `gpt-4o-mini` pricing is ~100× cheaper; `ESTIMATED_USD_PER_1K_TOKENS = 0.02` is a flat constant that ignores the catalog entirely. |
| **D4** | The **system tenant has 0 credits**, so the preflight rejects before any LLM call.                                                                   | Loki, `env=production`: `errorCode: insufficient_credits` · `billing account 00000000-0000-4000-b000-000000000000 has 0, needs 4488800` · `msg: "Graph execution rejected before start"` · `graphId: langgraph:pr-review`. **16 rejections in 6h**, all `pr-review`.                                                                                                        |
| **D5** | Even with credits it would still fail — LiteLLM cannot route an unknown model id.                                                                    | Same trace: `AiExecutionError: Completion failed: internal`, `event: adapter.langgraph_inproc.error`.                                                                                                                                                                                                                                                                       |
| **D6** | **The "free" lane is also broken**, so D1's obvious fix is not sufficient.                                                                           | `bug.5266`: `gpt-oss-120b` — the _designated_ free model (`is_free: true`, `default_free: true`) — is billed post-call (`hasCost: TRUE`, 6579 credits for 577 tokens) driving a real account to `-6579`. Preflight treats free as `0n`; post-call bills actual. **Free is only free on one leg.**                                                                           |

**Duration:** `Cogni Git PR Review` has been NEUTRAL with all 3 graph gates dead on PRs #2424,
#2431, #2432, #2480, #2502, #2504 — continuously since at least **2026-09-24**. For ~6 days the repo
merged with no AI review, and nothing alarmed.

**This is the second occurrence of a named pattern.** Hub entry
[`insolvency-looks-like-infra`](https://cognidao.org/knowledge/insolvency-looks-like-infra) was
written after the 2026-09-28 Akash drain and says, verbatim: _"A low-water balance alarm is a
correctness control, not an ops nicety."_ It was never implemented. The credits plane then drained
and produced exactly the predicted signature — a degraded gate that reads as a mild warning.

> **The systemic defect is not the model pin. It is that a bankrupt gate is indistinguishable from
> a passing one.** `NEUTRAL` is what our review plane returns both when a PR is fine and when the
> reviewer is insolvent. That is a `check-reads-not-record` violation at the check-state level.

### The Q2 as-built map

| Axis                         | As-built                                                                                                                                                             | Verdict                                                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node identity                | `nodes.id` **is** the repo-spec `node_id`; also the OpenFGA `node:<id>` resource and the Loki `node` label (`shared/db/nodes.ts`, `OPERATOR_NODE_ROW_ID_IS_NODE_ID`) | ✅ Genuinely good — one derivation, no surrogate                                                                                                                                                                    |
| Node money **in**            | Per-node 0xSplits V2 Split (controller = node wallet), USDC on Base, config in the node's _own_ repo-spec                                                            | ✅ Designed ([`node-payments-empowerment`](../design/node-payments-empowerment.md)), partly built                                                                                                                   |
| Node **custody**             | Privy wallet owned by the node's P-256 key quorum → non-custodial _by construction_                                                                                  | ✅ Strong design. ⚠️ The load-bearing runtime assertion (operator secret _cannot_ sign an owned wallet) **has no test** — the design doc flags this itself                                                          |
| Node money **out** (LLM)     | `billing_accounts` → `credit_ledger` → LiteLLM meter → `charge_receipts`                                                                                             | ❌ **`billing_accounts.owner_user_id` is `notNull().unique()`** (`packages/db-schema/src/refs.ts:48-51`). A billing account is **strictly 1:1 with a human user.** A node structurally cannot hold one.             |
| Node money **out** (compute) | `compute_cost_intervals` keyed by actuator receipt, joined to `node_id`; **one** operator Akash wallet pays the whole fleet                                          | ❌ **Observation only.** Live `GET /api/v1/compute/balances` → `"balances": []` + an `akashSpend.byNode` spend report. No debit, no per-node budget, no cutoff, no top-up.                                          |
| Node → node **services**     | —                                                                                                                                                                    | ❌ **Does not exist.** No offering / price / rate-card / entitlement concept anywhere in `packages/repo-spec/src/schema.ts` or `infra/catalog/_schema.json`. The `beacon → poly` case has no primitive to stand on. |
| Who may spend                | OpenFGA `node:<id>` with `developer`, `env_manager`, `production_promoter`, node-admin                                                                               | ❌ No `spender` / `treasury` / `budget` capability. Derek's "allowed humans _and_ agents as admins" has the right substrate (ReBAC, principal-agnostic) but no money relation on it.                                |
| Staying funded               | —                                                                                                                                                                    | ❌ No low-water alarm, no auto-topup, no degradation ladder. Insolvency is a hard silent stop.                                                                                                                      |

### The team already named the right primitives

`task.5071` (**done**, PR #2251) states the boundary better than any spec does:

> _"Identity boundary: `node_id` = infra consumer; `wallet_scope`/provider consumer = custody;
> `billing_account` = payment tenancy; `scope`/`dao` = governance; `user`/`actor` = initiator.
> **No inference between them, no fake USD.** Future billing crosses only through an explicit
> idempotent projection after **a generic charge envelope** and **effective-dated sponsorship
> binding** exist."_

And [`akash-dao-ownership-boundaries`](https://cognidao.org/knowledge/akash-dao-ownership-boundaries):

> _"The free-hosting ledger records resource cost under `node_id`; it does not bill a DAO. … Never
> infer payment liability from the spawn initiator, creator wallet, DAO address, agent principal, or
> provider account."_

That discipline is correct and rare. **The two primitives it names as prerequisites were never
built.** Everything Q2 asks for is downstream of exactly those two.

### Strategic incoherence — three active specs, three different futures

| Doc                                                                  | Says                                                                                                                                                                                        | State                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `docs/spec/billing-evolution.md`                                     | Credits + `credit_ledger` + markup is the as-built system; "Forward Path" = x402 **eliminates credit balances**                                                                             | `status: active`                     |
| `docs/spec/x402-e2e.md` + `work/projects/proj.x402-e2e-migration.md` | **Delete** `credit_ledger`, `billing_accounts` balances, Privy, Splits, OpenRouter. Hyperbolic only.                                                                                        | project `state: Active, priority: 1` |
| `.claude/skills/payments-expert`                                     | _"This is NOT the old 'delete credits, delete Splits' direction. Credits remain the human pre-auth layer. Splits remain the inbound revenue rail."_ Only the **outbound** hop becomes x402. | current                              |

The skill is right and the specs are stale — but the specs are what an agent reads. **A stale model
pin sitting in the spec for days is the predictable output of a doc plane that cannot say which
future is real.** Fixing this costs nothing and is a prerequisite for the rest.

## Findings

### Option A — Build the economic layer `identity-model.md` already specifies (`actors`)

> **This option replaces an earlier draft of this doc that proposed making `billing_accounts`
> polymorphic (`owner_kind ∈ {user,node,scope,system}`). That draft was a design error. Recorded as
> R0 below rather than deleted, because the error is instructive.**

- **What**: `identity-model.md` already defines the economic subject — **`actor_id`**, _"economic
  subject (earns, spends, attributed)"_, with kinds **`user | agent | system | org`**, living in
  `actors.id` with `actor_bindings` (wallets, external refs) and **`budget_allocations`** (FK
  `actor_id`). A node's treasury is an **`org` actor**, not a billing account. Set the
  already-planned `charge_receipts.actor_id` column.
- **The catch — it is specified but entirely unbuilt.** Verified: no `actors` / `actor_bindings` /
  `budget_allocations` table exists in `packages/db-schema/src/` or any migration, and
  `charge_receipts` has no `actor_id` (the spec's own scoping table marks it _"Column (planned)"_).
  The economic layer of the identity model is aspirational.
- **Pros**: Invents nothing. No new vocabulary (the spec's **synonym prohibition** forbids
  `org_id`/`account_id`/`tenant_id`/`contributor_id` as new terms — a polymorphic billing-account
  owner would have smuggled one in). `billing_accounts` stays untouched and human-1:1, so **the RLS
  blast radius disappears** — the new tables are greenfield and get a correct policy on day one.
  `actors.kind` already includes `agent`, so "an agent spends on a node's behalf" is expressible
  without a model change, matching the proven `node.developer: [user, agent]` precedent.
- **Cons**: Three new tables instead of one altered column — more surface, but _specified_ surface.
  Requires deciding which runs are node-initiated vs user-initiated (see W3).
- **OSS tools**: none needed; this is building an existing internal spec.
- **Fit**: Restores the invariant `task.5071` asserted and the code currently violates —
  `billing_account = payment tenancy`, `actor = economic subject`. Today the _only_ spendable subject
  is a human's tenant, which is why a webhook-driven review run had to bill the system tenant.

### Option B — Explicit, effective-dated payer bindings

- **What**: `payer_bindings(subject_kind, subject_ref, payer_billing_account_id, valid_from, valid_to,
authorized_by, reason)`. Liability is a **row**, never an inference. Operator-sponsored v0 becomes a
  binding to the system account with an explicit authorizing actor — "free hosting" turns into
  _auditable sponsorship_ instead of an absent concept.
- **Pros**: This is literally task.5071's "effective-dated sponsorship binding." Makes the
  `akash-dao-ownership-boundaries` no-inference rule _enforceable_ rather than aspirational. Effective
  dating gives correct historical attribution when a payer changes mid-month — the thing that makes
  retroactive billing disputes unresolvable if you skip it.
- **Cons**: One more join on every cost projection. Requires deciding who may authorize a binding
  (operator admin? DAO vote? both, per type?) — a real governance question, not a schema one.
- **OSS tools**: none needed; the pattern is standard bitemporal accounting.
- **Fit**: Composes with the existing OpenFGA plane — `authorized_by` is a principal, and the check is
  an OpenFGA relation, so humans and agents are treated identically (exactly Derek's requirement).

### Option C — Double-entry ledger, balance as a projection

- **What**: Today `billing_accounts.balance_credits` is a **mutable column** alongside `credit_ledger`
  entries. Make immutable balanced postings the truth and the balance a derived projection.
- **Pros**: Kills a whole bug class by construction. `bug.5266`'s negative balance, `story.5053`'s
  "receipt is not liveness", and balance/ledger drift all become _queries_ instead of _incidents_. A
  node→node transfer is one balanced transaction with two legs — no bespoke transfer code.
- **Cons**: Real migration cost. Full engine adoption is over-build at 1 dev / 0 users.
- **OSS tools**: **TigerBeetle** (Apache-2.0, purpose-built double-entry financial ledger, single
  binary, the natural pick for a crypto-native shop); **Formance Ledger** (Apache-2.0, Numscript DSL,
  designed for exactly "money moves between accounts inside a platform"); **Midaz** (Apache-2.0). All
  self-hostable → consistent with the OSS-sovereign red line.
- **Fit**: **Adopt the invariant now, defer the engine.** Keep `balance_credits` as a _cached_
  projection, add a reconcile check that fails loudly on drift, and make `credit_ledger` authoritative.
  Revisit TigerBeetle at real volume. This is ~1 migration for ~80% of the benefit.

### Option D — One charge envelope, many cost sources

- **What**: `charge_envelope` — provider-neutral, idempotent on `(source_system, source_reference)`,
  carrying `subject` (node/service/env), `cost_native`, `cost_usd`, `evidence_ref`, `settled_at`.
  `charge_receipts` (LLM, via LiteLLM) and `compute_cost_intervals` (Akash, via the actuator) both
  **project into** it rather than being parallel universes.
- **Pros**: task.5071's other named primitive. One place to answer "what did node X cost, who paid,
  is it settled." Lets compute finally become a _debit_ instead of a _report_, so
  `/compute/balances` can return an actual per-node balance. New cost sources (a node→node service, a
  third-party API) are new _projections_, not new billing systems.
- **Cons**: Must not become a god-table. The discipline in `compute_cost_intervals` — _"No user, actor,
  scope, DAO, payer, sponsor, wallet-owner, or billing-account identity belongs in this table"_ — must
  survive: the envelope carries the **cost subject**, the _binding_ resolves the payer.
- **OSS tools**: **OpenMeter** (Apache-2.0 — usage metering + entitlements + balance, almost exactly
  this shape); **Lago** (OSS usage-based billing). Recommendation: **steal the data model, don't adopt
  the service** — our meters (LiteLLM, Akash actuator) are already built and provider-truthful, and
  replacing them would discard the hardest-won correctness in the system.
- **Fit**: Both existing meters already emit idempotent, provider-native evidence. This is a
  projection layer over work already done.

### Option E — Node↔node service offerings + entitlements

- **What**: Provider node declares offerings in its **own** repo-spec (`services_offered: [{id, unit,
price_credits_per_unit, capability}]`) — a node-controlled surface, consistent with
  `node-baas-architecture.md`'s node-controlled-surfaces table and `SINGLE_HOME`. Consumer node holds
  a `service_entitlement` with a **budget cap**. Cap = pre-auth; envelope = meter; settlement = a
  two-legged ledger transfer between the two node accounts.
- **Pros**: The `beacon → poly` case, finally expressible. Intra-fleet settlement is instant, free, and
  never touches chain. Authorization needs **no new mechanism**: add a `spender` relation to the
  existing OpenFGA `node:<id>` type — humans and agents are already the same kind of principal there,
  which is precisely what Derek asked for.
- **Cons**: Genuinely new surface (schema + API + UI + governance). Pointless before A/B/D land.
  Pricing/discovery/disputes are a product design problem, not just plumbing.
- **OSS tools**: OpenMeter's entitlement model; **x402** for _external_ settlement; **ERC-8004** agent
  registry (already in `agent-registry.md` as export-only).
- **Fit**: Requires A (node accounts), B (who pays), D (metering). It is the _payoff_, not the start.

### Option F — Per-request x402 everywhere, no balances (the `x402-e2e.md` future)

- **What**: Delete credits. Every request settles USDC on Base via x402 `upto`.
- **Pros**: No insolvency class. No top-up. Crypto-native. Machine-payable by design.
- **Cons**: Four that matter. (1) It makes **per-request metering load-bearing** — and `bug.5266` +
  `story.5053` prove we cannot yet meter reliably; x402-everywhere converts a billing bug into a
  _payment_ bug. (2) Hyperbolic is OSS-models-only. (3) It deletes the **human pre-auth layer** — a
  human wants a spend cap, not to sign USDC per request. (4) Node→node x402 requires every node to hold
  a hot signing key, **reintroducing exactly the custody problem** the Privy owner-quorum design just
  solved non-custodially.
- **Fit**: x402 is the right rail **between** organizations and for agent-to-agent payment. It is the
  wrong replacement for intra-fleet accounting and for human pre-auth.

## E2E workflows

The architecture above is only real if it produces concrete behaviour for concrete actors. Six
workflows; each row marks what exists today.

### W1 — A human spawns a node (today's free v0)

| #   | Step                                                                                                                                                                                                                    | Today                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Human (`user_id` + their `billing_account_id`) runs the wizard → `nodes` row, `nodes.id` **is** the `node_id`                                                                                                           | ✅                                                 |
| 2   | Node gets an **`org` actor**; its `node_id` is recorded in `actor_bindings` (per `BINDING_IS_THE_MULTI_ENV_KEY` — resolve through the binding, never hardcode a per-env surrogate)                                      | ❌                                                 |
| 3   | A **sponsorship** row, effective-dated: this org actor's costs are borne by the `system` actor. `authorized_by` = the operator admin principal, `reason = free-v0`. Liability is a row, never inferred from who clicked | ❌                                                 |
| 4   | Node page shows: _"Sponsored by Cogni · you owe $0.00 · compute to date 4.53 ACT"_                                                                                                                                      | ❌ — cost is invisible to the human who spawned it |

This is what `akash-cicd-pareto-map`'s "free v0, cost per DAO" means made legible: free stops being
_absent accounting_ and becomes _explicit, auditable sponsorship_.

### W2 — The node consumes compute

1. Actuator opens an Akash lease → `akash_tx_allocations` receipt + `compute_cost_intervals` ✅ (task.5071)
2. **NEW**: the interval projects a **`charge_envelope`** row — subject = the node's org actor, `cost_native` = uact, `evidence_ref` = the receipt, idempotent on `(provider, resource_id, interval)`. The cost table itself stays identity-free, exactly as its header demands
3. **NEW**: the envelope resolves its payer through the sponsorship **effective at the interval's time** — so a payer change mid-month attributes correctly instead of retroactively rewriting history
4. **NEW**: if the payer is the node's own actor and `budget_allocations` is exceeded → **alarm, then the ladder**. Never silently close the lease — that is precisely the 2026-09-28 failure `insolvency-looks-like-infra` records
5. **NEW**: `GET /api/v1/nodes/{id}/spend` → per service, per env, who paid, budget remaining

### W3 — The node's own LLM spend (this is what broke PR review)

1. Node app calls LiteLLM with `x-litellm-spend-logs-metadata: {node_id}` ✅
2. `CogniNodeRouter` → `<node>/api/internal/billing/ingest` → `charge_receipts` ✅
3. **NEW**: set the already-planned `charge_receipts.actor_id`. A **node-initiated** run (a schedule, a
   webhook-driven PR review) attributes to the node's **org actor**. A **user-initiated** run attributes
   to that user's actor. `billing_account_id` stays the tenant — **no overload**

> **This is the whole Q1 bug, stated structurally.** A PR-review run is node-initiated, but no
> node-shaped spender exists — so it fell to the `system` tenant: a human-shaped billing account with
> no owner watching it, no budget, and no top-up path. It drained, and because `NEUTRAL` reads as
> _fine_, nobody learned for six days. With an org actor + a sponsorship + a low-water alarm, day one
> would have paged.

### W4 — `beacon` sells a metered service to `poly`

1. **beacon declares, in its OWN repo-spec** (a node-controlled surface, `SINGLE_HOME`):
   `services_offered: [{id: signal-feed, unit: request, price_credits: 1000, capability: beacon.signal.read}]`
2. **poly's `treasurer`** (human **or** agent) accepts an entitlement:
   `service_entitlements(consumer_actor = poly org, provider_actor = beacon org, offering_id, budget_cap_credits, valid_from/to)`. **The cap is the pre-auth** — poly can never be surprised
3. poly's runtime calls beacon as its node principal. beacon checks OpenFGA + the entitlement, serves, emits a usage event
4. Envelope: subject = poly org actor, counterparty = beacon org actor, cost = units × price
5. **Settlement is an adapter.** Intra-fleet → a two-legged ledger transfer (debit poly, credit beacon): instant, free, reversible, no chain. Cross-org → **x402 USDC on Base**. Same envelope both ways
6. Both sides see it: poly's page _"beacon/signal-feed — 12,400 credits, 62% of cap"_; beacon's page lists poly as a customer

### W5 — Who may administer a node's spend (humans **and** agents)

Reuses the existing machinery rather than inventing any:

| Concern         | Mechanism                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relations       | `node:<node_id>` gains `treasurer` + `spender`, both typed `[user, agent]` — the same principal-agnostic shape already proven by `node.developer: [user, agent]`                        |
| `treasurer` may | set a budget cap · authorize a sponsorship change · grant/revoke an entitlement · trigger top-up                                                                                        |
| `spender` may   | incur cost within the cap                                                                                                                                                               |
| Grant flow      | the **existing** access-request → approve path (`POST /api/v1/nodes/{id}/developers` precedent), not a new endpoint                                                                     |
| Cross-env       | the grant resolves through a stable binding (wallet / GitHub login), never a per-env `user_id` — `BINDING_IS_THE_MULTI_ENV_KEY`                                                         |
| Boundary        | `treasurer` is operational RBAC. It is **not** DAO governance authority and **not** the distribution executor — `identity-model.md` keeps those three planes distinct, and so must this |

### W6 — Staying funded (the reliability question)

1. The node's `actor_bindings` already carry its Privy wallet + Split (from `node-payments-empowerment`)
2. Envelope-derived balance crosses `low_water_credits` → **alarm** (the P0 control) → policy fires
3. `topup_source`, in ascending sovereignty: (a) extend operator sponsorship — a new effective-dated row, auditable; (b) the node's **own** Split balance → its wallet → credits, node-signed and non-custodial; (c) a human's card / USDC
4. If top-up fails: **paid model → free model → queue → deny**, each step emitting an event. The review plane should have taken step 2 automatically. Silence is the one unacceptable branch

## Recommendation

**A + B + D now, as one keystone. C's invariant cheaply. E after. F as an adapter, never as an
architecture. And P0 first, because an unmonitored ledger is worse than no ledger.**

The single highest-leverage observation: **one schema change unblocks four product surfaces.** Node
credit balances, compute debits, node→node service billing, and spend-admin roles are all blocked on
the same missing thing — _a payer account that is not a human, plus an explicit statement of who owes
what_. Everything else is a consumer of that primitive.

The coherent resolution of the x402 contradiction: **x402 is a settlement adapter behind the charge
envelope, not a replacement for it.** Intra-fleet → ledger transfer. Cross-org → x402 USDC. Human
pre-auth → credits. All three project into one envelope. That is what the `payments-expert` skill
already concluded; the specs simply never caught up.

### Pareto path

**P0 — Make insolvency loud (days). Not billing architecture; the control that makes it safe.**
This is the _second_ time insolvency presented as infra. Cheapest branch of the tree, per our own hub entry.

| #        | Change                                                                                                                                                                  | Why                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **P0.1** | `bug.5266` **first**: free must be free on **both** legs; no account charged below zero for a free model; `credits_summary` tolerates negative                          | **Ordering is load-bearing — see the correction below.** Must land _with or before_ the model re-pin |
| P0.2     | Pin `review.model` → `gpt-oss-120b`; **and** validate `review.model` against the live catalog at spec-load/gate time — an unresolvable model must **fail**, not neutral | D1 + D2. The pin is the symptom; the missing validation is the defect                                |
| P0.3     | Make a starved gate visually distinct from a passing one: `insufficient_credits` / unknown-model → a distinct check state + Loki-alertable event                        | D-meta. The actual bug: NEUTRAL means both "fine" and "bankrupt"                                     |
| P0.4     | Low-water balance alarm on **every** paid account the fleet depends on — system-tenant credits, operator Akash wallet, provider balance                                 | `insolvency-looks-like-infra`, written and not implemented                                           |
| P0.5     | Mark `x402-e2e.md` + `proj.x402-e2e-migration.md` superseded-in-part; correct `billing-evolution.md`'s "Forward Path"                                                   | Free. Three active futures is how a stale pin survives a week                                        |

> **Sequencing correction (found in design review of this doc).** An earlier draft ordered the
> model re-pin before the free-model billing fix. That is wrong. `gpt-oss-120b` passes _preflight_
> (`isModelFree` → `0n`) but `bug.5266` proves it is **billed post-call**, and
> `POST_CALL_NEVER_BLOCKS` means the charge completes regardless of balance. Re-pinning first would
> therefore convert a silent-NEUTRAL outage into a **silent negative-balance drain on the system
> tenant** — a worse failure, because it also breaks `credits_summary` (ZodError on negative). Fix
> the free lane first, or ship both in one PR.

**P1 — Keystone: build the specified economic layer.** (Options A + B)
`actors` (`kind = user|agent|system|org`) + `actor_bindings` + `budget_allocations`; the node's
treasury is an **`org` actor**; effective-dated **sponsorship** rows carry liability; set
`charge_receipts.actor_id`; `credit_ledger` authoritative with a drift check (Option C's invariant,
not its engine). **`billing_accounts` is not touched** — it stays payment tenancy, human-1:1, per the
prohibited-overloading table. Creating a node must **not** create liability; the sponsorship row is a
separate, authorized act.

**P2 — One charge envelope.** (Option D) `charge_receipts` + `compute_cost_intervals` project into it;
compute becomes a real debit through the payer binding; `/compute/balances` returns a per-node balance.

**P3 — Node↔node services.** (Option E) `services_offered` in the provider's repo-spec;
`service_entitlements` with budget caps; OpenFGA `spender` relation so a node's humans _and_ agents
share one authorization path. `beacon → poly` becomes expressible.

**P4 — Reliable funding.** Auto-topup policy per account (`low_water_credits` + `topup_source`:
node Split balance / DAO treasury / human card), triggered by the P0.3 alarm rather than a new
mechanism. And a **degradation ladder** instead of a hard stop: paid → free → queue → deny, per
workload class. The review plane should have _degraded to the free model_, not gone silent for six days.

### Trade-offs explicitly accepted

- **Not adopting TigerBeetle/Formance/OpenMeter yet.** At 1 dev / 0 users the engines are over-build,
  and our meters are the hardest-won correct code in the system. We take their _invariants_ and leave
  the door open. Revisit at real volume or when a second fleet appears.
- **Credits stay USD-denominated** (`CREDITS_PER_USD = 10_000_000` is a protocol constant and works).
  USDC is a settlement asset, not the ledger unit. Needs Derek's confirmation — see Open Questions.
- **Intra-fleet node→node billing does not touch chain.** Faster, free, reversible. Cost: it is
  operator-trusted bookkeeping, not trustless settlement. Correct for v0; x402 is the exit.

## Design review verdict

Run against this doc's own recommendation. Split, because P0 and P1+ are separable and deserve
different verdicts.

| Dimension              | P0 (stop the bleeding) | P1+ (the foundation)       | Rationale                                                                                                                                                               |
| ---------------------- | ---------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simplicity             | **PASS**               | **PASS** (was CONCERN)     | P0 is a config pin + a validation + an alarm. R0's correction made P1 _smaller_: build 3 specified tables instead of altering the FK target every other table points at |
| OSS-First              | **PASS**               | **CONCERN**                | Meters stay OSS (LiteLLM, Akash chain). Declining TigerBeetle/Formance is defensible at this stage but is how bespoke ledgers accrete — see R3                          |
| Architecture Alignment | **PASS**               | **PASS** (was **FAIL**)    | The first draft violated `identity-model.md` § Prohibited Overloading twice (R0). Corrected to the spec's own `actor_id`/`kind=org`                                     |
| Boundary Placement     | **PASS**               | **FAIL**                   | Unresolved. Billing spans app + `scheduler-worker` + Temporal activities; port placement is undecided and app-local would break the compute path — R2                   |
| Content Boundaries     | **CONCERN**            | **CONCERN**                | The P0–P4 roadmap lives in a research doc; it belongs in a project once one owns this line                                                                              |
| Scope Discipline       | **PASS**               | **PASS**                   | Split into `story.5056` (foundation) / `bug.5327` (outage) / `bug.5328` (broken guard) rather than one bundle                                                           |
| Risk Surface           | **PASS**               | **CONCERN** (was **FAIL**) | R0's correction removes the cross-tenant-leak landmine entirely by not touching `billing_accounts`. Residual: get `actors` RLS closed on day one (R1)                   |

### Verdict

- **P0 — APPROVE**, with the R4 ordering binding: `bug.5266` lands **before or with** the model
  re-pin. It is independent of every open P1 question, and the outage is live.
- **P1+ — REQUEST CHANGES.** Two blockers before implementation: **R2** (decide port placement; a
  shared package, not app-local) and **R1** (`actors` RLS deny-all by default, with tests). **R5**
  (node-initiated vs user-initiated classification) needs an explicit rule at the launcher boundary.
- **P3 (node↔node services) — NEEDS DISCUSSION**, not engineering. Open Questions 1 and 3 are
  strategy calls only Derek can make: the ledger's denomination, and whether the operator becomes a
  counterparty in its own economy.

**Honest note on this review's own value:** the single most valuable finding (R0) came from Derek
asking whether the design had been checked against `identity-model.md` — not from the review pass. The
review had already "passed" Architecture Alignment while the recommendation violated a hard constraint
in a spec it never read. **A review that does not read the governing spec is not a review.**

## Blocking risks in this recommendation (found in design review)

These are defects **in the plan above**, not in the as-built system. Named here so they are not
rediscovered during implementation.

### R0 — The first draft of this recommendation violated a hard constraint (kept, not hidden)

The earlier draft proposed `billing_accounts.owner_user_id` nullable + `owner_kind ∈
{user,node,scope,system}` + `owner_ref`. `identity-model.md` § Prohibited Overloading forbids exactly
that, in two independent ways:

| Rule                                                                                                                                                                        | Violation                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| _"`billing_account_id` must never be used for … deployment identity. It is payment tenancy only."_                                                                          | `owner_ref = node_id` **is** deployment identity inside the tenancy key                           |
| **Synonym prohibition**: _"Do not introduce `org_id`, `account_id`, `tenant_id`, `project_id`, or `contributor_id` as new terms. The six keys above are the complete set."_ | A polymorphic owner smuggles in an `org`-shaped key alongside `actor_id`, which already covers it |

It also contradicted the relationship `node_id (1) ──── (N) billing_account_id` — _"a node **serves**
multiple tenants"_. A billing account is a tenant **inside** a node, so a node cannot coherently
_own_ one.

**Root cause of my error: I designed from the code schema and never read the identity spec.**
`packages/db-schema` contains no `actors` table, so "there is no non-human spender" read as a missing
_primitive_ rather than an unbuilt _specified_ one. The correct move — build `actors(kind=org)` — is
strictly smaller and touches no existing RLS. **Generalisable lesson: when a primitive appears
missing, check whether it is specified-but-unbuilt before inventing a replacement.**

### R1 — `actors` RLS must be designed closed on day one (greenfield, not a migration hazard)

R0's correction **removes** the nullable-owner RLS landmine entirely (`billing_accounts` is untouched,
so every existing direct and transitive policy is unaffected). The residual risk moves to the new
tables, where it is far cheaper:

- Per `RLS_COVERAGE`, `actors` has an FK to `users` (for `kind=user`) ⇒ RLS **must** be `ENABLE +
FORCE`. A table read only by the `app_service` BYPASSRLS role satisfies this with **deny-all — no
  policy** (fail-closed), which is the correct v0 shape.
- The mistake to avoid is the mirror of R0's: a policy like `owner_user_id = current_setting(...) OR
user_id IS NULL` would expose **every org actor to every authenticated user**. If an `app_user` read
  path is ever needed, authorize it through **node membership in OpenFGA**, not a NULL fallback.
- Ship tests asserting: an org actor is invisible to an unrelated `app_user`, and visible to its own
  node principal.

### R2 — Boundary placement is unspecified, and billing has >1 runtime

`packages-architecture.md`: a capability used by more than one runtime belongs in a shared package.
Billing is consumed by the operator app, `scheduler-worker`, and Temporal activities. Today the
precedent is split — pure math is shared (`packages/node-core/src/core/billing/pricing.ts`) while the
port is app-local (`nodes/operator/app/src/ports/accounts.port.ts`). A `PayerBindingPort` /
`ChargeEnvelopePort` placed app-local would leave `scheduler-worker` unable to resolve a payer, which
is exactly the path compute cost arrives on. **Decide placement before writing the migration.**

### R3 — "Adopt the invariant, defer the engine" is how bespoke half-ledgers get built

Honest self-assessment of the OSS-first call. Declining TigerBeetle/Formance is defensible at 1 dev /
0 users, and the _meters_ stay OSS-provided (LiteLLM, the Akash chain) — the bespoke part is ~2 tables
plus a reconcile query. But this is the same reasoning that produces a homegrown ledger by accretion.
**Re-litigate before a third cost source or a second fleet lands**, and keep postings shaped so a
TigerBeetle/Formance import stays mechanical.

### R5 — Node-initiated vs user-initiated is a judgement call, not a lookup

W3 hinges on classifying a run. A webhook-driven PR review is clearly node-initiated; a human chatting
in the node's UI is clearly user-initiated. An **agent** holding a node grant and running a scheduled
graph is the ambiguous middle, and `identity-model.md` flags the adjacent unresolved question itself
(the on-behalf-of earnings-ownership policy, OPEN since 2026-08-15). Pick the rule explicitly at the
launcher boundary — where `subjectId` is already attached by trusted server launchers — and never
infer it downstream from whichever credential happened to arrive.

### R4 — `story.5056` has no `done =` yet

Filed at `needs_triage` with `outcome: null`. Per the operator orientation, `done =` (desired e2e
behavior + its live proof) must be written into `outcome` as an ordered checklist **before**
implementation starts. Not a design flaw; an unfinished step.

## Open Questions

1. **Ledger unit.** Node accounts denominated in credits (USD-pegged, operator-minted) or USDC
   (on-chain)? One currency or two? This decides whether node→node billing touches chain at all. My
   lean: credits for the ledger, USDC for settlement — but it is a strategy call, not a technical one.
2. **Who authorizes a `payer_binding`?** `akash-dao-ownership-boundaries` says custody moves by DAO
   governance action. Should _liability_ be the same? Operator admin for sponsorship, DAO vote for
   self-funding, per binding type?
3. **Is the operator a counterparty in its own economy?** It already sells CI/CD, compute, review, and
   knowledge. If the operator gets a node account, the fleet becomes a real internal economy with the
   operator as a participant rather than a landlord. That looks like the right end state and is the
   biggest strategy question here.
4. **Non-custody is still unproven at runtime.** `node-payments-empowerment.md` §2 flags that no test
   proves an owned Privy wallet _rejects_ a non-owner signature. Until that test exists, "non-custodial"
   is a type-level claim, not a verified property. Independent of this research; should not stay open.
5. **Per-request cost estimation.** `ESTIMATED_USD_PER_1K_TOKENS = 0.02` + a flat 10k-token buffer is
   model-blind and ~100× off for cheap models. Should preflight read catalog pricing? Or should
   preflight be replaced by a spend cap + non-blocking post-call billing (which the system already
   does via `POST_CALL_NEVER_BLOCKS`)? The latter is simpler and matches P4's ladder.

## Proposed Layout

**Project**: no new `proj.*`. This slots under the existing payments/billing line and should _correct_
`proj.x402-e2e-migration` rather than compete with it.

> **Content-boundary note.** The P0–P4 table above is roadmap content living in a research doc. Per
> `docs-work-system.md#content-boundaries` it belongs in a project once one owns this line; it is here
> only because the `/research` template asks for a proposed layout. Move it, don't duplicate it.

**Story**: `story.*` — "Nodes can hold, spend, and be billed for services under an explicit payer
binding." `done =` a node account exists, compute and LLM cost both debit it through one envelope
under an effective-dated binding, and a starved account alarms before it degrades a gate — proven on
candidate-a.

**Specs**:

- **New** `docs/spec/node-billing-foundations.md` — the SSoT this research argues for. Invariants:
  `ACCOUNTS_ARE_SUBJECTS`, `LIABILITY_IS_AN_EXPLICIT_BINDING` (never inferred),
  `ONE_CHARGE_ENVELOPE`, `POSTINGS_ARE_TRUTH_BALANCE_IS_DERIVED`,
  `SETTLEMENT_IS_AN_ADAPTER` (ledger-transfer | x402 | credits), `INSOLVENCY_MUST_ALARM_BEFORE_IT_DEGRADES`.
- **Amend** `billing-evolution.md` — correct the "Forward Path".
- **Demote** `x402-e2e.md` + `proj.x402-e2e-migration.md` to "x402 as settlement adapter".

**Tasks** (rough sequence; each PR-sized):

1. `bug.*` — review plane: free-model pin + catalog validation + loud failure (P0.1, P0.2)
2. `bug.*` — fleet low-water balance alarms (P0.3) — _worth doing first; it is the cheapest branch_
3. `bug.5266` — free is free on both legs; negative-balance tolerance (P0.4)
4. `task.*` — doc-plane reconciliation (P0.5)
5. `task.*` — `billing_accounts` polymorphic owner + `payer_bindings` migration (P1)
6. `task.*` — `charge_envelope` + project both meters into it (P2)
7. `task.*` — compute debits through the binding; `/compute/balances` returns a balance (P2)
8. `spike.*` — node↔node service offering + entitlement design (P3)
9. `task.*` — auto-topup policy + degradation ladder (P4)

## Related

- [design.node-payments-empowerment](../design/node-payments-empowerment.md) — non-custodial node wallet/Split (money **in**; this doc is money **out** + between)
- [billing-evolution.md](../spec/billing-evolution.md) · [x402-e2e.md](../spec/x402-e2e.md) · [node-baas-architecture.md](../spec/node-baas-architecture.md)
- Hub: [`insolvency-looks-like-infra`](https://cognidao.org/knowledge/insolvency-looks-like-infra) · [`receipt-is-not-liveness`](https://cognidao.org/knowledge/receipt-is-not-liveness) · [`akash-dao-ownership-boundaries`](https://cognidao.org/knowledge/akash-dao-ownership-boundaries) · [`akash-cicd-pareto-map`](https://cognidao.org/knowledge/akash-cicd-pareto-map) · [`check-reads-not-record`](https://cognidao.org/knowledge/check-reads-not-record)
- Work items: `task.5071` (done — named both missing primitives) · `bug.5266` · `story.5053`
