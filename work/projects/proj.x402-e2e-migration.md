---
id: proj.x402-e2e-migration
type: project
primary_charter:
title: "x402 E2E Migration: keep credits + Splits, change only outbound to x402 → Hyperbolic"
state: Active
priority: 1
estimate: 13
summary: "Keep inbound credits + 0xSplits (95/5) ~unchanged; credits stay the human pre-auth lane. Change ONLY the outbound cost hop: retire the dead OpenRouter Coinbase-Commerce top-up and pay Hyperbolic via a Tier-1 bulk x402 top-up (threshold-driven, signed once by the Privy operator wallet). LiteLLM talks to Hyperbolic with a normal API key — NO per-request x402."
outcome: "Inbound is two lanes — credits (human/pre-auth) OR x402 (agent/per-request) → Split 0x4C4e (95/5) → operator wallet — both unchanged. Outbound retires OpenRouter funding and bulk-tops-up the Hyperbolic USDC balance at a drawdown threshold via a single x402 payment (the fundOpenRouterTopUp pattern renamed fundHyperbolicTopUp, Coinbase-Commerce charge swapped for x402). LiteLLM points at hyperbolic/<model> with a normal OpenAI-compatible key (transport unchanged, like OpenRouter today); the credits ledger stays the per-request accounting layer. Payment frequency is decoupled from request frequency: payments << requests."
assignees: derekg1729
created: 2026-02-26
updated: 2026-06-25
labels: [billing, x402, web3, provider, migration]
---

# x402 E2E Migration: keep credits + Splits, change only outbound to x402 → Hyperbolic

> Spec: [x402-e2e.md](../../docs/spec/x402-e2e.md)
> Research: [gateway-billing-analysis.md](../../docs/research/gateway-billing-analysis.md)
> Bug: bug.5063 — pay UI is Stripe/card; OpenRouter crypto top-up returns 410 Gone; OpenRouter inference is prepaid-key only (401, not x402).
> Knowledge: `x402-usdc-egress` (operator hub) — outbound USDC egress design (now Tier-1 bulk top-up).

## Goal

Keep the inbound credit + 0xSplits rail essentially as-built; **change only the outbound cost hop** from the dead OpenRouter top-up to a **Tier-1 bulk x402 top-up of the Hyperbolic balance** — NOT per-request x402.

The original premise of this doc — "delete the credit system, pure x402 inbound per-request" — was **wrong for humans** and is corrected. A second correction (2026-06-25) fixes the **outbound** design: the earlier framing of a **per-request x402-client shim in front of LiteLLM** (catch 402 → sign → retry, on every inference) is a **Tier-3 anti-pattern** and is removed here.

Verified facts (2026-06-25):

- OpenRouter **removed programmatic crypto top-up** — Coinbase-Commerce funding returns **410 Gone** (bug.5063).
- OpenRouter inference is **prepaid-key only** — it answers **401**, not 402; there is no x402 negotiation to ride on outbound.
- The pay UI is **Stripe/card**. Cogni is **API-first with NO card-on-file ever** — so we cannot lean on a fiat top-up for either humans or the operator.
- **Hyperbolic supports crypto balance top-up (USDC/USDT/DAI) + auto-refuel-when-low** (app.hyperbolic.ai/billing) → a Tier-1 bulk top-up is viable. Hyperbolic _also_ ships per-request x402 (no key / prepaid) — that is the Tier-3 path we deliberately avoid.

### Core principle: payments << requests (decouple payment frequency from request frequency)

A 50-step ReAct graph makes 50 inference calls. If each call carries a Privy sign + an on-chain settlement (the per-request shim), the graph pays **50×** on its latency-critical path — a tax that scales with reasoning depth. The fix is to **decouple payment frequency from request frequency**: settle on-chain rarely (a low-frequency treasury hop), account per-request cheaply (the credits ledger, already aggregated at the GraphExecutor). x402 is **periodic treasury reconciliation, never a node inside a graph**.

