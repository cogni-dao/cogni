---
id: proj.x402-e2e-migration
type: project
primary_charter:
title: "x402 E2E Migration: Hyperbolic + Per-Request Settlement"
state: Active
priority: 1
estimate: 13
summary: "Replace OpenRouter credit system with x402 inbound per-request settlement + Hyperbolic API key outbound. No credit_ledger, no Privy, no Splits, no private keys."
outcome: "Cogni node accepts x402 USDC payments per-request (inbound), routes to Hyperbolic via API key (outbound). LiteLLM (per-node service) is the cost oracle. 3 env vars to deploy, no private keys."
assignees: derekg1729
created: 2026-02-26
updated: 2026-03-02
labels: [billing, x402, web3, provider, migration]
---

# x402 E2E Migration: Hyperbolic + Per-Request Settlement

> **REALIGNED 2026-09-30.** The "no credit_ledger, no Privy, no Splits" framing in this project's
> summary/outcome is **superseded**. Corrected boundary: **credits stay** as the node-local human
> on-ramp; **USDC via x402 is the node↔node rail**; custody is the non-custodial Privy owner quorum
> from [node-payments-empowerment](../../docs/design/node-payments-empowerment.md); Splits remain the
> inbound revenue rail. Authority:
> [node-operator-x402.md](../../docs/spec/node-operator-x402.md) +
> [`node-service-usdc-northstar`](https://cognidao.org/knowledge/node-service-usdc-northstar).
> The load-bearing unbuilt piece is the **buy side** (outbound signer + spend cap + price list +
> `treasurer`/`spender` grant) — tracked in `story.5056`.

> Spec: [x402-e2e.md](../../docs/spec/x402-e2e.md)
> Research: [gateway-billing-analysis.md](../../docs/research/gateway-billing-analysis.md)
> Supersedes: [proj.ai-operator-wallet.md](proj.ai-operator-wallet.md) (Privy + Splits + Coinbase Commerce approach)

## Goal

Replace the credit-purchase-then-consume billing model with x402 inbound per-request settlement + Hyperbolic API key outbound. Users/agents pay Cogni nodes per-request via x402 `upto` scheme (USDC on Base). Nodes route to Hyperbolic via standard API key auth. LiteLLM (a per-node Docker service) remains the cost oracle. charge_receipts remain the audit trail. Everything else (credit_ledger, payment_attempts, Privy, Splits, Coinbase Commerce, OpenRouter) is deleted.

**The end state:** A new AI project becomes a Cogni node by forking the template, setting 3 env vars (HYPERBOLIC_API_KEY, NODE_RECEIVING_ADDRESS, X402_FACILITATOR_URL), and running `docker compose up`. No Privy account, no Splits contract, no Coinbase Commerce, no OpenRouter account, **no private keys**.

## Roadmap

### Crawl (P0) — Hyperbolic Migration + Inbound x402

**Goal:** Replace OpenRouter with Hyperbolic (API key auth). Add x402 inbound middleware so users/agents pay per-request. No private keys, no signing.

| #   | Deliverable                                                                                                    | Status      | Est | Work Item  |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------- | --- | ---------- |
| 0   | Spike: Hyperbolic API validation — connect LiteLLM, run inference, verify cost reporting                       | Not Started | 1   | spike.0100 |
| 1   | Spike: x402 inbound verification — verify Thirdweb facilitator API works for payment verification + settlement | Not Started | 1   | spike.0101 |
| 2   | LiteLLM config rewrite — replace all OpenRouter routes with Hyperbolic equivalents (API key auth)              | Not Started | 1   | task.0100  |
| 3   | x402 inbound middleware — respond 402 with `upto`, verify via facilitator, settle after completion             | Not Started | 2   | task.0101  |
| 4   | x402 facilitator adapter — call hosted facilitator for verify + settle (no node signing)                       | Not Started | 1   | task.0102  |
| 5   | Embedding provider migration — replace OpenRouter text-embedding-3-small with alternative                      | Not Started | 1   | task.0103  |

**Spike 0 — Hyperbolic API validation:**

Validate before building abstractions:

1. Configure LiteLLM with `hyperbolic/deepseek-ai/DeepSeek-V3` and `HYPERBOLIC_API_KEY`
2. Send a test completion request through LiteLLM proxy
3. Verify `x-litellm-response-cost` header populates correctly
4. Verify streaming works (`stream: true`)
5. Test 3-4 models: DeepSeek-V3, Llama-3.3-70B, Qwen3-235B, Kimi-K2
6. Record actual costs vs. documented pricing

**Spike 1 — x402 inbound verification:**

1. Set up a test endpoint that responds 402 with `upto` scheme payment requirements
2. Use Thirdweb x402 SDK `verifyPayment()` to verify a test authorization
3. Call `settlePayment()` — verify USDC arrives at a test receiving address
4. **Key question:** What does the facilitator API look like? What SDK calls?
5. Record latency of verify + settle round-trip
6. No node signing needed — facilitator handles on-chain settlement

**Why spikes first:** We need to verify the Thirdweb facilitator API behavior and Hyperbolic's LiteLLM cost reporting before building the middleware.

### Walk (P1) — Credit System Removal + Hardening

**Goal:** Delete the credit system. Harden x402 inbound. Production observability.

| #   | Deliverable                                                                              | Status      | Est | Work Item            |
| --- | ---------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| 6   | billing_accounts wallet migration — add wallet_address, remove balance tracking          | Not Started | 1   | (create at P1 start) |
| 7   | Delete credit system — credit_ledger, payment_attempts, payment_events tables + services | Not Started | 1   | (create at P1 start) |
| 8   | charge_receipts x402 columns — add x402_settlement_tx, provider_cost_usd                 | Not Started | 1   | (create at P1 start) |
| 9   | calculateMaxPayable() in pricing.ts                                                      | Not Started | 1   | (create at P1 start) |
| 10  | Delete Privy integration + Splits + Coinbase Commerce code                               | Not Started | 1   | (create at P1 start) |
| 11  | "Sign once, settle many" for multi-turn chat sessions                                    | Not Started | 2   | (create at P1 start) |
| 12  | Grafana dashboard — x402 settlements, margins, receiving wallet balance                  | Not Started | 1   | (create at P1 start) |

### Run (P2+) — x402 Outbound + Sovereignty + Federation

**Goal:** x402 outbound to Hyperbolic (eliminates API key), self-hosted facilitator, cross-node routing.

| #   | Deliverable                                                                                  | Status      | Est | Work Item            |
| --- | -------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| 13  | x402 outbound client + NodeWalletPort abstraction (keystore/Vault/CDP — NOT raw private key) | Not Started | 3   | (create at P2 start) |
| 14  | Self-hosted x402 facilitator (remove Coinbase verification dependency)                       | Not Started | 2   | (create at P2 start) |
| 15  | Circuit breaker — pause serving if Hyperbolic balance below threshold                        | Not Started | 1   | (create at P2 start) |
| 16  | L402 (Lightning) as alternative inbound payment rail                                         | Not Started | 3   | (create at P2 start) |

## Constraints

- Base mainnet (8453) for all x402 settlements
- USDC only (no other stablecoins in P0/P1)
- Open-source models only — no Claude, GPT, or Gemini (Hyperbolic limitation)
- Hyperbolic x402 endpoint (`hyperbolic-x402.vercel.app`) is Vercel-deployed — monitor uptime
- Hyperbolic rate limits: 60 RPM (Basic), 600 RPM (Pro). May need Enterprise for production.
- LiteLLM remains the cost oracle — all pricing math flows through `calculateLlmUserCharge()`
- charge_receipts idempotency via `UNIQUE(source_system, source_reference)` is unchanged
- Must not break epoch ledger (activity_events, epoch_allocations, payout_statements)

## Dependencies

- [x] Hyperbolic API supports OpenAI-compatible format (verified: native LiteLLM `hyperbolic/` prefix)
- [x] x402 `upto` scheme shipped (Thirdweb SDK v5.114.0+)
- [x] Hyperbolic accepts x402 payments (separate Vercel endpoint)
- [ ] Hyperbolic Enterprise tier (for 600+ RPM production workloads)
- [ ] Embedding provider decided (Hyperbolic has no embeddings endpoint)
- [ ] Node wallet provisioning (key management approach: env var vs. keystore vs. CDP wallet)
- [ ] Thirdweb x402 SDK integration tested with LiteLLM callback flow

## As-Built Specs

- [x402-e2e.md](../../docs/spec/x402-e2e.md) — Payment architecture + schema changes (draft)
- [node-operator-x402.md](../../docs/spec/node-operator-x402.md) — Node vs Operator boundary with x402 (draft)

## Design Notes

### Why Hyperbolic over keeping OpenRouter?

1. **Crypto-native** — Hyperbolic is an x402 launch partner. Accepts crypto. No fiat bridge needed long-term.
2. **No operator wallet** — P0 uses standard API key, but no Privy/Splits/Coinbase Commerce stack.
3. **No private keys in P0** — Node is x402 inbound (receive-only). Outbound is API key. Zero signing.
4. **Node deployment is trivial** — Fork template, set 3 env vars, deploy. No accounts to create beyond Hyperbolic.
5. **P2 path to full x402** — When x402 outbound is built, both legs are x402 USDC on Base.

Tradeoff: No Claude, GPT, or Gemini. If proprietary models are required, a hybrid spec is needed (x402 for Hyperbolic open-source + credit bridge for OpenRouter proprietary). That is a SEPARATE project.

### P0 is NOT full x402 E2E — and that's correct

P0 is: x402 inbound (users pay node) + API key outbound (node pays Hyperbolic). This is intentional:

- **No private keys in P0** — The node never signs transactions. The facilitator handles inbound settlement.
- **API key auth is proven** — LiteLLM's `hyperbolic/` prefix works today. No 402 negotiation on outbound.
- **P2 adds x402 outbound** — Node signs payments to Hyperbolic via `NodeWalletPort`. Eliminates API key.

The previous version of this spec had `NODE_WALLET_PRIVATE_KEY` as a P0 env var — that was scope creep. A raw private key in an env var violates NO_PRIVATE_KEY_ENV_VARS (per operator-wallet.md precedent) and isn't needed when outbound is API key auth.

### Embedding gap

Hyperbolic has no embedding endpoint. Options ranked by preference:

1. **OpenAI direct** — `text-embedding-3-small` via `api.openai.com` (requires OpenAI API key, fiat billing)
2. **Self-hosted** — BGE-large-en-v1.5 or similar, deployed alongside the node
3. **Cohere** — Embed v3, has some crypto payment options
4. **Keep one OpenRouter route** — Just for embeddings (minimal dependency)

This is a bounded problem — embeddings are low-volume, low-cost, and don't need x402 per-request settlement.

### Supersedes proj.ai-operator-wallet

The operator wallet project (Privy + Splits + Coinbase Commerce → OpenRouter top-ups) is superseded by this approach. The entire rationale for an operator wallet was "someone must pre-fund the OpenRouter balance." With Hyperbolic x402, there is no pre-funded balance — each request pays independently. The operator wallet, Splits contract, and Coinbase Commerce integration are all unnecessary.

### Migration path from current billing

| Current Component                          | Migration                                                                    | When |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ---- |
| OpenRouter model routes                    | Replace with Hyperbolic in litellm.config.yaml                               | P0   |
| OPENROUTER_API_KEY                         | Replace with HYPERBOLIC_API_KEY                                              | P0   |
| Credit purchase flow (USDC → mint credits) | Delete — x402 pays per-request                                               | P1   |
| credit_ledger table                        | Delete                                                                       | P1   |
| payment_attempts/events tables             | Delete                                                                       | P1   |
| creditsConfirm/creditsSummary services     | Delete                                                                       | P1   |
| paymentService state machine               | Replace with x402 middleware                                                 | P1   |
| billing_accounts.balance                   | Remove column                                                                | P1   |
| Privy integration                          | Delete                                                                       | P1   |
| Splits contract                            | Delete                                                                       | P1   |
| evm-rpc-onchain-verifier adapter           | Replace with x402 facilitator adapter (calls hosted facilitator, no signing) | P1   |
| charge_receipts                            | Keep + add x402 columns                                                      | P1   |
| pricing.ts                                 | Keep + add calculateMaxPayable()                                             | P1   |
| LiteLLM proxy + callbacks                  | Keep unchanged                                                               | —    |
| epoch ledger                               | Keep unchanged                                                               | —    |
