---
id: web3-openrouter-payments
type: spec
title: "Web3 → OpenRouter Credit Top-Up"
status: draft
spec_state: draft
trust: draft
summary: When a user buys credits via USDC, the app tops up OpenRouter with the proportional provider cost via the operator wallet — closing the loop between inbound crypto payments and outbound LLM spending.
read_when: Working on operator wallet payments, OpenRouter crypto top-up, or the purchase→provision pipeline.
implements: proj.ai-operator-wallet
owner: derekg1729
created: 2026-02-17
verified: 2026-03-15
tags: [web3, billing, wallet, openrouter]
---

> **PARTIALLY RETIRED 2026-09-30 — not deleted, and deliberately so.**
>
> | part                                                                           | state                                                                                                                                            |
> | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
> | OpenRouter as the **AI provider**                                              | **LIVE.** Every model routes through it (`infra/compose/runtime/configs/litellm.config.yaml`), and `OPENROUTER_API_KEY` is a live runtime secret |
> | The **Coinbase Commerce credit top-up** path (`POST /api/v1/credits/coinbase`) | **DEAD.** OpenRouter removed it; it returns `410 Gone`. No `fundOpenRouterTopUp` call survives in non-test code                                  |
>
> Outbound provider payment is superseded by x402 per [x402-e2e.md](./x402-e2e.md), under the boundary
> in [node-operator-x402.md](./node-operator-x402.md). Retained because live code still cites it
> (`shared/env/server-env.ts:365`) and because the provider half is current — a blanket purge would
> have mislabelled a live dependency as dead.

# Web3 → OpenRouter Credit Top-Up

> When a user pays for credits, the system automatically provisions OpenRouter with the exact provider cost — derived from existing billing constants, never hardcoded.

### Key References