| Tier                      | Outbound design                                                                                                                                                             | Per-LLM-call crypto cost                                       | Verdict                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Tier 1 (recommended)**  | LiteLLM → Hyperbolic via a normal OpenAI-compatible API key; operator wallet **bulk-tops-up** the Hyperbolic USDC balance at a drawdown threshold via a single x402 payment | **0** signs / **0** settlements (amortized: ~1 per N requests) | **CHOSEN** — matches the existing OpenRouter top-up pattern; transport unchanged |
| Tier 2 (deferred)         | Escrow + x402 `upto` / batch vouchers (open a budget, draw down voucher)                                                                                                    | ~0 (settle on voucher close)                                   | Defer — only when account-less inference is wanted                               |
| **Tier 3 (anti-pattern)** | Per-request x402-client shim in front of LiteLLM (402 → sign → retry per call)                                                                                              | **1 sign + 1 settlement EVERY call**                           | **REJECTED** — 50-step graph pays 50× on its critical path                       |

The correction: **inbound credits + 0xSplits (95/5) stay ~90% unchanged.** Humans buy a credit budget once; the credits ledger debits per request (the per-request accounting layer). Agents that _can_ sign per-request still pay inbound via x402 directly. On the **outbound** side, the only real change is retiring the dead OpenRouter funding leg and replacing it with a **Tier-1 threshold-driven bulk x402 top-up of the Hyperbolic balance** — LiteLLM itself keeps talking to Hyperbolic over a normal API key, exactly like it talks to OpenRouter today.

