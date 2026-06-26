# Payments: USDC with Backend Verification

**MVP Chain:** Ethereum Sepolia (11155111) — **Production Chain:** Base mainnet (8453)

**Status:** Design phase - ready for implementation

**Purpose:** Production payment system with durable state machine, two-port architecture (PaymentAttemptRepository + OnChainVerifier). Real EVM RPC verification implemented via viem.

**Chain Policy:** Sepolia is test-only for development and temporary test fixtures. Production deployments MUST use Base mainnet. The `RepoSpecChainName` enum supports both chains during the transition period; Sepolia support will be removed once the DAO is fully deployed on Base.

---

## 1. Implementation Checklist

### Phase 1: Backend (MVP - Critical Path)

**Core Domain:**

- [x] Create `core/payments/model.ts` with PaymentAttempt entity
- [x] Create `core/payments/rules.ts` for state transition validation
- [x] Create `core/payments/errors.ts` with error types + error_code enum
- [x] Create `core/payments/util.ts` for conversion utilities
- [x] Create `core/payments/public.ts` barrel export

**Ports:**

- [x] Create `ports/payment-attempt.port.ts` with PaymentAttemptRepository interface
- [x] Create `ports/onchain-verifier.port.ts` with OnChainVerifier interface (no Ponder-specific types)
- [x] Export from `ports/index.ts`

**Database:**

- [x] Schema: Add `payment_attempts` table to `schema.billing.ts`
- [x] Schema: Add `payment_events` table to `schema.billing.ts`
- [x] Schema: Add partial unique index `payment_attempts_chain_tx_unique` on `(chain_id, tx_hash) WHERE tx_hash IS NOT NULL`
- [x] Schema: Add unique index `credit_ledger_payment_ref_unique` on `(reference) WHERE reason = 'widget_payment'`
- [x] Migration: Run `pnpm db:generate` to create migration file (0002_flimsy_microchip.sql)
- [x] Migration: Run `pnpm db:migrate` to apply migration

**Adapters:**

- [x] Create `adapters/server/payments/drizzle-payment-attempt.adapter.ts` (PaymentAttemptRepository)
- [x] Create `adapters/server/payments/evm-rpc-onchain-verifier.adapter.ts` (OnChainVerifier - real EVM RPC verification via viem)
- [x] Create `adapters/test/payments/fake-onchain-verifier.adapter.ts` (OnChainVerifier - deterministic fake for tests)
- [x] Export from `adapters/server/index.ts` and `adapters/test/index.ts`
- [x] Wire in `bootstrap/container.ts`: production uses EvmRpcOnChainVerifierAdapter, test uses FakeOnChainVerifierAdapter

**Feature Service:**

- [x] Create `features/payments/services/paymentService.ts`
- [x] `createIntent()` - captures from_address, validates bounds
- [x] `submitTxHash()` - checks expiration, sets expires_at = NULL, sets submitted_at = now(), verifies
- [x] `getStatus()` - checks PENDING_UNVERIFIED timeout (24h from submitted_at or N attempts), transitions to FAILED if exceeded
- [x] Ensure `confirmCreditsPayment()` owns CREDITED transition inside atomic transaction
- [x] Ensure payment_attempts remains PENDING_UNVERIFIED until credit transaction commits

**API Routes:**

- [x] Create `contracts/payments.intent.v1.contract.ts`
- [x] Create `contracts/payments.submit.v1.contract.ts`
- [x] Create `contracts/payments.status.v1.contract.ts`
- [x] Create `app/api/v1/payments/intents/route.ts`
- [x] Create `app/api/v1/payments/attempts/[id]/submit/route.ts`
- [x] Create `app/api/v1/payments/attempts/[id]/route.ts`

**Constants** (add to `src/shared/web3/chain.ts`):