|              |                                                                                                             |                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Project**  | [proj.ai-operator-wallet](../../work/projects/proj.ai-operator-wallet.md)                                   | Roadmap, key management, wallet design  |
| **Research** | [AI Operator Wallet](../research/ai-operator-wallet-budgeted-spending.md)                                   | Custody options evaluation              |
| **Spec**     | [Payments Design](./payments-design.md)                                                                     | Inbound USDC payment flow               |
| **Spec**     | [Billing Evolution](./billing-evolution.md)                                                                 | Credit unit standard, markup            |
| **Spec**     | [Operator Wallet](./operator-wallet.md)                                                                     | Wallet lifecycle, signing port, custody |
| **Spec**     | [DAO Enforcement](./dao-enforcement.md)                                                                     | Financial rails, repo-spec config       |
| **External** | [Coinbase Commerce Onchain Payment Protocol](https://github.com/coinbase/commerce-onchain-payment-protocol) | Contract source + deployed addresses    |
| **External** | [OpenRouter Crypto API](https://openrouter.ai/docs/guides/guides/crypto-api)                                | Charge creation + transfer_intent docs  |

## Design

### Economics

The OpenRouter top-up amount per dollar of user payment is derived from three existing constants — no standalone magic numbers.

```
Given:
  MARKUP           = USER_PRICE_MARKUP_FACTOR        (default 2.0)
  REVENUE_SHARE    = SYSTEM_TENANT_REVENUE_SHARE     (default 0.75)
  PROVIDER_FEE     = OPENROUTER_CRYPTO_FEE           (default 0.05 — 5%)

User pays $1.00 USDC to Split contract.
Split distributes: ~92.1% → operator wallet, ~7.9% → DAO treasury.

User credits:    $1.00 worth  → consumes $0.50 of provider cost   (1 / MARKUP)
System credits:  $0.75 worth  → consumes $0.375 of provider cost  (REVENUE_SHARE / MARKUP)
                                ───────────────────────────────────
Net provider cost:    $0.875                                      (1 + REVENUE_SHARE) / MARKUP

OpenRouter takes 5% fee off every crypto top-up. To land $0.875 of actual credits:
Gross top-up sent:    $0.9211                                     net / (1 - PROVIDER_FEE)
                    = $0.875 / 0.95

After fee: $0.9211 × 0.95 = $0.875 ← exact provider cost covered ✓
DAO share: $1.00 - $0.9211 = $0.0789 (7.9% margin, routed by Split to treasury on-chain)

Formula:
  openrouterTopUpUsd = paymentUsd × (1 + REVENUE_SHARE) / (MARKUP × (1 - PROVIDER_FEE))
  daoShareUsd        = paymentUsd - openrouterTopUpUsd
```

The gross-up ensures OpenRouter always receives the exact provider cost after their fee. The DAO retains 7.9% margin at default constants. All three constants are env-configurable; the formula adapts automatically.

### Purchase → Provision Flow

```mermaid
sequenceDiagram
    participant User
    participant Split as Split Contract
    participant Wallet as Operator Wallet (EOA)
    participant Treasury as DAO Treasury
    participant App as verifyAndSettle / runPostCreditFunding
    participant DB as Database + TigerBeetle
    participant Adapter as OpenRouterFundingAdapter
    participant OR as OpenRouter API
    participant Chain as Base (8453)

    User->>Split: USDC transfer (existing payment flow)
    App->>App: verify on-chain, mint credits (Steps 1-2, CREDITED transition)

    Note over App,Split: Step 3: Splits Distribution
    App->>Split: distributeERC20(USDC)
    Split->>Wallet: ~92.1% USDC (operator share)
    Split->>Treasury: ~7.9% USDC (DAO share)

    Note over App,DB: Step 4: TB co-write (Treasury → OperatorFloat)
    App->>DB: financialLedger.transfer(SPLIT_DISTRIBUTE)

    Note over Adapter: Step 5: Provider Funding (non-blocking)
    App->>Adapter: fundAfterCreditPurchase(context)
    Adapter->>DB: upsert provider_funding_attempts (pending)
    Adapter->>OR: POST /api/v1/credits/coinbase
    OR-->>Adapter: {transfer_intent}
    Adapter->>DB: update → charge_created (store charge_id)
    Adapter->>Wallet: fundOpenRouterTopUp(intent)
    Wallet->>Chain: approve + transferTokenPreApproved
    Chain-->>Adapter: tx confirmed
    Adapter->>DB: update → funded (store funding_tx_hash)

    Note over App,DB: Step 6: TB co-write (OperatorFloat → ProviderFloat)
    App->>DB: financialLedger.transfer(PROVIDER_TOPUP)
```

### OpenRouter Charge → On-Chain Transaction

OpenRouter's `/api/v1/credits/coinbase` does **not** return ready-to-sign calldata. It returns a `transfer_intent` for the [Coinbase Commerce Onchain Payment Protocol](https://github.com/coinbase/commerce-onchain-payment-protocol). The API does **not** return a `function_name` field — the caller determines the function from the intent shape.

> **Resolved by spike.0090 (2026-03-09):** The correct function is `transferTokenPreApproved` (USDC input via direct ERC-20 `transferFrom`). The contract address returned by OpenRouter is `0x03059433BCdB6144624cC2443159D9445C32b7a8` — a newer Coinbase Commerce Transfers contract, NOT the original `0xeADE6...` from the protocol repo. ERC-20 approval must go to the **Transfers contract itself** — the contract calls `erc20.allowance(msg.sender, address(this))` then `safeTransferFrom`. Permit2 is NOT involved. The operator wallet needs only USDC (from Split distribution) + trace ETH for gas. No ETH funding strategy required. Full chain validated end-to-end: USDC → Split → operator wallet → OpenRouter credits (23.6s, 247k total gas).

The workflow:

1. **Create charge** → `POST /api/v1/credits/coinbase` with `{ amount, sender, chain_id: 8453 }` (`chain_id` must be a number, not string). Receives `transfer_intent` with `metadata.contract_address`, `call_data` (recipient, amounts, deadline, signature, etc.)
2. **Approve USDC to Transfers contract** → ERC-20 `approve(TRANSFERS_CONTRACT, recipientAmount + feeAmount)`. The contract uses direct `safeTransferFrom`, not Permit2.
3. **Encode the contract call** → `transferTokenPreApproved(intent)` on `metadata.contract_address`. Note: `call_data.deadline` is an ISO 8601 string (e.g. `"2026-03-11T08:30:49Z"`), must be converted to unix timestamp for the contract.
4. **Simulate** → `publicClient.simulateContract()` before broadcast to prevent reverts
5. **Sign + broadcast** → via `OperatorWalletPort.fundOpenRouterTopUp(intent)`

```typescript
// Transfer intent shape from OpenRouter (spike.0090 verified 2026-03-09)
interface TransferIntent {
  metadata: {
    chain_id: number;
    contract_address: string; // Coinbase Transfers contract (see below)
    sender: string; // must === operator wallet address
  };
  call_data: {
    recipient_amount: string; // USDC atomic units (6 decimals), e.g. "1039500" = 1.0395 USDC
    deadline: string; // ISO 8601 string (e.g. "2026-03-11T08:30:49Z") — convert to unix timestamp for contract
    recipient: string; // OpenRouter's receiving address
    recipient_currency: string; // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (Base USDC)
    refund_destination: string;
    fee_amount: string; // USDC atomic units — OpenRouter's 5% fee (e.g. "10500" = 0.0105 USDC)
    id: string; // bytes16 charge identifier
    operator: string;
    signature: string; // OpenRouter's authorization signature
    prefix: string;
  };
}

// Coinbase Transfers contract on Base mainnet
// spike.0090: OpenRouter returns 0x0305..., NOT the old 0xeADE6... from the protocol repo.
// The allowlist MUST include the address OpenRouter returns in metadata.contract_address.
const TRANSFERS_CONTRACT = "0x03059433BCdB6144624cC2443159D9445C32b7a8";

// ERC-20 approval target: the Transfers contract itself (NOT Permit2).
// Source: Transfers.sol checks erc20.allowance(msg.sender, address(this)) then safeTransferFrom.
```

### Top-Up Amount Calculation

A single pure function computes the gross OpenRouter top-up amount from existing constants:

```typescript
/**
 * Calculate the gross OpenRouter top-up amount for a given user payment.
 * Accounts for provider fee so the net credited amount covers full provider cost.
 *
 * Formula: paymentUsd × (1 + revenueShare) / (markupFactor × (1 - providerFee))
 */
function calculateOpenRouterTopUp(
  paymentUsd: number,
  markupFactor: number,
  revenueShare: number,
  providerFee: number
): number {
  return (paymentUsd * (1 + revenueShare)) / (markupFactor * (1 - providerFee));
}

// calculateDaoShare is NOT needed — the Splits contract handles DAO share
// routing on-chain. The Split percentages are derived from the same constants:
//   operatorPct ≈ (1 + REVENUE_SHARE) / (MARKUP × (1 - PROVIDER_FEE))
//   daoPct      ≈ 1 - operatorPct
```

### Signing Gates

Top-up-specific signing constraints (wallet lifecycle and custody are in [operator-wallet spec](./operator-wallet.md)):

| Gate                     | Enforcement                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chain lock**           | Only `chain_id` from `.cogni/repo-spec.yaml` (Base 8453). Enforced by existing DAO enforcement rails — see [dao-enforcement spec](./dao-enforcement.md).                                                |
| **Contract allowlist**   | `to` MUST equal `TRANSFERS_CONTRACT` (`0x0305...` — Coinbase Commerce on Base). Reject any other destination. ERC-20 approval also targets the Transfers contract (direct `transferFrom`, not Permit2). |
| **Sender match**         | `transfer_intent.metadata.sender` MUST equal the operator wallet address.                                                                                                                               |
| **Simulate before send** | `publicClient.simulateContract()` MUST succeed before signing. Reverted simulations abort the top-up.                                                                                                   |
| **Max value per tx**     | `OPERATOR_MAX_TOPUP_USD` env cap (e.g. $500). Reject charges exceeding this.                                                                                                                            |

### Top-Up State Machine

Money movement requires durable state tracking beyond charge_receipts (which are audit-only, written once on success).

**States:** `pending` → `charge_created` → `funded` (terminal: `failed`)

```
pending          → charge_created  (OpenRouter charge created, store charge_id)
charge_created   → funded          (on-chain tx confirmed, store funding_tx_hash)

Any state        → failed          (unrecoverable error)
```

**Crash recovery semantics:**

- `pending`: safe to retry — row exists but no charge yet; re-insert is idempotent (deterministic UUID)
- `charge_created`: resume from stored `chargeId` — create a fresh charge (old may have expired), update row's `chargeId`, then fund
- `funded`: idempotent skip — return stored `fundingTxHash`
- `failed`: skip (don't auto-retry failed attempts)

### DAO Treasury Share (handled by Splits — no app logic)

The DAO's ~7.9% share is routed trustlessly by the [Splits](https://splits.org/) contract. After credit mint, the app calls `distributeERC20(USDC)` on the Split contract — the Split sends the DAO's share to treasury and the operator's share to the operator wallet. No `outbound_transfers` table, no app-level sweep logic, no retry infrastructure.

See [proj.ai-operator-wallet](../../work/projects/proj.ai-operator-wallet.md) PR 2 for Split deployment details.

## Goal

Close the financial loop: every user credit purchase automatically provisions the corresponding provider cost on OpenRouter via the operator wallet — while forwarding the DAO's margin to the treasury. No manual transfers, no custom smart contracts.

## Non-Goals

- Custom smart contracts (PaymentRouter) — app handles routing
- Atomic on-chain split — two separate transactions (treasury forward + top-up) are acceptable
- Automated balance monitoring / low-balance top-ups (P1)
- DAO governance approval per top-up (operator wallet is pre-authorized)
- Multi-provider top-up routing (OpenRouter only)
- Refunds or reversal flows
- Circuit breaker (P1 — log failures for now)

## Invariants

| Rule                      | Constraint                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| TOPUP_FROM_CONSTANTS      | Top-up amount MUST be computed as `paymentUsd × (1 + REVENUE_SHARE) / (MARKUP × (1 - PROVIDER_FEE))`. No hardcoded ratio.     |
| TOPUP_AFTER_CREDIT        | Top-up workflow MUST dispatch only after both user and system tenant credits are committed to the ledger.                     |
| TOPUP_IDEMPOTENT          | Each top-up is keyed by `clientPaymentId`. Replay of the same payment reference MUST NOT create a second OpenRouter charge.   |
| TOPUP_STATE_DURABLE       | Every top-up MUST have a persistent state record. Transitions are append-only (state + timestamp). No in-memory-only top-ups. |
| TOPUP_RECEIPT_LOGGED      | Every CONFIRMED top-up MUST produce a `charge_receipt` with `charge_reason = 'openrouter_topup'` and the on-chain `tx_hash`.  |
| SIMULATE_BEFORE_BROADCAST | Every transaction MUST pass `simulateContract()` before signing. Simulation failure aborts the top-up (→ FAILED).             |
| CONTRACT_ALLOWLIST        | `WalletSignerPort` MUST reject any transaction where `to` is not in the destination allowlist.                                |
| SENDER_MATCH              | `transfer_intent.metadata.sender` MUST equal the operator wallet address. Mismatch aborts the top-up.                         |
| MAX_TOPUP_CAP             | Single top-up MUST NOT exceed `OPERATOR_MAX_TOPUP_USD`. Charges above this cap are rejected before OpenRouter API call.       |
| NO_REBROADCAST            | A top-up in `TX_BROADCAST` state MUST NOT be re-broadcast. Only poll for confirmation or fail after timeout.                  |
| MARGIN_PRESERVED          | `(1 + REVENUE_SHARE) / (MARKUP × (1 - PROVIDER_FEE)) < 1` MUST hold. Application MUST fail fast at startup if violated.       |
| DAO_SHARE_VIA_SPLIT       | Every settled payment MUST trigger `distributeERC20()` on the Split contract. DAO share is routed on-chain, not by app logic. |

### Margin Safety Check

`MARGIN_PRESERVED` requires: `(1 + REVENUE_SHARE) / (MARKUP × (1 - PROVIDER_FEE)) < 1`, i.e., `MARKUP × (1 - PROVIDER_FEE) > 1 + REVENUE_SHARE`.

With defaults: `2.0 × 0.95 = 1.9 > 1.75` — DAO margin is 7.9% per dollar. The application MUST validate this inequality at startup and fail fast if violated.

### Schema

**Table:** `provider_funding_attempts` — durable crash-recovery state for provider top-ups.

| Column              | Type        | Constraints                    | Description                                                    |
| ------------------- | ----------- | ------------------------------ | -------------------------------------------------------------- |
| `id`                | UUID        | PK                             | Deterministic: `uuid5(TB_TRANSFER_NAMESPACE, paymentIntentId)` |
| `payment_intent_id` | TEXT        | NOT NULL, UNIQUE               | Links to originating user payment (idempotency key)            |
| `status`            | TEXT        | NOT NULL, default `pending`    | `pending` / `charge_created` / `funded` / `failed`             |
| `provider`          | TEXT        | NOT NULL, default `openrouter` | Provider identifier                                            |
| `charge_id`         | TEXT        | nullable                       | OpenRouter charge id (reuse on resume)                         |
| `charge_expires_at` | TIMESTAMPTZ | nullable                       | OpenRouter charge expiry                                       |
| `amount_usdc_micro` | BIGINT      | nullable                       | Gross top-up amount (scale=6)                                  |
| `funding_tx_hash`   | TEXT        | nullable                       | On-chain tx hash (set on `funded`)                             |
| `error_message`     | TEXT        | nullable                       | Last error message (set on `failed`)                           |
| `created_at`        | TIMESTAMPTZ | NOT NULL, default now()        |                                                                |
| `updated_at`        | TIMESTAMPTZ | NOT NULL, default now()        |                                                                |

**Indexes:**

- `provider_funding_attempts_payment_intent_id_unique` — UNIQUE on `payment_intent_id`
- `provider_funding_attempts_status_idx` — `(status, created_at)` for status-based queries

### File Pointers

| File                                                          | Purpose                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/core/billing/pricing.ts`                                 | `calculateOpenRouterTopUp()`, `isMarginPreserved()` — pure top-up math                                |
| `src/ports/provider-funding.port.ts`                          | `ProviderFundingPort` interface                                                                       |
| `src/ports/operator-wallet.port.ts`                           | `OperatorWalletPort` interface — see [operator-wallet spec](./operator-wallet.md)                     |
| `src/adapters/server/treasury/openrouter-funding.adapter.ts`  | `OpenRouterFundingAdapter` — charge creation, crash recovery, wallet delegation                       |
| `src/features/payments/application/confirmCreditsPurchase.ts` | `runPostCreditFunding()` — extracted steps 3-6, invoked from `verifyAndSettle` on CREDITED transition |
| `src/features/payments/services/paymentService.ts`            | `verifyAndSettle()` — canonical CREDITED trigger, calls `runPostCreditFunding`                        |
| `src/shared/env/server-env.ts`                                | `OPENROUTER_API_KEY`, `OPENROUTER_CRYPTO_FEE`                                                         |
| `packages/db-schema/src/billing.ts`                           | `providerFundingAttempts` table definition                                                            |
| `packages/financial-ledger/src/domain/accounts.ts`            | `ASSETS_PROVIDER_FLOAT`, `TB_TRANSFER_NAMESPACE`, `TRANSFER_CODE`                                     |

## Open Questions

- [x] What is the minimum top-up amount? **$1 minimum, $100K maximum** (spike.0090 confirmed $1 works; API error says "between 1 and 100000"). Small payments below $1 should be batched.
- [x] ~~Should the two outbound transactions (treasury forward + top-up) be dispatched sequentially or in parallel?~~ Treasury forward is now handled by Splits `distribute()` — only one app-initiated outbound tx (the top-up).
- [x] ~~Which `metadata.function_name` does OpenRouter return?~~ **API does not return `function_name`.** Correct function is `transferTokenPreApproved` (USDC input via direct ERC-20 `transferFrom` — NOT Permit2). Contract source: `erc20.allowance(msg.sender, address(this))` then `safeTransferFrom`. No ETH swap needed. (spike.0090, 2026-03-09)
- [x] ~~Does `metadata.contract_address` match the confirmed Coinbase Transfers address (`0xeADE6...`)?~~ **No.** OpenRouter returns `0x03059433BCdB6144624cC2443159D9445C32b7a8` — a newer contract. The old `0xeADE6...` from the protocol repo is stale. Allowlist updated. (spike.0090, 2026-03-09)

## Related

- [Payments Design](./payments-design.md) — Inbound USDC payment state machine
- [Billing Evolution](./billing-evolution.md) — Credit unit standard, markup factor
- [DAO Enforcement](./dao-enforcement.md) — Financial rails, repo-spec
- [Operator Wallet](./operator-wallet.md) — Wallet lifecycle, signing port, custody
- [proj.ai-operator-wallet](../../work/projects/proj.ai-operator-wallet.md) — Project roadmap