**The end state:** A node operator keeps the existing credits/Splits inbound rail, points LiteLLM at `hyperbolic/<model>` with a `HYPERBOLIC_API_KEY`, and the operator wallet bulk-tops-up the Hyperbolic USDC balance via x402 whenever the balance crosses a low-water threshold (trigger = the LiteLLM cost callback's running spend). The operator's 95% share of inbound revenue becomes the working capital for those bulk top-ups.

## What stays vs changes

This is the load-bearing correction. **Inbound is untouched; only the outbound hop changes.**

### STAYS (~unchanged — do NOT delete)

- **Inbound credits ledger** — humans pre-authorize by buying a credit budget; balance debited per request. Credits are the **human / pre-auth lane**.
- **0xSplits (95/5) does NOT change** — user USDC → Split `0x4C4e` (95/5) → operator wallet. It still splits **inbound** revenue. The operator's 95% becomes the working capital for outbound inference.
- **Split-hash guard** — `SPLIT_CONFIG_MISMATCH` repo-spec guard is untouched.
- **`charge_receipts`** — audit trail kept (add x402 outbound columns).
- **`pricing.ts`** — kept; purchase-time margin lock is replaced by a per-request spend-vs-credit guard.
- **LiteLLM (per-node service)** — stays as the cost oracle AND the transport. It talks to Hyperbolic over a normal OpenAI-compatible API key (`hyperbolic/<model>`), exactly as it talks to OpenRouter today — **no shim, no per-request x402**. All pricing math keeps flowing through the existing cost callback; the callback's running spend is what triggers the bulk top-up.
- **Credits ledger** — stays as the **per-request accounting layer** (already aggregated at the GraphExecutor). This is where per-request cost is recorded; x402 never enters a graph node.
- **Privy operator wallet** — kept and now used to **sign one bulk x402 top-up** of the Hyperbolic balance at a drawdown threshold (EIP-3009 via `signTypedData`, signed once per top-up, NOT per request). Capability already exists — same path as the Polymarket CLOB integration; the `signX402Payment` named method (PR #1844) closes the `NO_GENERIC_SIGNING` gap.
- **Epoch ledger** — untouched.

### Inbound = two lanes (both kept)

| Payer | Lane    | Mechanism                                               |
| ----- | ------- | ------------------------------------------------------- |
| Human | Credits | Buy a credit budget once → debit per request (pre-auth) |
| Agent | x402    | Per-request signed payment inbound                      |

Both lanes settle through the **same** Split `0x4C4e` (95/5) → operator wallet.

### CHANGES (the outbound cost hop only — Tier 1)

- **Point LiteLLM at Hyperbolic via a normal API key** (`hyperbolic/<model>`; OSS models DeepSeek-V3 / Llama-3.3-70B / Qwen3-235B / Kimi-K2). Transport is **unchanged** — same shape as the OpenRouter route today. **No shim. No per-request x402.**
- **Rename `fundOpenRouterTopUp` → `fundHyperbolicTopUp`** and **bulk-top-up the Hyperbolic USDC balance at a drawdown threshold** via a single x402 payment. The only mechanism change vs the old top-up is swapping the **dead Coinbase-Commerce charge for an x402 bulk USDC payment** (signed once via `signX402Payment`, PR #1844). Trigger = the LiteLLM cost callback crossing a low-water threshold — a low-frequency treasury hop, **not** per-purchase, **not** per-request.
- **Add a per-request spend-vs-credit margin guard** — replaces the purchase-time margin lock; reuses the existing LiteLLM cost callback to compare per-request provider cost against the payer's remaining credit and the configured margin. This is pure accounting in the credits ledger — no on-chain action per request.

> Removed (anti-pattern): the earlier "x402-client shim in front of LiteLLM, catch 402 → sign → retry per call" design. That is **Tier 3** — 1 sign + 1 settlement on every inference, which makes a 50-step graph pay 50× on its critical path. See the Tier table above.

### RETIRES (dead code)

- `openrouter-funding.adapter` — the **Coinbase-Commerce charge** leg is dead (410 Gone). The adapter's bulk-top-up shape is reused; the charge step is replaced by an x402 bulk USDC payment (becomes the Hyperbolic-funding adapter).
- `fundOpenRouterTopUp` — **renamed** `fundHyperbolicTopUp`, settlement swapped from Coinbase-Commerce to x402 (this is the Tier-1 bulk top-up, NOT a deletion).
- `confirmCreditsPurchase` **steps 5 & 6** — the **purchase-time** OpenRouter-funding tail is dropped from the purchase flow; bulk top-up is now threshold-driven (decoupled from purchase), not run on every credit purchase.
- `providerFundingAttempts` — kept as the durable crash-recovery row for the bulk top-up (now keyed by top-up event, not paymentIntentId).

## Roadmap

Build sequence: **foundation (DONE) → parity probe → fundHyperbolicTopUp (bulk x402) + LiteLLM Hyperbolic route → spend guard → e2e.**

### Foundation (P0) — operator wallet signs x402 + retire dead chain

**Goal:** give the Privy operator wallet a named x402-signing method and retire the dead OpenRouter Coinbase-Commerce charge leg. No behavior change visible to payers yet.

| #   | Deliverable                                                                                                                                                                         | Status      | Est | Work Item            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| 0   | `signX402Payment()` on the operator-wallet port — EIP-3009 via Privy `signTypedData` (close `NO_GENERIC_SIGNING` named-method gap)                                                  | **Done**    | 2   | PR #1844             |
| 1   | Retire dead chain — drop the Coinbase-Commerce charge leg + `confirmCreditsPurchase` steps 5/6 (rename `fundOpenRouterTopUp`→`fundHyperbolicTopUp`, keep `providerFundingAttempts`) | **Done**    | 1   | PR #1844             |
| 2   | Parity probe — point LiteLLM at `hyperbolic/<model>` with a normal API key, run inference, verify `x-litellm-response-cost`; record cost vs docs                                    | Not Started | 1   | (create at P1 start) |

**Foundation rationale:** The `signX402Payment` capability (PR #1844) is the only genuinely new primitive — Privy already signs EIP-712 typed data for the Polymarket CLOB; we expose a named method instead of a generic-signing path. Retiring the dead Coinbase-Commerce charge first keeps the credits purchase flow honest (no 410-bound tail) before the new bulk-top-up hop lands.

### Walk (P1) — bulk x402 top-up + LiteLLM Hyperbolic route

**Goal:** LiteLLM talks to Hyperbolic over a normal API key; the operator wallet bulk-tops-up the Hyperbolic USDC balance via x402 at a drawdown threshold. **No per-request x402.**

| #   | Deliverable                                                                                                                                           | Status      | Est | Work Item            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| 2.5 | **Prereq (human/probe):** confirm Hyperbolic's **programmatic bulk top-up API** vs dashboard/auto-refuel trigger — the one remaining unknown          | Not Started | 1   | (create at P1 start) |
| 3   | `fundHyperbolicTopUp` — bulk x402 USDC payment of the Hyperbolic balance, **threshold-driven** (low-water trigger), signed once via `signX402Payment` | Not Started | 2   | (create at P1 start) |
| 4   | LiteLLM Hyperbolic API-key route — `hyperbolic/<model>` behind `HYPERBOLIC_API_KEY`; LiteLLM stays the cost oracle (transport unchanged)              | Not Started | 1   | (create at P1 start) |
| 5   | `charge_receipts` x402 outbound columns — `x402_outbound_tx`, `provider_cost_usd` (records the bulk top-up, not per-request)                          | Not Started | 1   | (create at P1 start) |
| 6   | Top-up trigger — wire the LiteLLM cost-callback running spend to fire `fundHyperbolicTopUp` when the Hyperbolic balance crosses the low-water mark    | Not Started | 1   | (create at P1 start) |

### Spend guard (P1) — per-request margin

**Goal:** never spend more on a request than the payer's credit + configured margin allows.

| #   | Deliverable                                                                                                            | Status      | Est | Work Item            |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| 7   | Per-request spend-vs-credit margin guard — uses the existing LiteLLM cost callback; replaces purchase-time margin lock | Not Started | 2   | (create at P1 start) |
| 8   | Embedding provider migration — Hyperbolic has no embeddings endpoint (see Embedding gap)                               | Not Started | 1   | (create at P1 start) |
| 9   | Grafana dashboard — x402 outbound spend, per-request margin, operator wallet balance                                   | Not Started | 1   | (create at P1 start) |

### Run (P2+) — sovereignty + native-x402 backends + e2e

**Goal:** prove e2e (credits in → x402 inference out), prefer native-x402 providers, harden.

| #   | Deliverable                                                                                                                                                                   | Status      | Est | Work Item            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| 10  | E2E proof on real USDC — human buys credit budget → LiteLLM runs Hyperbolic inference on a normal key → credits debited per request → bulk x402 top-up fires at the threshold | Not Started | 2   | (create at P2 start) |
| 11  | Tier 2 (escrow + x402 `upto`/batch vouchers) — **deferred**; only when account-less inference is wanted                                                                       | Not Started | 2   | (create at P2 start) |
| 12  | Self-hosted x402 facilitator for the bulk top-up — remove dependency on a hosted facilitator                                                                                  | Not Started | 2   | (create at P2 start) |
| 13  | Circuit breaker — pause outbound if operator wallet balance below threshold                                                                                                   | Not Started | 1   | (create at P2 start) |

## Constraints

- Base mainnet (8453) for all x402 settlements (the bulk top-up).
- USDC only (no other stablecoins).
- **payments << requests** — payment frequency MUST be decoupled from request frequency. No per-request on-chain settlement, no per-request signing, no x402 inside a graph node. x402 is the periodic treasury hop only.
- **0xSplits (95/5) and the inbound credits ledger are NOT in scope to change** — touching them is out of bounds for this project.
- Open-source models only on the outbound leg — no Claude, GPT, or Gemini (Hyperbolic / OSS-provider limitation).
- Humans cannot sign per-request — credits are the mandatory human pre-auth lane; do not require per-request signatures from human payers.
- LiteLLM remains the cost oracle AND the transport — all pricing math flows through the existing cost callback; it talks to Hyperbolic over a normal API key (no shim).
- `charge_receipts` idempotency via `UNIQUE(source_system, source_reference)` is unchanged.
- Must not break the epoch ledger (activity_events, epoch_allocations, payout_statements).
- OSS-sovereign: prefer a self-hosted facilitator and native-x402 providers over hosted tolls.

## Dependencies

- [x] Hyperbolic API supports OpenAI-compatible format (native LiteLLM `hyperbolic/` prefix) — the Tier-1 transport.
- [x] Hyperbolic supports **crypto balance top-up (USDC/USDT/DAI) + auto-refuel-when-low** (app.hyperbolic.ai/billing) — verified 2026-06-25; makes Tier-1 viable.
- [x] Hyperbolic is an x402 launch partner (also ships per-request x402 — the Tier-3 path we avoid).
- [x] Privy operator wallet can sign EIP-712 typed data (`signTypedData`) — proven by the Polymarket CLOB integration.
- [x] `signX402Payment()` named method added to the operator-wallet port (close `NO_GENERIC_SIGNING` gap) — **PR #1844**.
- [ ] **Remaining unknown:** the exact **programmatic bulk top-up API** vs dashboard/auto-refuel trigger (human-provisioning prereq).
- [ ] Human prerequisite: a **Hyperbolic account + API key** + an **x402 facilitator choice** (self-host preferred per OSS-sovereign ethos).
- [ ] Embedding provider decided (Hyperbolic has no embeddings endpoint).
- [ ] Per-request spend-vs-credit margin guard wired to the existing LiteLLM cost callback.

## As-Built Specs

- [x402-e2e.md](../../docs/spec/x402-e2e.md) — Payment architecture + schema changes (draft).
- [node-operator-x402.md](../../docs/spec/node-operator-x402.md) — Node vs Operator boundary with x402 (draft).

## Design Notes

### Why credits stay (the correction)

Humans cannot sign a per-request payment authorization for a multi-day schedule, and Cogni is API-first with **no card-on-file**. So the human payer buys a **credit budget once** (pre-authorization), and the credits ledger debits the balance per request as the per-request accounting layer. The operator wallet's on-chain action is the **periodic bulk top-up** of the provider balance — never a per-request payment. Deleting credits would force per-request signing on humans, which is impossible for autonomous/scheduled workloads. The credits ledger + 0xSplits (95/5) inbound rail therefore stays ~unchanged.

### Why 0xSplits does NOT change

0xSplits splits **inbound** revenue: user USDC → Split `0x4C4e` (95/5) → operator wallet. That is orthogonal to outbound. The operator's 95% share is exactly the working capital that funds the periodic bulk top-up of the Hyperbolic balance. There is no reason to touch the Split, the split-hash guard, or the allocation — and doing so is explicitly out of scope.

### Why the only real change is outbound (Tier-1 bulk top-up, NOT a per-request shim)

The OpenRouter funding leg is dead: programmatic crypto top-up returns **410 Gone**, and OpenRouter inference is prepaid-key only (**401**, not x402). So we retire that leg and pay **Hyperbolic via a Tier-1 bulk x402 top-up**: LiteLLM keeps talking to Hyperbolic over a normal OpenAI-compatible API key (transport unchanged, exactly like OpenRouter today), and the operator wallet signs **one** x402 USDC payment to refill the Hyperbolic balance when it crosses a low-water threshold. The credits ledger remains the per-request accounting layer; the LiteLLM cost callback's running spend is the top-up trigger.

The earlier framing — **an x402-client shim in front of LiteLLM that catches a 402, signs, and retries on every call** — is rejected as **Tier 3**. It puts 1 Privy sign + 1 on-chain settlement on the critical path of _every_ inference, so a 50-step ReAct graph pays 50× and adds settlement latency to every reasoning step. The principle is **payments << requests**: settle rarely (bulk top-up), account often (credits ledger).

### Why Hyperbolic

1. **Crypto top-up viable** — Hyperbolic supports USDC/USDT/DAI balance top-up + auto-refuel-when-low (verified 2026-06-25), so a bulk x402 top-up replaces fiat. It is an x402 launch partner too (we use that for the _bulk_ payment, not per-request).
2. **OSS-compatible OpenAI API** — LiteLLM `hyperbolic/` route, normal API key, no shim.
3. **OSS models** — DeepSeek-V3, Llama-3.3-70B, Qwen3-235B, Kimi-K2. No proprietary lock-in.

**DISQUALIFIED:** `ekailabs/x402-openrouter` — it is still OpenRouter-prepaid behind a toll, so it inherits the same 410/401 dead end.

Tradeoff: no Claude / GPT / Gemini on the OSS outbound leg. If proprietary models are required, that is a SEPARATE project (a hybrid fiat-bridge), explicitly not in scope here.

### Tiers (deferred work)

- **Tier 1 (chosen)** — normal API key + threshold-driven bulk x402 top-up. Payments << requests.
- **Tier 2 (deferred)** — escrow + x402 `upto` / batch vouchers; open a budget, draw down a voucher, settle on close. Pursue only when **account-less** inference is wanted.
- **Tier 3 (rejected)** — per-request x402 shim. Anti-pattern; documented here so it is not re-proposed.

### Embedding gap

Hyperbolic has no embedding endpoint. Options ranked by preference:

1. **Self-hosted** — BGE-large-en-v1.5 or similar, deployed alongside the node (OSS-sovereign).
2. **A native-x402 embedding provider** — if one exists.
3. **OpenAI direct** — `text-embedding-3-small` via `api.openai.com` (requires OpenAI API key, fiat billing) — last resort.

This is a bounded problem — embeddings are low-volume, low-cost, and don't need x402 per-request settlement.

### Build sequence

1. **Foundation (DONE — PR #1844)** — `signX402Payment()` (Privy EIP-3009 via `signTypedData`) + retire the dead Coinbase-Commerce charge leg.
2. **Confirm Hyperbolic programmatic bulk top-up API** — vs the dashboard/auto-refuel trigger (the one remaining unknown); + parity probe of `hyperbolic/<model>` via LiteLLM cost reporting.
3. **`fundHyperbolicTopUp` (bulk x402, threshold-driven) + LiteLLM Hyperbolic API-key route** — operator wallet refills the Hyperbolic balance with one x402 payment at the low-water mark; LiteLLM talks to Hyperbolic over a normal key (no shim).
4. **Spend guard** — per-request spend-vs-credit margin via the existing LiteLLM cost callback (pure ledger accounting).
5. **E2E on real USDC** — human buys credit budget → LiteLLM runs Hyperbolic inference on a normal key → credits debited per request → bulk x402 top-up fires at the threshold.

### Relationship to proj.ai-operator-wallet

This project **reuses** the Privy operator wallet from [proj.ai-operator-wallet.md](proj.ai-operator-wallet.md) rather than superseding it — the wallet is exactly the actor that signs the periodic bulk x402 top-up. What is retired is only the OpenRouter Coinbase-Commerce top-up leg (410 Gone), not the wallet, the Splits contract, or the credits ledger.

### Migration path from current billing

| Current Component                          | Migration                                                                                                               | When  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----- |
| OpenRouter model routes                    | Replace with Hyperbolic in litellm.config.yaml                                                                          | P1    |
| `OPENROUTER_API_KEY`                       | Replace with `HYPERBOLIC_API_KEY`                                                                                       | P1    |
| `openrouter-funding.adapter`               | **Reshape** — drop the 410-Gone Coinbase-Commerce charge; reuse the bulk-top-up shape as the Hyperbolic-funding adapter | P0/P1 |
| `fundOpenRouterTopUp`                      | **Rename** → `fundHyperbolicTopUp` (bulk x402, swap settlement)                                                         | P0    |
| `providerFundingAttempts`                  | **Keep** — durable crash-recovery row for the bulk top-up                                                               | —     |
| `confirmCreditsPurchase` steps 5/6         | **Delete** (purchase-time funding tail; top-up is now threshold-driven, not per-purchase)                               | P0    |
| Inbound credits ledger                     | **Keep** — human pre-auth lane + per-request accounting layer                                                           | —     |
| 0xSplits (95/5) `0x4C4e`                   | **Keep unchanged** — splits inbound; operator 95% = top-up capital                                                      | —     |
| Split-hash guard (`SPLIT_CONFIG_MISMATCH`) | **Keep unchanged**                                                                                                      | —     |
| Privy operator wallet                      | **Keep** + `signX402Payment()` (EIP-3009) — DONE (PR #1844)                                                             | P0    |
| Purchase-time margin lock                  | Replace with per-request spend-vs-credit margin guard (ledger accounting)                                               | P1    |
| LiteLLM proxy + cost callback              | **Keep** — talks to Hyperbolic over a normal API key (no shim); cost callback triggers the bulk top-up                  | P1    |
| `charge_receipts`                          | **Keep** + add x402 outbound columns (records the bulk top-up)                                                          | P1    |
| `pricing.ts`                               | **Keep** + per-request margin guard                                                                                     | P1    |
| epoch ledger                               | **Keep unchanged**                                                                                                      | —     |