- `MIN_PAYMENT_CENTS = 100`, `MAX_PAYMENT_CENTS = 1_000_000` (in core/payments/rules.ts)
- [x] `MIN_CONFIRMATIONS` - Defined in `src/shared/web3/chain.ts`
- `PAYMENT_INTENT_TTL_MS = 30 * 60 * 1000` (in core/payments/rules.ts)
- `PENDING_UNVERIFIED_TTL_MS = 24 * 60 * 60 * 1000` (in core/payments/rules.ts)
- [x] `VERIFY_THROTTLE_SECONDS = 10` (GET polling throttle)

**MVP Tests (9 critical scenarios):** ✅ COMPLETE

- [x] Sender mismatch → REJECTED with SENDER_MISMATCH
- [x] Wrong token/recipient/amount → REJECTED with appropriate code
- [x] Missing receipt → stays PENDING_UNVERIFIED (within 24h window)
- [x] PENDING_UNVERIFIED timeout → FAILED after 24h from submit with RECEIPT_NOT_FOUND
- [x] Insufficient confirmations → stays PENDING_UNVERIFIED then CREDITED when sufficient
- [x] Duplicate submit (same attempt+hash) → 200 idempotent
- [x] Same txHash different attempt → 409
- [x] Atomic settle: verify no CREDITED without ledger entry (DB assertion)
- [x] Ownership: not owned → 404

---

### Phase 2: Frontend (MVP - Required) ✅ COMPLETE

**Feature Hook:**

- [x] Create `features/payments/hooks/usePaymentFlow.ts`
  - Calls backend endpoints (intent, submit, status)
  - Uses wagmi `useWriteContract` + `useWaitForTransactionReceipt` for USDC transfer
  - Derives 3-state UI projection (READY/PENDING/DONE) from backend status
  - NO localStorage, polls backend for truth

**Kit Component:**

- [x] Create `components/kit/payments/UsdcPaymentFlow.tsx`
  - Presentational only: state prop + callbacks
  - 3 states: READY (show amount + button), PENDING (wallet + chain status), DONE (success/error)
  - NO business logic

**App Integration:**

- [x] Update `app/(app)/credits/CreditsPage.client.tsx`
  - Replace DePay widget with `UsdcPaymentFlow`
  - Use `usePaymentFlow` hook
  - Poll backend for status updates
  - Refresh balance on CREDITED

**DePay Removal:**

- [x] Delete `src/components/vendor/depay/` directory
- [x] Remove `@depay/widgets` from package.json
- [x] Remove DePay-specific code and imports

**Frontend Tests:**

- [ ] 3-state projection renders correctly from backend states
- [ ] Polling updates status in real-time
- [ ] Error messages display correctly

**Deferred Frontend Tests (Post-MVP):**

- Transaction replacement edge cases, multiple transfer logs UI handling, address case sensitivity UX

---

### Phase 3: EVM RPC Verification ✅ COMPLETE

**Objective:** Implement real on-chain verification using direct RPC queries via viem. No indexer dependency.

**Implementation:**

