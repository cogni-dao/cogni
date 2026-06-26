# DePay Payments Integration

**⚠️ DEPRECATED:** This document describes the original DePay widget approach. The project has moved to a direct wagmi/viem implementation with backend verification.

**See instead:** [Payments Design](../spec/payments-design.md) - Current payment system design

---

## Historical Context

DePay Widgets was the **initial MVP crypto payment UI** for topping up internal credits. It sat in the **payments layer** and fed the **billing layer** by creating `credit_ledger` entries, but did **not** replace or change the dual-cost billing system defined in:

- [Accounts Design](../spec/accounts-design.md)
- [Billing Evolution](../spec/billing-evolution.md)
- [DAO Enforcement](../spec/dao-enforcement.md) (Binding enforcement rules)

Billing = how we track and charge for LLM usage (credits, provider_cost_credits, user_price_credits).
Payments = how users acquire credits (DePay widgets, on-chain watchers, etc).

---

## MVP Scope

**For MVP, only Sections 3 and 4 are required for the first working loop.**

- **Section 3:** Frontend Implementation (DePay widget + payment confirmation)
- **Section 4:** Backend Implementation (confirm endpoint + service logic)

**Sections 5–7** describe post-MVP hardening, security monitoring, and operational procedures. These are **not blocking** for initial DePay integration but document future improvements.

---

## 1. What DePay Widgets Actually Provides (OSS only)

DePay is a **frontend-only payment widget library** that renders a crypto payment UI and handles:

- Wallet connection for multiple chains (EVM, Solana, etc.)
- Token selection and on-chain transfer
- Routing and swap optimization for best rates
- Detection that a payment has been confirmed on-chain
- Event callbacks: `validated`, `succeeded`, `failed` when payment state changes

**Key facts (current state):**

- **OSS Mode ONLY:** No DePay integration ID, no tracking API, no DePay backend, **0% fees**.
- Widget API:
  - `DePayWidgets.Payment({ accept: [...] })` — declarative payment configuration
  - `accept` array defines: blockchain, token, receiver address, amount (optional)
  - Callbacks: `validated`, `succeeded`, `failed` fire in the browser based on blockchain confirmations
- **Critical distinction:** DePay offers two modes:
  - **OSS unmanaged (MVP):** Widget-only, no tracking, no callbacks to DePay backend, 0% fees
  - **Managed platform (future):** Integration ID, tracking API, payment verification callbacks, 1.5% fees (**not used**)

**Critically:**

- In OSS mode, DePay widgets do **not** provide:
  - Server-side webhooks or signed callbacks
  - DePay backend verification of payments
  - Payment tracking dashboard
- All "success" information is **frontend only** (`succeeded` event fires when blockchain confirms transaction)
- Transaction hash and amount **are** available in the `succeeded` callback (unlike Resmic), but MVP does not verify them server-side

**Implication:** DePay OSS mode is a UI convenience, not a Stripe-like billing backend. We must assume:

> "If DePay widget fires `succeeded`, a payment was confirmed on-chain to our address."

For MVP, we will accept this trust assumption and treat the DePay widget as a **soft oracle** for incoming payments, **identical to the Resmic model**.

