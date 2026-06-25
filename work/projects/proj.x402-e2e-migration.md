---
id: proj.x402-e2e-migration
type: project
primary_charter:
title: "x402 E2E Migration: keep credits + Splits, change only outbound to x402 → Hyperbolic"
state: Active
priority: 1
estimate: 13
summary: "Keep inbound credits + 0xSplits (95/5) ~unchanged; credits stay the human pre-auth lane. Change ONLY the outbound cost hop: retire the dead OpenRouter Coinbase-Commerce top-up and pay inference per-request via x402 → Hyperbolic, signed by the Privy operator wallet."
outcome: "Inbound is two lanes — credits (human/pre-auth) OR x402 (agent/per-request) → Split 0x4C4e (95/5) → operator wallet — both unchanged. Outbound retires OpenRouter funding and runs x402 micro-payments to Hyperbolic per request, debited against the credit budget, with a per-request spend-vs-credit margin guard. LiteLLM stays the cost oracle; an x402-client shim handles 402 → sign → retry."
assignees: derekg1729
created: 2026-02-26
updated: 2026-06-25
labels: [billing, x402, web3, provider, migration]
---

# x402 E2E Migration: keep credits + Splits, change only outbound to x402 → Hyperbolic

> Spec: [x402-e2e.md](../../docs/spec/x402-e2e.md)
> Research: [gateway-billing-analysis.md](../../docs/research/gateway-billing-analysis.md)
> Bug: bug.5063 — pay UI is Stripe/card; OpenRouter crypto top-up returns 410 Gone; OpenRouter inference is prepaid-key only (401, not x402).
> Knowledge: `x402-usdc-egress` (operator hub) — outbound USDC egress design.

## Goal

Keep the inbound credit + 0xSplits rail essentially as-built; **change only the outbound cost hop** from the dead OpenRouter top-up to per-request **x402 → Hyperbolic**.

The original premise of this doc — "delete the credit system, pure x402 inbound per-request" — was **wrong for humans** and is corrected here. Verified facts (2026-06-25):

- OpenRouter **removed programmatic crypto top-up** — Coinbase-Commerce funding returns **410 Gone** (bug.5063).
- OpenRouter inference is **prepaid-key only** — it answers **401**, not 402; there is no x402 negotiation to ride on outbound.
- The pay UI is **Stripe/card**. Cogni is **API-first with NO card-on-file ever** — so we cannot lean on a fiat top-up for either humans or the operator.

The correction: **inbound credits + 0xSplits (95/5) stay ~90% unchanged.** Humans buy a credit budget once (they cannot sign a per-request authorization for a multi-day schedule); the operator wallet then runs x402 micro-payments **on their behalf** for outbound inference, debiting the credit balance per request. Agents that _can_ sign per-request still pay inbound via x402 directly. The only real change is retiring the dead OpenRouter funding leg and replacing it with x402 → Hyperbolic outbound.

**The end state:** A node operator keeps the existing credits/Splits inbound rail and adds a Hyperbolic account + API key + an x402 facilitator choice (self-host preferred per OSS-sovereign ethos). The operator's 95% share of inbound revenue becomes the working capital that pays inference per request via x402.

## What stays vs changes

This is the load-bearing correction. **Inbound is untouched; only the outbound hop changes.**

### STAYS (~unchanged — do NOT delete)

- **Inbound credits ledger** — humans pre-authorize by buying a credit budget; balance debited per request. Credits are the **human / pre-auth lane**.
- **0xSplits (95/5) does NOT change** — user USDC → Split `0x4C4e` (95/5) → operator wallet. It still splits **inbound** revenue. The operator's 95% becomes the working capital for outbound inference.
- **Split-hash guard** — `SPLIT_CONFIG_MISMATCH` repo-spec guard is untouched.
- **`charge_receipts`** — audit trail kept (add x402 outbound columns).
- **`pricing.ts`** — kept; purchase-time margin lock is replaced by a per-request spend-vs-credit guard.
- **LiteLLM (per-node service)** — stays as the cost oracle; all pricing math keeps flowing through the existing cost callback.
- **Privy operator wallet** — kept and now used to **sign** outbound x402 payments (EIP-3009 via `signTypedData`). Capability already exists — same path as the Polymarket CLOB integration; only a `NO_GENERIC_SIGNING` named-method gap to close.
- **Epoch ledger** — untouched.

