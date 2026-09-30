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

### Option A — Accounts are subjects, not users (generalize `billing_accounts`)

- **What**: `owner_user_id` → nullable; add `owner_kind ∈ {user, node, scope, system}` + `owner_ref`,
  with a partial unique index per `(owner_kind, owner_ref)`. A node gets an account.
- **Pros**: Smallest possible diff that makes a node a payer. **Every** existing path already keys on
  `billing_account_id` — preflight, `credit_ledger`, `charge_receipts`, `virtual_keys`, `connections`,
  `execution_grants`, RLS — so they all work unchanged. No new subsystem.
- **Cons**: Touches the FK target every other table points at; needs a careful migration + RLS review.
  Tempting to let it imply liability — it must not (see Option B).
- **OSS tools**: This is the AWS Organizations _payer account_ shape; GnuCash / `ledger` / `beancount`
  all model accounts as subjects rather than users. No library needed — it is a schema decision.
- **Fit**: Directly satisfies task.5071's `billing_account = payment tenancy` axis, which is currently
  a lie (it is _user_ tenancy).

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

**P1 — Keystone: accounts are subjects; liability is a binding.** (Options A + B, one migration)
`billing_accounts.owner_kind`/`owner_ref`; `payer_bindings` effective-dated; `credit_ledger`
authoritative with a drift check (Option C's invariant, not its engine). Creating a node must **not**
create liability — the binding is a separate, authorized act.

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

## Blocking risks in this recommendation (found in design review)

These are defects **in the plan above**, not in the as-built system. Named here so they are not
rediscovered during implementation.

### R1 — `owner_user_id` nullable silently breaks every transitive RLS policy, and the obvious patch is a cross-tenant leak

`0004_enable_rls.sql` states its own invariant in a comment: _"Since no row has `owner_user_id` =
NULL, unset context returns zero rows (silent deny)."_ P1 makes that column nullable, so:

| Policy shape                                                                                                                                                                                                   | Effect on a node-owned account (`owner_user_id IS NULL`)                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Direct, on `billing_accounts`: `owner_user_id = current_setting(...)`                                                                                                                                          | `NULL = x` → `NULL` → still denied. **Accidentally safe.**                                                                                |
| Transitive, on `virtual_keys` / `credit_ledger` / `charge_receipts` / `payment_attempts` / `connections`: `billing_account_id IN (SELECT id FROM billing_accounts WHERE owner_user_id = current_setting(...))` | The subquery can **never** match → **no `app_user` principal can read a node's own ledger at all.** Functional dead-end, discovered late. |
| The tempting "fix": `... OR owner_user_id IS NULL`                                                                                                                                                             | Exposes **every** node account to **every** authenticated user. **This is the landmine.**                                                 |

**Required shape:** node-owned accounts get a **separate, additive** policy path authorized by node
membership (the OpenFGA plane) or restricted to `app_service` — never a nullable-owner fallback
inside the existing `app_user` policies. The migration must add RLS tests that assert a node account
is invisible to an unrelated user _and_ visible to its own node principal. Treat this as the
highest-risk part of P1, not an afterthought.

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
