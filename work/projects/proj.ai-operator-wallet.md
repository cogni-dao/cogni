---
id: proj.ai-operator-wallet
type: project
primary_charter:
title: AI Operator Wallet
state: Dropped
priority: 1
estimate: 3
summary: App-controlled operator wallet (Privy-managed) receives user USDC payments via a Splits contract that trustlessly routes DAO share to treasury, then tops up OpenRouter credits autonomously. No custom smart contracts, no raw signing in app.
outcome: Users pay USDC to Split contract → on-chain split routes DAO share to treasury + operator share to wallet → app tops up OpenRouter → credits backed by real LLM spend. Zero manual transfers.
assignees: derekg1729
created: 2026-02-11
updated: 2026-03-09
labels: [wallet, billing, web3]
---

> **SUPERSEDED 2026-09-30.** `proj.x402-e2e-migration` already declared this superseded, yet it
> stayed `state: Active` — two Active projects for one money loop is how the doc plane drifted.
> Custody now lives in [node-payments-empowerment](../../docs/design/node-payments-empowerment.md)
> (non-custodial Privy owner quorum); the boundary lives in
> [node-operator-x402.md](../../docs/spec/node-operator-x402.md). Retained for history only.

# AI Operator Wallet

> Research: [ai-operator-wallet-budgeted-spending](../../docs/research/ai-operator-wallet-budgeted-spending.md)

## Goal