- [x] Create `adapters/server/payments/evm-rpc-onchain-verifier.adapter.ts` implementing OnChainVerifier port
- [x] Inject `EvmOnchainClient` dependency (see [ONCHAIN_READERS.md](ONCHAIN_READERS.md#shared-evm-infrastructure))
- [x] Read canonical config:
  - `chainId` from `getPaymentConfig().chainId` (sourced from `.cogni/repo-spec.yaml` `governance.chain_id`, validated against `CHAIN_ID` constant)
  - `receivingAddress` from `getPaymentConfig().receivingAddress` (sourced from `.cogni/repo-spec.yaml` `payments_in.credits_topup.receiving_address`)
  - `tokenAddress` from `USDC_TOKEN_ADDRESS` constant (`@/shared/web3/chain`)
- [x] Assert caller params match canonical config (immediate failure if mismatch)
- [x] Use `EvmOnchainClient` for all RPC operations: getTransaction, getTransactionReceipt, getBlockNumber
- [x] Decode ERC20 Transfer log, compute confirmations
- [x] Map failure conditions to PaymentErrorCode (see section 5)

**Wiring & Tests:**

- [x] Wire DI in `bootstrap/container.ts`:
  - `APP_ENV=test` → FakeOnChainVerifierAdapter (in-memory, no RPC)
  - `APP_ENV=production|preview|dev` → EvmRpcOnChainVerifierAdapter with ViemEvmOnchainClient
- [x] Wire EvmOnchainClient in DI:
  - `APP_ENV=test` → FakeEvmOnchainClient
  - `APP_ENV=production|preview|dev` → ViemEvmOnchainClient
- [ ] Add smoke test: run EvmRpcOnChainVerifierAdapter against known-good tx on Sepolia/Base testnet
- [x] Unit tests: use FakeEvmOnchainClient to simulate all verification branches (success, pending, each failure mode)

**Invariants:**

- FakeOnChainVerifierAdapter NEVER used in production/preview/dev
- Production verification ONLY runs on chain + receiving address from `getWidgetConfig()` (sourced from `.cogni/repo-spec.yaml`)
- Token address sourced from `USDC_TOKEN_ADDRESS` constant (chain-specific)
- EvmRpcOnChainVerifierAdapter MUST use EvmOnchainClient (never call viem/RPC directly)
- Unit tests MUST use FakeEvmOnchainClient (no RPC calls in unit tests)
- Payment service NEVER grants credits unless `status === 'VERIFIED'`

- [ ] Create `adapters/server/payments/evm-rpc-onchain-verifier.adapter.ts` implementing OnChainVerifier port
- [ ] Inject `EvmOnchainClient` dependency (see [ONCHAIN_READERS.md](ONCHAIN_READERS.md#shared-evm-infrastructure))
- [ ] Read canonical config:
  - `chainId` from `getWidgetConfig().chainId` (sourced from `.cogni/repo-spec.yaml` `governance.chain_id`, validated against `CHAIN_ID` constant)
  - `receivingAddress` from `getWidgetConfig().receivingAddress` (sourced from `.cogni/repo-spec.yaml` `payments_in.widget.receiving_address`)
  - `tokenAddress` from `USDC_TOKEN_ADDRESS` constant (`@/shared/web3/chain`)
- [ ] Assert caller params match canonical config (immediate failure if mismatch)
- [ ] Use `EvmOnchainClient` for all RPC operations: getTransaction, getTransactionReceipt, getBlockNumber
- [ ] Decode ERC20 Transfer log, compute confirmations
- [ ] Map failure conditions to PaymentErrorCode (see section 5)

**Wiring & Tests:**

- [ ] Wire DI in `bootstrap/container.ts`:
  - `APP_ENV=test` → FakeOnChainVerifierAdapter (in-memory, no RPC)
  - `APP_ENV=production|preview|dev` → EvmRpcOnChainVerifierAdapter with ViemEvmOnchainClient
- [ ] Wire EvmOnchainClient in DI:
  - `APP_ENV=test` → FakeEvmOnchainClient
  - `APP_ENV=production|preview|dev` → ViemEvmOnchainClient
- [ ] Add smoke test: run EvmRpcOnChainVerifierAdapter against known-good tx on Sepolia/Base testnet
- [ ] Unit tests: use FakeEvmOnchainClient to simulate all verification branches (success, pending, each failure mode)

**Invariants:**

### Phase 4: Operational Hardening (Post-MVP - Deferred)

- [ ] Clear stuck PENDING attempts after max verification TTL
- [ ] Monitoring and alerting for verification failures
- [ ] Audit log queries for dispute resolution
- [ ] Rate limiting on RPC calls to prevent cost spikes
- [ ] Fallback RPC endpoints for reliability

---

## 2. MVP Summary

**Objective:** Accept USDC payments with OnChainVerifier port abstraction. MVP: stub verification. Phase 3: direct RPC verification via viem.

**Scope:** Single chain (configured via repo-spec.yaml: Ethereum Sepolia 11155111 for testing, Base mainnet 8453 for production). Single token (USDC), single payment type (credit_topup). No multi-chain, refunds, partial fills, or subscriptions.

**Flow:** Client creates attempt → executes on-chain USDC transfer → submits txHash → backend calls OnChainVerifier (real EVM RPC verification via viem) → credits balance.

**Endpoints:**

- `POST /api/v1/payments/intents` - Create payment intent
- `POST /api/v1/payments/attempts/:id/submit` - Submit txHash for verification
- `GET /api/v1/payments/attempts/:id` - Poll status (with throttled verification)

**Internal States:** `CREATED_INTENT` → `PENDING_UNVERIFIED` → `CREDITED` (+ terminal: `REJECTED`, `FAILED`)

**Client-Visible States:** `PENDING_VERIFICATION` | `CONFIRMED` | `FAILED` (maps from internal states)

**Three Invariants:**

1. **Sender binding:** Receipt sender MUST match session wallet (enforced by OnChainVerifier in Phase 3)
2. **Receipt validation:** Token/recipient/amount MUST be verified via OnChainVerifier port (real EVM RPC verification via viem)
3. **Exactly-once credit:** DB constraints MUST prevent double-credit

---

## 2. Invariants (MUST)

### Security Invariants

- **MUST** capture `from_address` from SIWE session wallet at attempt creation (checksum via `getAddress()`)
- **MUST** call OnChainVerifier port before crediting (real EVM RPC verification via viem)
- **MUST** match token_address to canonical USDC on configured chain
- **MUST** require `amount >= expected_usdc_amount` (enforced by OnChainVerifier in Phase 3)
- **MUST** never trust client-supplied txHash for crediting - verification is backend-only

### Ownership Invariants

- **MUST** filter all queries by `billing_account_id === session.billing_account_id` (prevents privilege escalation)
- **MUST** return 404 if attempt not owned by session user

### Idempotency Invariants

- **MUST** apply credits exactly-once per payment reference (DB constraint enforced)
- **MUST NOT** allow same txHash to credit twice (partial unique index on attempts + unique constraint on ledger)
- **MUST** keep attempt PENDING_UNVERIFIED until atomic credit transaction commits
- Settlement **MUST** be atomic across: credit_ledger insert, billing_accounts update, payment_attempts CREDITED transition

### TTL Invariants

- **MUST** enforce `expires_at` ONLY in `CREATED_INTENT` state (30 min TTL)
- **MUST** set `expires_at = NULL` on txHash submission
- **MUST** terminate stuck PENDING_UNVERIFIED attempts after excessive verification attempts (prevents zombie attempts + infinite polling costs)
  - If receipt not found after 24 hours from submission (or N verification attempts) → transition to FAILED with error_code `RECEIPT_NOT_FOUND`
  - Track via `submitted_at` timestamp and verification attempt count
  - Legitimate on-chain txs confirm within minutes; 24h timeout catches wrong-chain/invalid submissions

---

## 3. State Machine

### Canonical States

- `CREATED_INTENT` - Intent created, awaiting on-chain transfer
- `PENDING_UNVERIFIED` - TxHash submitted, verification in progress
- `CREDITED` - Credits applied (terminal success)
- `REJECTED` - Verification failed (terminal)
- `FAILED` - Transaction reverted or intent expired (terminal)

### Allowed Transitions

```
CREATED_INTENT -> PENDING_UNVERIFIED (on submit)
CREATED_INTENT -> FAILED (on intent expiration)
PENDING_UNVERIFIED -> CREDITED (on successful verification)
PENDING_UNVERIFIED -> REJECTED (on validation failure)
PENDING_UNVERIFIED -> FAILED (on tx revert OR receipt not found after 24h)
```

### State Transition Ownership

- `confirmCreditsPayment()` (or equivalent) **MUST** be the single owner of the CREDITED transition
- Attempt **MUST NOT** become CREDITED unless ledger+balance update commits

---

## 4. API Contracts

### POST /api/v1/payments/intents

**Purpose:** Create intent, return on-chain params

**Request:** `{ amountUsdCents: number }`

**Validation:**

- **MUST** reject if `amountUsdCents < 100` or `> 1_000_000` (400 error)

**Response:**

```json
{
  "attemptId": "uuid",
  "chainId": 11155111,
  "token": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "to": "0x070...",
  "amountRaw": "string",
  "amountUsdCents": 500,
  "expiresAt": "ISO8601"
}
```

**Backend MUST:**

- Resolve `billing_account_id` from session
- Capture `from_address = getAddress(sessionWallet)` (checksummed)
- Calculate `amountRaw = BigInt(amountUsdCents) * 10_000n` (never use floats)
- Set `expires_at = now() + 30min`
- Get DAO wallet from `getWidgetConfig().receivingAddress`

---

### POST /api/v1/payments/attempts/:id/submit

**Purpose:** Submit txHash, verify, settle if valid

**Request:** `{ txHash: string }`

**Response:**

```json
{
  "attemptId": "uuid",
  "status": "PENDING_UNVERIFIED|CREDITED|REJECTED|FAILED",
  "txHash": "0x...",
  "errorCode": "SENDER_MISMATCH|...",
  "errorMessage": "string"
}
```

**Backend MUST:**

- Enforce ownership: `attempt.billing_account_id === session.billing_account_id`
- Check expiration: if `status === 'CREATED_INTENT' AND expires_at < now()` → transition to FAILED, return
- Bind txHash (idempotent: if already bound to this hash, continue)
- **Set `expires_at = NULL`** (submitted attempts do not use intent TTL)
- **Set `submitted_at = now()`** (for PENDING_UNVERIFIED timeout tracking)
- Transition to PENDING_UNVERIFIED
- Attempt verification (see Verification Rules section)

**Idempotency:**

- Same txHash + same attemptId: return existing status (200)
- Same txHash + different attemptId: reject (409 conflict)

---

### GET /api/v1/payments/attempts/:id

**Purpose:** Poll status (with throttled verification)

**Response:**

```json
{
  "attemptId": "uuid",
  "status": "string",
  "txHash": "0x...",
  "amountUsdCents": 500,
  "errorCode": "string",
  "createdAt": "ISO8601"
}
```

**Backend MUST:**

- Enforce ownership
- Check expiration (CREATED_INTENT only)
- **Check PENDING_UNVERIFIED timeout:** If `status === 'PENDING_UNVERIFIED' AND (now() - submitted_at > 24h OR verify_attempt_count > N)`:
  - Transition to FAILED with error_code `RECEIPT_NOT_FOUND`
- **Throttle verification:** If `status === 'PENDING_UNVERIFIED'` and not timed out:
  - If `last_verify_attempt_at IS NULL` OR `now() - last_verify_attempt_at >= 10 seconds`:
    - Update `last_verify_attempt_at = now()`
    - Increment `verify_attempt_count`
    - Attempt verification
  - Else: skip (reduce RPC cost)
- Return current status

---

## 5. OnChainVerifier Port

**Interface:** `verify(chainId, txHash, expectedTo, expectedToken, expectedAmount) → { status, actualFrom, actualTo, actualAmount, errorCode }`

**Status values:** `VERIFIED` | `PENDING` | `FAILED`

**Production (EvmRpcOnChainVerifierAdapter):** Direct RPC verification with canonical config validation:

1. **Validate caller params against canonical config:**
   - Read: `chainId` from `getPaymentConfig().chainId`, `receivingAddress` from `getPaymentConfig().receivingAddress`, `tokenAddress` from `USDC_TOKEN_ADDRESS`
   - If `chainId !== config.chainId` → return `FAILED` (error_code: `INVALID_CHAIN`)
   - If `expectedTo !== config.receivingAddress` → return `FAILED` (error_code: `INVALID_RECIPIENT`)
   - If `expectedToken !== config.tokenAddress` → return `FAILED` (error_code: `INVALID_TOKEN`)

2. **Query chain via EvmOnchainClient:** (see [On-Chain Infrastructure](ONCHAIN_READERS.md#shared-evm-infrastructure))
   - Fetch transaction and receipt, decode ERC20 Transfer log, compute confirmations
   - Return `PENDING` if confirmations < MIN_CONFIRMATIONS (5)
   - Return `FAILED` with specific error code for: TX_NOT_FOUND, TX_REVERTED, TOKEN_TRANSFER_NOT_FOUND, SENDER_MISMATCH, RECIPIENT_MISMATCH, AMOUNT_MISMATCH

3. **Return VERIFIED:** All validations passed
   - Return `{ status: VERIFIED, actualFrom, actualTo, actualAmount }`

**Atomic settlement:** Implemented exclusively inside `confirmCreditsPayment()` which performs ledger insert + balance update + attempt CREDITED transition in one DB transaction. Pass composite reference: `clientPaymentId = "${chainId}:${txHash}"` for chain-aware idempotency. Log event to `payment_events` after successful credit.

**PENDING_UNVERIFIED timeout:** Prevents zombie attempts. After 24h from submit (or N verification attempts), transition to FAILED with error_code `RECEIPT_NOT_FOUND`.

---

## 6. Persistence & Idempotency

### payment_attempts Table

**Location:** `src/shared/db/schema.billing.ts`

**Key Columns:**

- `id` (UUID, PK, default gen_random_uuid()) - attemptId
- `billing_account_id` (TEXT, NOT NULL, FK → billing_accounts) - owner
- `from_address` (TEXT, NOT NULL) - SIWE wallet checksummed via `getAddress()`
- `chain_id` (INTEGER) - Ethereum Sepolia (11155111) for MVP, Base mainnet (8453) in Phase 3
- `tx_hash` (TEXT, nullable) - bound on submit
- `token` (TEXT), `to_address` (TEXT), `amount_raw` (BIGINT), `amount_usd_cents` (INTEGER)
- `status` (TEXT) - state enum
- `error_code` (TEXT, nullable) - stable error enum
- `expires_at` (TIMESTAMP, nullable) - NULL after submit (only for CREATED_INTENT)
- `submitted_at` (TIMESTAMP, nullable) - set when txHash bound (for PENDING_UNVERIFIED timeout)
- `last_verify_attempt_at` (TIMESTAMP, nullable) - for GET throttle
- `verify_attempt_count` (INTEGER, NOT NULL, default 0) - incremented on each verification attempt
- `created_at` (TIMESTAMP, NOT NULL, default now())

**Required Indexes:**

- `payment_attempts_chain_tx_unique` - Partial unique: `(chain_id, tx_hash) WHERE tx_hash IS NOT NULL`
- `payment_attempts_billing_account_idx` - `(billing_account_id, created_at)` for user history
- `payment_attempts_status_idx` - `(status, created_at)` for polling

---

### payment_events Table (Mandatory)

**Purpose:** Append-only audit log (critical for Ponder reconciliation + disputes)

**Schema:**

- `id` (UUID, PK, default gen_random_uuid())
- `attempt_id` (UUID, NOT NULL, FK → payment_attempts)
- `event_type` (TEXT, NOT NULL) - Operation verbs: `INTENT_CREATED`, `TX_SUBMITTED`, `VERIFICATION_ATTEMPTED`, `STATUS_CHANGED`
- `from_status` (TEXT, nullable) - Previous PaymentAttemptStatus (null for INTENT_CREATED)
- `to_status` (TEXT, NOT NULL) - New PaymentAttemptStatus
- `error_code` (TEXT, nullable) - PaymentErrorCode for failure events
- `metadata` (JSONB, nullable) - txHash, blockNumber, validation details
- `created_at` (TIMESTAMP, NOT NULL, default now())

**Event semantics:** event_type describes the operation (verb); from_status/to_status hold the actual states.

**Index:**

- `payment_events_attempt_idx` - `(attempt_id, created_at)` for audit log queries

---

### credit_ledger Unique Constraint

**MUST enforce exactly-once credit at DB level with chain awareness:**

```sql
CREATE UNIQUE INDEX credit_ledger_payment_ref_unique
ON credit_ledger(reference)
WHERE reason = 'widget_payment';
```

**Reference format:** `"${chainId}:${txHash}"` (e.g., `"11155111:0xabc123..."`)

**Implementation:** Feature service passes composite reference to `confirmCreditsPayment()` for idempotency.

---

### Exactly-Once Summary

**Three layers:**

1. **Partial unique index** on `payment_attempts(chain_id, tx_hash)` - prevents same txHash across attempts
2. **Unique constraint** on `credit_ledger(reference)` for payments - DB-level exactly-once with composite reference
3. **FOR UPDATE lock** in settlement transaction - prevents race conditions

**Chain awareness in ledger:** Reference MUST include chain context to prevent collisions. Use composite reference `"${chainId}:${txHash}"`.

---

## 7. Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - Hexagonal architecture boundaries
- [BILLING_EVOLUTION.md](BILLING_EVOLUTION.md) - Credit accounting
- [ONCHAIN_READERS.md](ONCHAIN_READERS.md) - On-chain data intelligence (treasury, ownership)

**Key Config:**

- `.cogni/repo-spec.yaml` - Governance-managed configuration:
  - `governance.chain_id` - Chain ID as string (e.g., "11155111" for Ethereum Sepolia, "8453" for Base mainnet)
  - `payments_in.credits_topup.receiving_address` - DAO wallet receiving address
  - `payments_in.credits_topup.allowed_chains` - Chain names (e.g., ["Sepolia"])
  - `payments_in.credits_topup.allowed_tokens` - Token names (e.g., ["USDC"])
  - `payments_in.credits_topup.provider` - Payment provider identifier
- `src/shared/config/repoSpec.server.ts` - Server-side reader: `getPaymentConfig()` returns `{ chainId, receivingAddress, provider }`
- `src/shared/web3/chain.ts` - Hardcoded constants:
  - `CHAIN_ID` - Must match `governance.chain_id` from repo-spec
  - `USDC_TOKEN_ADDRESS` - Token contract address for configured chain
  - `MIN_CONFIRMATIONS`, `VERIFY_THROTTLE_SECONDS` - Payment constants

**Existing Credit Logic:**

- `src/features/payments/services/creditsConfirm.ts` - `confirmCreditsPayment()` handles virtualKeyId, balanceAfter, atomic updates
- Reuse this for settlement, ensure it owns CREDITED transition
- Pass composite reference: `clientPaymentId = "${chainId}:${txHash}"` for chain-aware idempotency

**Unit Conversions:**

- `amount_raw` = USDC raw units (6 decimals, 1 USDC = 1,000,000 raw)
- `amount_usd_cents` = USD cents (1 USD = 100 cents)
- `credits` = internal accounting (1 cent = 10 credits per `CREDITS_PER_CENT` constant)
- Conversion: 1 USDC = 100 cents = 1,000 credits

**Error Codes:**
`TX_NOT_FOUND`, `TX_REVERTED`, `TOKEN_TRANSFER_NOT_FOUND`, `SENDER_MISMATCH`, `RECIPIENT_MISMATCH`, `AMOUNT_MISMATCH`, `INSUFFICIENT_CONFIRMATIONS`, `RECEIPT_NOT_FOUND`, `INTENT_EXPIRED`, `RPC_ERROR`