**Reference:** [DePay Widgets Documentation](https://depay.com/documentation/widgets)

---

## 1.5 Security Model: DePay OSS vs Resmic (Equivalent)

**Assessment:** Switching from Resmic to DePay widgets (OSS mode, without DePay tracking API) does **NOT** weaken security. Both rely on a trusted frontend call to the backend.

| Aspect          | Resmic                                                                       | DePay OSS (MVP)                                                             |
| --------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Signal**      | `setPaymentStatus(true)` callback fires after N confirmations                | `succeeded` event fires after blockchain confirms transaction               |
| **Server View** | Browser calls `/payments/confirm` with `amountUsdCents` + `clientPaymentId`  | Browser calls `/payments/confirm` with `amountUsdCents` + `clientPaymentId` |
| **Hard Limits** | No server-side webhook or signed payload; client can fabricate confirm calls | If DePay tracking API is NOT used, no DePay backend validates payments      |
| **Net Effect**  | Trust authenticated session + frontend signal                                | Trust authenticated session + frontend signal                               |

**Conclusion:** Both models are **soft oracles**. The backend trusts:

1. SIWE-authenticated session (guarantees user identity)
2. Frontend integrity (assumes user is not maliciously fabricating payment signals)

**Future Hardening Options:**

- **DePay Tracking API (post-MVP):** Forward transaction hash + trace to DePay Payments API; rely on their validation before crediting
- **Ponder On-Chain Watcher (post-MVP):** Run indexer that reconciles DAO wallet inflows vs `credit_ledger` and flags fraud

Both hardening paths are **identical to the original Resmic plan** — the security model is unchanged.

---

## 2. Separation of Concerns: Billing vs Payments

We keep a **hard separation**:

- **Billing layer** (already spec'd in `BILLING_EVOLUTION.md`):
  - Tables: `billing_accounts`, `credit_ledger`, `charge_receipts`
  - Invariants:
    - Credits in **BIGINT** (`1 credit = $0.001`)
    - `user_price_credits ≥ provider_cost_credits` per LLM call
    - All debits/credits recorded in `credit_ledger`
- **Payments layer** (this doc):
  - Integrates **DePay widgets** as one source of "credits UP"
  - Adds `credit_ledger` rows with `reason = 'widget_payment'` (or `'depay_payment'` if preferred)
  - Does **not** compute LLM costs; just funds balances

**Concretely:**

- Billing only cares: "`billing_accounts.balance_credits` increased by N with reason `'widget_payment'`."
- Payments (DePay) decides: "User has sent X USD worth of tokens to our address; we convert that to credits and call billing."

---

## 2.5 MVP Security Boundary

**For MVP, the ONLY trust boundary for credits is:**

1. **SIWE-authenticated session** (HttpOnly cookie, resolved by Auth.js)
2. **DePay widget running in an authenticated UI** (frontend-only payment widget)
3. **Our `POST /api/v1/payments/confirm` endpoint** — resolves `billing_account_id` from session, validates idempotency via `clientPaymentId`, writes `credit_ledger` + updates `billing_accounts.balance_credits`

**What is NOT in the MVP critical path:**

- ❌ On-chain verification (tx hash not verified server-side in MVP)
- ❌ DePay tracking API or signed callbacks (OSS mode does not include DePay backend)
- ❌ Ponder on-chain watcher (introduced post-MVP for reconciliation; see `docs/PAYMENTS_PONDER_VERIFICATION.md`)

**Security posture:** We trust the SIWE session and treat DePay widgets as a soft oracle, **identical to the Resmic design**. Post-MVP hardening via DePay tracking API and/or Ponder is described in Sections 5-7.

---

## 3. Frontend Implementation (MVP Required)

### 3.1 Prerequisites

- [x] SIWE-authenticated session (Auth.js) working with JWT cookies.
- [x] `.cogni/repo-spec.yaml` declares `payments_in.widget.receiving_address` and `governance.chain_id` (governance, no env override).
- [x] Chain hardcoded to Base mainnet (8453); validated against repo-spec by `scripts/validate-chain-config.ts`.
- [x] Shared chain config lives at `src/shared/web3/chain.ts` (current values: `DEPAY_BLOCKCHAIN = "base"`, USDC on Base mainnet).

### 3.2 DePay Widget Integration (CDN, OSS)

- [x] Widget wrapper: `src/components/vendor/depay/DePayWidget.client.tsx` (client-only).
- [x] Loads CDN script `https://integrate.depay.com/widgets/v12.js`; no app-wide providers.
- [x] Props: `amountUsd`, `receiverAddress`, `disabled`, `onSucceeded(txInfo)`, `onFailed(message)`.
- [x] No DePay tracking API, no integration ID, no managed fees.

### 3.3 Credits Page Composition

- [x] Credits page: `src/app/(app)/credits/page.tsx` (composer).
- [x] Responsibilities:
  - [x] Amount selection.
  - [x] Idempotency: derive `clientPaymentId` from `txHash` (fallback UUID) and store per attempt.
  - [x] Confirm call to `POST /api/v1/payments/credits/confirm` with `amountUsdCents`, `clientPaymentId`, metadata (`provider: depay`, `txHash`, `blockchain`, `token`, `timestamp`).
- [x] The page does **not** import `@depay/widgets` directly; it only uses the vendor wrapper.

### 3.4 Payment Confirmation Flow

- [x] On `succeeded`:
  - [x] Derive `clientPaymentId` from `txHash` (fallback UUID), persist once per attempt.
  - [x] Compute `amountUsdCents = amountUsd * 100`.
  - [x] POST to `/api/v1/payments/credits/confirm` with `amountUsdCents`, `clientPaymentId`, and metadata (`provider: depay`, `txHash`, `blockchain`, `token`, `timestamp`).
  - [x] Handle 200/401/500 responses; refresh summary on success.
- [x] Do **not** send `billingAccountId`; backend resolves it from session only.

### 3.5 UI/UX Requirements

- [x] "Buy Credits" button in header/sidebar when logged in
- [x] Credit balance display (fetch from API, no client-side conversion needed)
- [x] Payment amount selector (preset amounts: 10, 25, 50, 100 USD)
- [x] Loading state during DePay transaction
- [x] Success confirmation with new balance
- [x] Error messaging for failed payments

### 3.6 Credits Page (MVP UI)

- [x] Protected route `/credits` under `(app)` showing current balance, "Buy credits" card, and recent transactions.
- [x] Payment method: crypto only (DePay). Auto top-up not supported.
- [x] Purchase CTA triggers DePay widget; on success, call confirm endpoint and refresh balance/ledger.
- [ ] Recent transactions table lists latest `credit_ledger` rows (amount, date, status) with link to full usage.
- [ ] Notes block explicitly clarifies crypto-only (currently implied via “Powered by DePay. No auto top-up.”).
- [x] Loading/empty states for balance and transactions.

---

## 4. Backend Implementation (MVP Required)

### 4.1 API Endpoint

**Endpoint:** `POST /api/v1/payments/credits/confirm`

**Auth:** SIWE session (HttpOnly cookie)

**Input (validated via Zod contract):**

- `amountUsdCents` (integer cents, REQUIRED, e.g., 1000 = $10.00)
- `clientPaymentId` (UUID, REQUIRED for idempotency)
- `metadata` (optional object: chain, token, txHash, timestamp)

**Behavior:**

1. Resolve `billing_account_id` from SIWE session (only source of truth)
2. If no billing account exists yet, create it by calling `getOrCreateBillingAccountForUser(session.user)` before any credit mutations
3. Check idempotency: query `credit_ledger` for existing row with `reason = 'widget_payment'` AND `reference = clientPaymentId`
   - If exists: return `{ billingAccountId, balanceCredits }` (no-op, idempotent)
   - If new: proceed to step 4
4. Compute credits using integer math:
   - With `1 credit = $0.001` and `1 cent = $0.01`, therefore `1 cent = 10 credits`
   - Formula: `credits = amountUsdCents * 10`
   - Alternative with CREDITS_PER_USDC: `credits = (amountUsdCents * CREDITS_PER_USDC) / 100` (integer division)
5. Insert `credit_ledger` row:
   - `billing_account_id` (from session)
   - `virtual_key_id` (default key for account)
   - `amount = credits` (BIGINT, positive value)
   - `reason = 'widget_payment'` (or `'depay_payment'` if preferred; can also keep `'resmic_payment'` for backwards compatibility during transition)
   - `reference = clientPaymentId` (required for idempotency)
   - `metadata = serialized JSON` (amountUsdCents, chain, token, txHash, timestamp)
6. Update `billing_accounts.balance_credits += credits`
7. Return `{ billingAccountId, balanceCredits }`

**Implementation checklist:**

- [x] Route file: `src/app/api/v1/payments/credits/confirm/route.ts`
- [x] Zod contract: `src/contracts/payments.credits.confirm.v1.contract.ts`
  - [x] Request schema: `{ amountUsdCents: number, clientPaymentId: string, metadata?: object }`
  - [x] Response schema: `{ billingAccountId: string, balanceCredits: number }`
- [x] Route handler:
  - [x] Extract SIWE session from cookie
  - [x] Validate session exists and is active
  - [x] Parse and validate request body against contract
  - [x] Resolve `billing_account_id` from session (never from body) and call `getOrCreateBillingAccountForUser(session.user)` before credit mutations
  - [x] Call payment service with session-derived `billingAccountId` and validated data
  - [x] Return response with new balance

**Files:**

- `src/app/api/v1/payments/credits/confirm/route.ts` - Route handler
- `src/contracts/payments.credits.confirm.v1.contract.ts` - Contract definition
- `tests/stack/payments/credits-confirm.stack.test.ts` - Stack tests

### 4.2 Service Layer

- [x] Service: `src/features/payments/services/creditsConfirm.ts`
- [x] Logic:
  - [x] Idempotency: find `credit_ledger` by `reason = 'widget_payment'` and `reference = clientPaymentId`; return existing balance if found.
  - [x] Compute credits: `amountUsdCents * 10` (integer math, 1 cent = 10 credits).
  - [x] Use default `virtual_key_id` for the billing account.
  - [x] Insert `credit_ledger` row with `{ billing_account_id, virtual_key_id, amount, reason: 'widget_payment', reference: clientPaymentId, metadata }`.
  - [x] Update `billing_accounts.balance_credits` atomically.
  - [x] Return new balance.

**Files:**

- `src/features/payments/services/creditsConfirm.ts`
- `tests/stack/payments/credits-confirm.stack.test.ts`

### 4.3 Database Changes

- [x] `credit_ledger.reference` field exists (present in schema).
- [ ] Index on `credit_ledger.reference` for idempotency lookups (verify or add if missing).
- [x] `credit_ledger.metadata` JSONB column stores payment metadata.

### 4.4 Environment Configuration

- [x] DAO receiving wallet + chain come from `.cogni/repo-spec.yaml` (no env override); server helper reads/caches config for the credits page.
- [x] `src/shared/env/client.ts` only validates `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` for optional wallet connectivity.

---

## 5. Post-MVP: Security & Monitoring

**Note:** This section describes future hardening. Not required for MVP.

### 5.1 Rate Limiting (Future)

- [ ] Implement rate limiting on `/payments/confirm`:
  - [ ] Max 10 payments per hour per account
  - [ ] Max $1000 USD equivalent per day per account
  - [ ] Return 429 on rate limit exceeded
- [ ] Add request logging for all payment attempts

### 5.2 Manual Reconciliation Process (Future)

- [ ] Create reconciliation script: `scripts/reconcile/payments.ts`
- [ ] Script functionality:
  - [ ] Query DAO wallet address for incoming stablecoin transfers (via RPC for chosen chain)
  - [ ] List all `credit_ledger` entries with `reason = 'widget_payment'` (or `'depay_payment'`)
  - [ ] Compare on-chain totals vs credited totals
  - [ ] Flag discrepancies for manual review
  - [ ] Output CSV report with mismatches
- [ ] Add to ops runbook: `docs/runbooks/PAYMENTS_RECONCILIATION.md`

### 5.3 Monitoring & Alerts (Future)

- [ ] Add monitoring for:
  - [ ] Payment confirmation success rate
  - [ ] Total credits purchased per day
  - [ ] Failed payment attempts (401, 500 errors)
- [ ] Alert conditions:
  - [ ] More than 5 failed payments in 10 minutes
  - [ ] Daily credit total exceeds expected threshold

---

## 6. Testing Notes (Current + Post-MVP)

- DePay does **not** support real payments on testnets; only mainnets settle on-chain.
- For local/testing, use mocking: [`@depay/web3-mock`](https://www.npmjs.com/package/@depay/web3-mock).
- Current flow can be exercised against Sepolia UI for UX/idempotency paths, but on-chain settlement will not occur without mocks.

### 6.1 Unit Tests (MVP: Basic Coverage)

### 6.1 Unit Tests (MVP: Basic Coverage)

- [ ] Payment service idempotency (duplicate `clientPaymentId` handling - must return same balance)
- [ ] Credit calculation accuracy: `amountUsdCents * 10 = credits`
- [ ] Error handling for invalid session, missing fields

### 6.2 Integration Tests (Post-MVP: Full Coverage)

- [ ] Full flow with real database:
  - [ ] Create session, call confirm, verify ledger entry
  - [ ] Test idempotency: call confirm twice with same `clientPaymentId`, verify balance only credited once
  - [ ] Verify balance updates atomically
- [ ] Rate limiting enforcement

### 6.3 Stack Tests (MVP: Basic E2E)

- [ ] End-to-end API test hitting `/payments/confirm`
- [ ] Test with valid SIWE session (billing account resolved from session)
- [ ] Test unauthorized (no session) → expect 401
- [ ] Test duplicate `clientPaymentId` → expect 200 OK with existing balance

### 6.4 Manual Testing Checklist (MVP)

- [ ] Frontend integration:
  - [ ] Install DePay widget in dev environment
  - [ ] Connect wallet, trigger payment on testnet (Base Sepolia or Polygon Mumbai)
  - [ ] Verify DePay widget `succeeded` callback fires
  - [ ] Confirm backend endpoint called with correct payload
  - [ ] Check balance updated in UI
- [ ] Idempotency:
  - [ ] Call confirm endpoint twice with same `clientPaymentId`
  - [ ] Verify second call returns 200 OK with same balance (no-op)
  - [ ] Verify ledger only has one entry for that `clientPaymentId`

---

## 7. Post-MVP: Future Hardening

**Note:** These improvements are not part of the initial shipping loop.

### 7.1 Current Limitations (Accepted for MVP)

**No cryptographic proof in backend:**

- ❌ DePay OSS mode does not verify payments server-side
- ❌ MVP does not verify transaction hash in confirm endpoint
- ❌ Must trust frontend `succeeded` signal

**Client can lie:**

- ❌ Malicious client could call `/confirm` without DePay payment
- ⚠️ Mitigated by: SIWE auth, rate limiting (post-MVP), manual reconciliation

**No automatic reconciliation:**

- ❌ No on-chain watcher comparing DAO wallet balance to ledger
- ⚠️ Mitigated by: manual reconciliation script (post-MVP)

### 7.2 Future Improvements

**Option 1: DePay Tracking API (Managed Mode)**

- [ ] Upgrade to DePay managed platform:
  - [ ] Create DePay integration ID
  - [ ] Configure tracking and callbacks
  - [ ] Forward transaction trace to DePay Payments API
  - [ ] Rely on DePay backend validation before crediting
  - [ ] **Trade-off:** 1.5% fee on payments
  - [ ] **Benefit:** Server-side payment verification, fraud detection, dashboard

**Option 2: Ponder On-Chain Watcher (Self-Hosted)**

- [ ] Add on-chain watcher service (Ponder):
  - [ ] Run Ponder indexer as separate service watching Base/Base Sepolia (or chosen chain)
  - [ ] Index USDC (or stablecoin) Transfer events into DAO wallet → `onchain_payments` table
  - [ ] Periodic reconciliation job compares `onchain_payments` vs `credit_ledger` (reason='widget_payment')
  - [ ] Auto-flag discrepancies for manual review
  - [ ] **Full spec:** See `docs/PAYMENTS_PONDER_VERIFICATION.md` for runtime topology, indexing config, and integration phases

**Option 3: Hybrid (DePay + Ponder)**

- [ ] Use both DePay tracking API and Ponder indexer for maximum confidence
- [ ] DePay validates payment at confirmation time
- [ ] Ponder reconciles periodically for fraud detection

**Recommendation:** Start with Ponder (0% fees, full control) before considering DePay managed mode (1.5% fees).

### 7.3 Implementation Notes for Future Hardening

**When upgrading to DePay Tracking API:**

- Update widget configuration to include `integration` ID
- Add DePay API key to server environment
- Implement webhook handler for DePay callbacks
- Verify payment signature before crediting

**When adding Ponder watcher:**

- See `docs/PAYMENTS_PONDER_VERIFICATION.md` for full integration guide
- Deploy Ponder as separate service alongside runtime stack
- Index DAO wallet inflows into `onchain_payments` table
- Run periodic reconciliation comparing ledger vs on-chain data

---

## 8. Integration with MVP Loop

### 8.1 Complete MVP Flow

**Status:** Sections 3-4 implement the payment integration. Sections 5-7 are future work.

Full loop with MVP pieces:

1. **Auth:** ✅ User connects wallet and logs in via SIWE → session cookie → `billing_account_id`
2. **Payments (this doc - Sections 3-4):** User uses DePay "Buy Credits":
   - [ ] DAO wallet address receives crypto
   - [ ] DePay widget fires `succeeded` callback
   - [ ] Frontend calls `/api/v1/payments/confirm` with `amountUsdCents` + `clientPaymentId`
   - [ ] Backend credits `billing_accounts.balance_credits` via `credit_ledger` insert
3. **Billing (Stage 6.5):** LLM usage with dual-cost accounting:
   - [ ] User calls `/api/v1/ai/completion`
   - [ ] LLM call via LiteLLM returns `response_cost_usd`
   - [ ] We convert to `provider_cost_credits`, compute `user_price_credits`
   - [ ] Enforce `user_price ≥ provider_cost`, and debit
   - [ ] `charge_receipts` + `credit_ledger` record the full cost trail

### 8.2 Success Criteria (MVP)

- [ ] User can purchase credits via DePay widget UI on testnet
- [ ] Credits appear in `credit_ledger` with `reason = 'widget_payment'` (or `'depay_payment'`)
- [ ] Balance increases correctly in `billing_accounts`
- [ ] Duplicate payments prevented via `clientPaymentId` idempotency
- [ ] Integer credit math: 1 cent = 10 credits, verifiable in ledger

---

## Key Design Decisions

**DePay OSS Mode (MVP):**

- Widget-only integration, no DePay backend, 0% fees
- Security model **identical to Resmic**: trust authenticated session + frontend signal
- Future hardening via DePay tracking API and/or Ponder watcher

**Credit Math (Integer Only):**

- 1 credit = $0.001
- 1 USDC = 1,000 credits
- 1 cent = 10 credits
- Formula: `credits = amountUsdCents * 10`

**Session-Based Security:**

- `billing_account_id` resolved from SIWE session only
- No `billingAccountId` in request body
- Prevents privilege escalation attacks

**Idempotency:**

- `clientPaymentId` is REQUIRED UUID
- Stored in `credit_ledger.reference`
- Query before insert prevents double-credits

**MVP vs Post-MVP:**

- Sections 3-4: Required for first working loop
- Sections 5-7: Future hardening, not blocking

DePay Widgets (OSS mode) is one concrete, zero-fee way to complete "credits UP" for the MVP — but it remains cleanly separated from the internal billing logic and can be replaced or supplemented later (DePay managed mode, direct on-chain watchers, other payment providers, etc.).

---

## 9. Migration from Resmic

**For developers transitioning from Resmic:**

1. **Package changes:**
   - Remove: `resmic` package (and ~4,500 transitive dependencies)
   - Add: `@depay/widgets` (much leaner, no blockchain SDKs bundled)

2. **Frontend changes:**
   - Replace Resmic `CryptoPayment` component with `DePayWidgets.Payment({ accept: [...] })`
   - Update callback: `setPaymentStatus(true)` → `succeeded: (payment) => { ... }`
   - Keep same confirm endpoint call with `amountUsdCents` + `clientPaymentId`

3. **Backend changes (minimal to none):**
   - Keep existing `/api/v1/payments/resmic/confirm` endpoint (works as-is)
   - Optionally rename to `/api/v1/payments/confirm` for clarity
   - Optionally update `reason` from `'resmic_payment'` to `'widget_payment'` or `'depay_payment'`
   - **No contract changes required** — same request/response schema

4. **Environment changes:**
   - Wallet/chain config now comes from `.cogni/repo-spec.yaml` (no DAO wallet env var)
   - Remove any Resmic-specific env vars if present

5. **Security model:**
   - **No change** — still trust authenticated session + frontend signal
   - Hardening options (DePay tracking API, Ponder) are post-MVP, same as before

---

## 10. Next Agent Handoff (MVP Completion Checklist)

- Wire `/credits` page to real data:
  - Fetch balance from billing account API; fetch recent `credit_ledger` entries; invalidate cache after confirm.
  - Connect "Purchase with DePay" CTA to DePay widget; on `succeeded`, call `POST /api/v1/payments/confirm` with `{ amountUsdCents, clientPaymentId, metadata }`.
- Finish backend contract/tests:
  - Ensure confirm route validates session, idempotency, and writes `credit_ledger` + balance.
  - Add integration test: happy path + duplicate confirm (idempotent).
- UI polish:
  - Replace mock transactions with live data, add loading/empty/error states.
  - Keep crypto-only messaging; omit auto top-up entirely.
- Documentation/testing:
  - Update any remaining docs/AGENTS if routes change; run `pnpm check` (or at least lint+type+tests) after wiring.