Close the financial loop so every credit purchase automatically provisions OpenRouter — no manual transfers, no DAO votes per purchase. Users pay USDC to a [Splits](https://splits.org/) contract that trustlessly routes the DAO's share to treasury and the operator's share to a Privy-managed server wallet. After credits mint, the app tops up OpenRouter with the provider cost from the operator wallet.

## Roadmap

### Crawl (P0) — Operator Wallet + Outbound Payments

**Goal:** Validate payment chain experimentally, then: operator wallet via Privy, Splits contract for trustless revenue split, OpenRouter top-up wired.

Spike + 3 atomic PRs, each shippable:

| #   | Deliverable                                   | Status      | Est | Work Item  |
| --- | --------------------------------------------- | ----------- | --- | ---------- |
| 0   | Experimental spike: validate payment chain    | Done        | 1   | spike.0090 |
| 1   | Operator wallet provisioning + wiring         | Done        | 2   | task.0084  |
| 2   | Splits contract deployment + payment re-route | Done        | 1   | task.0085  |
| 3a  | OpenRouter top-up adapter (signing gates)     | Done        | 2   | task.0086  |
| 3b  | OpenRouter top-up wiring (orchestration)      | In Review   | 2   | task.0086  |
| 4   | Live money e2e test (full chain on Base)      | Not Started | 2   | task.0165  |

**Spike 0 — Validate payment chain (DONE — spike.0090):**

All three sub-experiments validated on Base mainnet. Key findings:

1. **OpenRouter crypto top-up** — API does NOT return `function_name`. Correct function: `transferTokenPreApproved` (USDC via direct ERC-20 `transferFrom`, NOT Permit2). No ETH swap needed. Minimum charge: $1 (not $5). 5% fee applies.
2. **0xSplits deployment** — Push Split V2o2 via `splitV2ABI` (not `pushSplitAbi`). `distribute()` sends USDC directly via ERC-20 transfers to recipients (no warehouse withdrawal). Deploy: ~166k gas, distribute: ~81k gas. Factory: `0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4`.
3. **End-to-end chain** — Full chain proven in 23.6s, 247k total gas (~$0.001). USDC → Split → distribute (92.1% to operator) → ERC-20 approve to Transfers contract → `transferTokenPreApproved` → OpenRouter credits +$1.00.

**Resolved unknowns:**

- ~~Does OpenRouter return `Native` or `Token`/`TokenPreApproved`?~~ → API doesn't return function_name. Use `transferTokenPreApproved` (USDC input, direct ERC-20 approval to Transfers contract).
- ~~What is `metadata.contract_address`?~~ → `0x03059433BCdB6144624cC2443159D9445C32b7a8` (NOT old `0xeADE6...`).
- ~~Does Splits work with Base USDC?~~ → Yes. ~81k gas per distribute, ~0.000002 USDC dust remains.
- ~~Can the full chain complete in < 2 minutes?~~ → 23.6 seconds end-to-end.

**PR 1 — Operator wallet provisioning + wiring:**

- `scripts/provision-operator-wallet.ts` — create wallet via Privy API, output address
- Add `operator_wallet.address` to `.cogni/repo-spec.yaml`
- `OperatorWalletPort` interface in `src/ports/operator-wallet.port.ts`
- Privy adapter: verify Privy-reported address matches repo-spec at startup
- Wire into `src/bootstrap/container.ts`

**PR 2 — Splits contract deployment + payment re-route:**

- Deploy a mutable Split contract on Base via Splits SDK (`@0xsplits/splits-sdk`)
- Recipients: ~92.1% → operator wallet, ~7.9% → DAO treasury (derived from pricing constants)
- Controller: Privy operator wallet (can update percentages if pricing constants change)
- Add `operator_wallet.split_address` to `.cogni/repo-spec.yaml`
- Update `payments_in.credits_topup.receiving_address` → Split contract address
- After credit mint, app calls `distribute()` on the Split contract to trigger USDC distribution
- Existing payment flow works unchanged — users now send USDC to Split instead of DAO wallet
- DAO treasury receives its share trustlessly on-chain — no app-level sweep needed
- No `outbound_transfers` table, no `sweepUsdcToTreasury()`, no `calculateDaoShare()`

**PR 3 — OpenRouter top-up integration:**

- `OperatorWalletPort.fundOpenRouterTopUp(intent)` — typed intent for Coinbase Commerce protocol
- `calculateOpenRouterTopUp()` in `src/core/billing/pricing.ts`
- OpenRouter charge creation → Coinbase Commerce transfer function → submit via Privy
- Function: `transferTokenPreApproved` (USDC input, direct ERC-20 approval — NOT Permit2). Resolved by spike.0090.
- Coinbase Transfers contract: `0x03059433BCdB6144624cC2443159D9445C32b7a8` on Base (validated by spike.0090; old `0xeADE6...` is stale)
- `outbound_topups` table + state machine (CHARGE_PENDING → CHARGE_CREATED → TX_BROADCAST → CONFIRMED)
- Charge receipt logging with `openrouter_topup` reason
- New env vars: `OPENROUTER_CRYPTO_FEE`, `OPERATOR_MAX_TOPUP_USD`
- Margin safety check at startup: `MARKUP × (1 - FEE) > 1 + REVENUE_SHARE`

### Walk (P1) — Monitoring + Hardening

**Goal:** Observability, automated balance checks, optional OSS custody adapter.

| Deliverable                                                                                                                                                                                                                                                | Status      | Est | Work Item            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Funding reconciler: sweep `payment_attempts` with status=CREDITED that have no matching `provider_funding_attempts` row, and re-trigger `runPostCreditFunding`. Covers crash window between CREDITED write and funding row insertion. Cron or startup job. | Not Started | 2   | (create at P1 start) |
| Auto-sync Split allocations: detect when billing constants change (markup, revenue share, provider fee) and call `updateSplit()` on the mutable Split contract to match. No redeploy needed — controller (operator wallet) updates in-place.               | Not Started | 1   | (create at P1 start) |
| Grafana alerts: operator balance, top-up failures, margin                                                                                                                                                                                                  | Not Started | 2   | (create at P1 start) |
| OpenRouter balance probe (GET /api/v1/credits polling)                                                                                                                                                                                                     | Not Started | 1   | (create at P1 start) |
| Keystore/Vault adapter (OSS fallback for Privy)                                                                                                                                                                                                            | Not Started | 3   | (create at P1 start) |
| Circuit breaker: pause purchases on persistent failures                                                                                                                                                                                                    | Not Started | 2   | (create at P1 start) |
| UI admin panel: trigger manual top-up, view status                                                                                                                                                                                                         | Not Started | 2   | (create at P1 start) |

### Run (P2+) — Autonomous Spending

**Goal:** AI monitors its own balance and tops up within DAO-approved limits.

| Deliverable                                                 | Status      | Est | Work Item            |
| ----------------------------------------------------------- | ----------- | --- | -------------------- |
| Auto top-up: agent monitors credit balance, triggers top-up | Not Started | 2   | (create at P2 start) |
| On-chain spending limits (Zodiac Roles or session keys)     | Not Started | 3   | (create at P2 start) |
| x402 integration for AI-to-service micropayments            | Not Started | 2   | (create at P2 start) |

## Constraints

- Base mainnet (8453) only for P0
- No custom smart contracts — Splits contracts are pre-deployed, audited infrastructure (not ours to maintain)
- No DAO votes per purchase — app handles routing autonomously
- No raw key material in the application — Privy holds signing keys
- Credits mint after on-chain USDC transfer confirmation (existing flow unchanged)
- Operator wallet address is governance-in-git (repo-spec)
- Programmatic setup — secrets injected into deploy secret store, no copy/paste

## Dependencies

- [x] OpenRouter Crypto Payments API supports Base (chain_id 8453)
- [x] `cogni_system` billing account exists (task.0046, merged)
- [x] Revenue share constants exist (`SYSTEM_TENANT_REVENUE_SHARE`, `USER_PRICE_MARKUP_FACTOR`)
- [x] Existing USDC payment flow works end-to-end
- [ ] `EVM_RPC_URL` configured for Base mainnet
- [ ] Privy app created with wallet policies configured
- [x] Splits protocol verified on Base (chain 8453) — Push Split V2o2 validated in spike.0090

## As-Built Specs

- [web3-openrouter-payments](../../docs/spec/web3-openrouter-payments.md) — payment math, top-up state machine (draft)
- [operator-wallet](../../docs/spec/operator-wallet.md) — wallet lifecycle, custody, access control (draft)
- [financial-ledger](../../docs/spec/financial-ledger.md) — double-entry accounting, TigerBeetle accounts, USDC asset flows (draft)

## Design Notes

### Why Privy over local keystore?

Local keystores require generating, encrypting, and distributing private key material. The app loads the key into memory, making it a hot wallet with full signing authority. Privy provides:

1. **No key material in app** — HSM-backed signing, private key never leaves Privy infrastructure
2. **Wallet policies** — Privy-side guardrails (chain, contracts, caps) as defense in depth
3. **Signed requests** — `PRIVY_SIGNING_KEY` adds a second auth factor; leaked `APP_SECRET` alone can't sign
4. **Programmatic setup** — API call creates wallet, no keystore files to manage
5. **Portability** — `OperatorWalletPort` abstraction means we can swap to keystore/Vault later (P1)

The tradeoff: vendor dependency on Privy. Mitigated by the port abstraction — a `KeystoreOperatorWalletAdapter` can be built as a P1 OSS fallback.

### Why a Splits contract as receiving address?

The existing payment flow already handles USDC transfers to a configured address, verifies on-chain, and mints credits. A [Splits](https://splits.org/) mutable Split contract replaces app-level sweep logic with trustless on-chain distribution: ~92.1% to operator wallet, ~7.9% to DAO treasury. No custom contracts (Splits is pre-deployed, audited infrastructure — $250M+ distributed, zero protocol fees, non-upgradeable). The controller is the operator wallet, so percentages can be updated if pricing constants change.

After credit mint the app calls `distributeERC20()` — DAO treasury receives its share on-chain without any app-level sweep, `outbound_transfers` table, or retry logic.

### Scope boundary: Layer 1 only

This project covers **operator revenue routing** (user pays → Split → operator + treasury). It does NOT cover distributing treasury funds to DAO token holders or contributors. That is a separate concern:

- **Who earns what**: [proj.transparent-credit-payouts](proj.transparent-credit-payouts.md) — signed receipts, epoch-based payout statements
- **On-chain distribution to holders**: [proj.dao-dividends](proj.dao-dividends.md) — treasury → contributors via a second Splits contract (snapshot-updated or Liquid Split)

### OpenRouter top-up is the Coinbase Commerce protocol

OpenRouter returns a `transfer_intent` (not raw calldata) for the [Coinbase Commerce Onchain Payment Protocol](https://github.com/coinbase/commerce-onchain-payment-protocol). The Transfers contract (`0x03059433BCdB6144624cC2443159D9445C32b7a8` on Base) supports multiple transfer functions.

**Resolved by spike.0090:** The API does NOT return `metadata.function_name`. The correct function is `transferTokenPreApproved(intent)` — pays with USDC directly via ERC-20 `transferFrom` (NOT Permit2). The operator wallet approves USDC to the Transfers contract, then calls `transferTokenPreApproved`. No ETH swap needed. See [web3-openrouter-payments spec](../../docs/spec/web3-openrouter-payments.md) for full flow.

### Coinbase CDP Wallets / Agentic Wallets as Privy alternative

Coinbase launched [Agentic Wallets](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets) (Feb 2026) — wallet infrastructure purpose-built for AI agents on Base. TEE-backed signing (<200ms), declarative spending policies (per-tx caps, address allowlists, sanctions screening), and native [x402](https://docs.cdp.coinbase.com/agentic-wallet/welcome) support for machine-to-machine payments. SDKs in TypeScript, Python, Go.

**Why this matters for us:** We're already on Base and topping up via Coinbase Commerce — CDP Wallets would be the same vendor stack end-to-end. Their policy engine (address allowlists + tx caps enforced at enclave layer) is more mature than Privy's wallet policies. Privy was acquired by Stripe (Jun 2025), raising long-term ecosystem drift concerns.

**No architecture change needed.** `OperatorWalletPort` insulates us — a `CdpOperatorWalletAdapter` is a 1-PR swap. 0xSplits still handles revenue splitting (wallet providers don't solve that). Recommendation: spike is wallet-agnostic, evaluate CDP vs Privy stability at PR 1 time.

**x402 for DAO agent autonomy (P2+).** x402 embeds stablecoin payments into HTTP requests — an AI agent with wallet controls can discover and pay for services autonomously. This is the path to giving a DAO agent leader its own spending authority with on-chain guardrails (session caps, contract allowlists) rather than app-level permission checks. CDP's x402 Bazaar already has 50M+ txs. Directly relevant to the P2 "autonomous spending" and "x402 integration" roadmap items.

### Top-up economics (derived from constants)

```
openrouterTopUpUsd = paymentUsd × (1 + REVENUE_SHARE) / (MARKUP × (1 - PROVIDER_FEE))

Defaults: 1.75 / (2.0 × 0.95) = $0.9211 per $1.00 purchase
DAO share: $1.00 - $0.9211 = $0.0789 (7.9% margin)
```

See [web3-openrouter-payments spec](../../docs/spec/web3-openrouter-payments.md) for full derivation.