### Inbound = two lanes (both kept)

| Payer | Lane    | Mechanism                                               |
| ----- | ------- | ------------------------------------------------------- |
| Human | Credits | Buy a credit budget once → debit per request (pre-auth) |
| Agent | x402    | Per-request signed payment inbound                      |

Both lanes settle through the **same** Split `0x4C4e` (95/5) → operator wallet.

### CHANGES (the outbound cost hop only)

- **Add per-request x402 → Hyperbolic** (x402 launch partner; OSS models DeepSeek-V3 / Llama-3.3-70B / Qwen3-235B / Kimi-K2).
- **Keep LiteLLM**, add an **x402-client shim** in front of it — LiteLLM cannot do `402 → sign → retry`; the shim catches the 402, has the Privy operator wallet sign an EIP-3009 authorization, and retries.
- **Add a per-request spend-vs-credit margin guard** — replaces the purchase-time margin lock; reuses the existing LiteLLM cost callback to compare per-request provider cost against the payer's remaining credit and the configured margin.

### RETIRES (dead code)

- `openrouter-funding.adapter` — top-up endpoint returns **410 Gone**.
- `fundOpenRouterTopUp`
- `providerFundingAttempts`
- `confirmCreditsPurchase` **steps 5 & 6** (the OpenRouter-funding tail of the purchase flow).

## Roadmap

Build sequence: **foundation → parity probe → shim + wiring → spend guard → e2e.**

### Foundation (P0) — operator wallet signs x402 + retire dead chain

**Goal:** give the Privy operator wallet a named x402-signing method and delete the dead OpenRouter funding leg. No behavior change visible to payers yet.

| #   | Deliverable                                                                                                                                       | Status      | Est | Work Item            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| 0   | `signX402Payment()` on the operator-wallet port — EIP-3009 via Privy `signTypedData` (close `NO_GENERIC_SIGNING` named-method gap)                | Not Started | 2   | (create at P0 start) |
| 1   | Retire dead chain — delete `openrouter-funding.adapter`, `fundOpenRouterTopUp`, `providerFundingAttempts`, and `confirmCreditsPurchase` steps 5/6 | Not Started | 1   | (create at P0 start) |
| 2   | Parity probe — connect LiteLLM to Hyperbolic, run inference, verify `x-litellm-response-cost`; record cost vs docs                                | Not Started | 1   | (create at P0 start) |

**Foundation rationale:** The signing capability is the only genuinely new primitive. Privy already signs EIP-712 typed data for the Polymarket CLOB; we just expose a named `signX402Payment` method instead of leaning on a generic-signing path. Retiring the dead OpenRouter chain first keeps the credits purchase flow honest (no 410-bound tail) before we add the new outbound hop.

### Walk (P1) — x402 shim + LiteLLM wiring

**Goal:** route outbound inference through x402 → Hyperbolic per request.

| #   | Deliverable                                                                                       | Status      | Est | Work Item            |
| --- | ------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| 3   | x402-client shim — catch 402 from Hyperbolic, call `signX402Payment()`, retry with payment header | Not Started | 2   | (create at P1 start) |
| 4   | LiteLLM wiring — Hyperbolic routes behind the shim; LiteLLM stays the cost oracle                 | Not Started | 1   | (create at P1 start) |
| 5   | `charge_receipts` x402 outbound columns — `x402_outbound_tx`, `provider_cost_usd`                 | Not Started | 1   | (create at P1 start) |
| 6   | Facilitator adapter — verify + settle outbound; self-host facilitator preferred (OSS-sovereign)   | Not Started | 1   | (create at P1 start) |

### Spend guard (P1) — per-request margin

**Goal:** never spend more on a request than the payer's credit + configured margin allows.

| #   | Deliverable                                                                                                            | Status      | Est | Work Item            |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| 7   | Per-request spend-vs-credit margin guard — uses the existing LiteLLM cost callback; replaces purchase-time margin lock | Not Started | 2   | (create at P1 start) |
| 8   | Embedding provider migration — Hyperbolic has no embeddings endpoint (see Embedding gap)                               | Not Started | 1   | (create at P1 start) |
| 9   | Grafana dashboard — x402 outbound spend, per-request margin, operator wallet balance                                   | Not Started | 1   | (create at P1 start) |

### Run (P2+) — sovereignty + native-x402 backends + e2e

**Goal:** prove e2e (credits in → x402 inference out), prefer native-x402 providers, harden.

| #   | Deliverable                                                                                                              | Status      | Est | Work Item            |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------- | --- | -------------------- |
| 10  | E2E proof — human buys credit budget → operator wallet pays Hyperbolic per request via x402 → credit debited             | Not Started | 2   | (create at P2 start) |
| 11  | Native-x402 provider tier — route to native-x402 providers where available (sovereign), Hyperbolic/ClawRouter for parity | Not Started | 2   | (create at P2 start) |
| 12  | Self-hosted x402 facilitator — remove dependency on a hosted facilitator                                                 | Not Started | 2   | (create at P2 start) |
| 13  | Circuit breaker — pause outbound if operator wallet balance below threshold                                              | Not Started | 1   | (create at P2 start) |

## Constraints

- Base mainnet (8453) for all x402 settlements.
- USDC only (no other stablecoins).
- **0xSplits (95/5) and the inbound credits ledger are NOT in scope to change** — touching them is out of bounds for this project.
- Open-source models only on the outbound x402 leg — no Claude, GPT, or Gemini (Hyperbolic / OSS-provider limitation).
- Humans cannot sign per-request — credits are the mandatory human pre-auth lane; do not require per-request signatures from human payers.
- LiteLLM remains the cost oracle — all pricing math flows through the existing cost callback.
- `charge_receipts` idempotency via `UNIQUE(source_system, source_reference)` is unchanged.
- Must not break the epoch ledger (activity_events, epoch_allocations, payout_statements).
- OSS-sovereign: prefer a self-hosted facilitator and native-x402 providers over hosted tolls.

## Dependencies

- [x] Hyperbolic API supports OpenAI-compatible format (native LiteLLM `hyperbolic/` prefix).
- [x] x402 `upto` scheme shipped (Thirdweb SDK).
- [x] Hyperbolic is an x402 launch partner (accepts x402 payments).
- [x] Privy operator wallet can sign EIP-712 typed data (`signTypedData`) — proven by the Polymarket CLOB integration.
- [ ] `signX402Payment()` named method added to the operator-wallet port (close `NO_GENERIC_SIGNING` gap).
- [ ] Human prerequisite: a **Hyperbolic account + API key** + an **x402 facilitator choice** (self-host preferred per OSS-sovereign ethos).
- [ ] Embedding provider decided (Hyperbolic has no embeddings endpoint).
- [ ] Per-request spend-vs-credit margin guard wired to the existing LiteLLM cost callback.

## As-Built Specs

- [x402-e2e.md](../../docs/spec/x402-e2e.md) — Payment architecture + schema changes (draft).
- [node-operator-x402.md](../../docs/spec/node-operator-x402.md) — Node vs Operator boundary with x402 (draft).

## Design Notes

### Why credits stay (the correction)

Humans cannot sign a per-request payment authorization for a multi-day schedule, and Cogni is API-first with **no card-on-file**. So the human payer buys a **credit budget once** (pre-authorization), and the operator wallet runs x402 micro-payments on their behalf, debiting the credit balance per request. Deleting credits would force per-request signing on humans, which is impossible for autonomous/scheduled workloads. The credits ledger + 0xSplits (95/5) inbound rail therefore stays ~unchanged.

### Why 0xSplits does NOT change

0xSplits splits **inbound** revenue: user USDC → Split `0x4C4e` (95/5) → operator wallet. That is orthogonal to outbound. The operator's 95% share is exactly the working capital that funds outbound x402 inference. There is no reason to touch the Split, the split-hash guard, or the allocation — and doing so is explicitly out of scope.

### Why the only real change is outbound

The OpenRouter funding leg is dead: programmatic crypto top-up returns **410 Gone**, and OpenRouter inference is prepaid-key only (**401**, not x402). There is nothing to negotiate against on OpenRouter outbound. So we retire that leg and pay **Hyperbolic per request via x402** instead — the operator wallet signs EIP-3009 authorizations, LiteLLM stays the cost oracle, and an x402-client shim bridges the `402 → sign → retry` gap that LiteLLM cannot do itself.

### Why Hyperbolic

1. **Crypto-native** — Hyperbolic is an x402 launch partner; outbound is signed USDC on Base, no fiat bridge and no prepaid key.
2. **OSS models** — DeepSeek-V3, Llama-3.3-70B, Qwen3-235B, Kimi-K2. No proprietary lock-in.
3. **Parity for a two-tier backend** — native-x402 providers are preferred where available (sovereign); Hyperbolic (and ClawRouter) provide breadth/parity.

**DISQUALIFIED:** `ekailabs/x402-openrouter` — it is still OpenRouter-prepaid behind a toll, so it inherits the same 410/401 dead end.

Tradeoff: no Claude / GPT / Gemini on the outbound x402 leg. If proprietary models are required, that is a SEPARATE project (a hybrid fiat-bridge), explicitly not in scope here.

### Two-tier backend

- **Native-x402 providers** — preferred where they exist; fully sovereign per-request payment.
- **Hyperbolic / ClawRouter** — breadth + parity until native-x402 coverage is broad enough.

### Embedding gap

Hyperbolic has no embedding endpoint. Options ranked by preference:

1. **Self-hosted** — BGE-large-en-v1.5 or similar, deployed alongside the node (OSS-sovereign).
2. **A native-x402 embedding provider** — if one exists.
3. **OpenAI direct** — `text-embedding-3-small` via `api.openai.com` (requires OpenAI API key, fiat billing) — last resort.

This is a bounded problem — embeddings are low-volume, low-cost, and don't need x402 per-request settlement.

### Build sequence

1. **Foundation** — `signX402Payment()` (Privy EIP-3009 via `signTypedData`) + retire the dead OpenRouter chain.
2. **Parity probe** — confirm Hyperbolic via LiteLLM + cost reporting.
3. **x402 shim + LiteLLM wiring** — catch 402, sign, retry; LiteLLM stays the oracle.
4. **Spend guard** — per-request spend-vs-credit margin via the existing cost callback.
5. **E2E** — human buys credit budget → operator wallet pays Hyperbolic per request via x402 → credit debited.

### Relationship to proj.ai-operator-wallet

This project **reuses** the Privy operator wallet from [proj.ai-operator-wallet.md](proj.ai-operator-wallet.md) rather than superseding it — the wallet is exactly the actor that signs outbound x402 payments. What is retired is only the OpenRouter Coinbase-Commerce top-up leg (410 Gone), not the wallet, the Splits contract, or the credits ledger.

### Migration path from current billing

| Current Component                          | Migration                                                            | When |
| ------------------------------------------ | -------------------------------------------------------------------- | ---- |
| OpenRouter model routes                    | Replace with Hyperbolic in litellm.config.yaml                       | P1   |
| `OPENROUTER_API_KEY`                       | Replace with `HYPERBOLIC_API_KEY`                                    | P1   |
| `openrouter-funding.adapter`               | **Delete** — top-up returns 410 Gone                                 | P0   |
| `fundOpenRouterTopUp`                      | **Delete**                                                           | P0   |
| `providerFundingAttempts`                  | **Delete**                                                           | P0   |
| `confirmCreditsPurchase` steps 5/6         | **Delete** (the OpenRouter-funding tail)                             | P0   |
| Inbound credits ledger                     | **Keep** — human pre-auth lane                                       | —    |
| 0xSplits (95/5) `0x4C4e`                   | **Keep unchanged** — splits inbound; operator 95% = outbound capital | —    |
| Split-hash guard (`SPLIT_CONFIG_MISMATCH`) | **Keep unchanged**                                                   | —    |
| Privy operator wallet                      | **Keep** + add `signX402Payment()` (EIP-3009)                        | P0   |
| Purchase-time margin lock                  | Replace with per-request spend-vs-credit margin guard                | P1   |
| LiteLLM proxy + cost callback              | **Keep** + front with x402-client shim                               | P1   |
| `charge_receipts`                          | **Keep** + add x402 outbound columns                                 | P1   |
| `pricing.ts`                               | **Keep** + per-request margin guard                                  | P1   |
| epoch ledger                               | **Keep unchanged**                                                   | —    |
