<!--
TRANSITIONAL DESIGN DOC — destined for operator Dolt knowledge, not permanent .md.
On merge, fold the runbook sections into a hub guide `manual-provider-topup`
(domain: infrastructure) and the architecture/decision into `operator-wallet`
spec context. Do NOT let this become doc sprawl. See AGENTS.md § knowledge.
-->

# Node Steward Wallet — manual provider top-up for an all-on-chain DAO

## Outcome

Success is when a node can pay its core Web2-but-crypto-accepting vendors
(OpenRouter for inference, Cherry for compute) **entirely in USDC, with no card
and no bank** — by funding one human-custodied wallet from the operator wallet via
a single constrained transfer, then completing each vendor's hosted crypto
checkout by hand, and confirming the credit landed via the vendor's balance API.

## The problem

Inbound works and is proven on-chain: user USDC → 0xSplits (95/5) → operator Privy
wallet + DAO treasury. **Outbound was a black hole.** The only programmatic vendor
funding we had — `fundOpenRouterTopUp` via OpenRouter's Coinbase Commerce charge API
(`POST /api/v1/credits/coinbase`) — is dead: OpenRouter removed it (returns `410 Gone`)
because Coinbase deprecated the underlying Commerce APIs. So the operator wallet
accumulated USDC with no defined path to fund the services the node depends on.

**Key correction to earlier assumptions:** the vendors are NOT card-only. Both accept
USDC crypto checkout _today_:

| Vendor         | Crypto checkout             | Chain / token                                    | Shape                                                                                                                                                                        |
| -------------- | --------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenRouter** | Coinbase Business Checkouts | USDC on **Base**                                 | wallet-connect (per-session operator-signed `TransferIntent`) — a plain transfer to a fixed address will NOT credit                                                          |
| **Cherry**     | Coingate (also BVNK)        | USDC on **Base** (Coingate supports many chains) | hosted per-invoice **deposit address** — "send 57.9 USDC to `0x…` on Base" + QR, fiat-pegged with a ~20-min expiry; a plain transfer to that per-invoice address DOES credit |

So the "100% no cards" constraint is **achievable now** for both core services. The
only irreducible gap is the last human inch: neither checkout can be driven by a
headless Privy server wallet (Coinbase = wallet-connect peer we can't be; Coingate =
per-invoice address that isn't knowable ahead of time and isn't in any allowlist).

## Decision (do not re-litigate)

- **Keep OpenRouter** as the inference backend. No model-backend churn.
- **Manual provider top-up** is the rung we build now: operator wallet → steward
  wallet → human completes vendor checkout → confirm via balance API.
- **x402 per-call** (USDC-on-Base, the rail OpenRouter actually sanctions for
  "headless on-chain payments") is the _future autonomous rung_ — it removes the
  human inch. `signX402Payment` already exists on the x402 foundation branch. Parked,
  documented, not built here.

## The standardized pattern

```
DAO treasury (Aragon, 0xF61c…)   ← 5% of inbound. Untouched. Governance-controlled.
operator Privy wallet (0xdCCa…)  ← 95% of inbound = working capital. Programmatic, constrained.
   │  [TRIGGER]  withdrawToSteward(amountUsdcAtomic)
   │             • dest PINNED to repo-spec payments_out.steward_wallet (caller picks amount only)
   │             • per-tx USD cap (OPERATOR_MAX_TOPUP_USD); fails closed if unconfigured
   │             • emits payments.steward_withdrawal {txHash, amount}
   ▼
steward wallet (human EOA / hardware) ← declared in repo-spec, per node. The trust boundary
   │  [HUMAN]    complete the vendor's hosted USDC checkout (the only manual step)
   │             • OpenRouter: credits page → Pay with crypto → connect steward wallet → pay (Base USDC)
   │             • Cherry:     top-up → Coingate → send shown USDC amount to the Base address (within the timer)
   ▼
OpenRouter credits  /  Cherry team balance
   │  [CONFIRM]  poll the vendor balance API, assert the delta, log it
   │             • OpenRouter: GET https://openrouter.ai/api/v1/credits → {total_credits,total_usage}
   │             • Cherry:     GET /api/v1/compute/balances (already shipped: CherryComputeAdapter → /v1/teams)
```

### Why "steward", not "operator"/"ops"

`operator` is already the CICD-manager node, and it owns the `operator wallet`
(the Privy wallet 0xSplits pays into). Reusing either term for the _human_ payout
wallet would overload load-bearing names. **Steward** is node-generic (every node can
declare one), implies a trusted human custodian, and has zero code/config collisions.

### Why repo-spec config, not a Gnosis Safe (yet)

The steward wallet is a thin **pass-through** holding small working balances, not a
treasury. A Safe multisig is the right primitive for the _treasury tier_ — and the DAO
already has Aragon there. Putting a multisig on a relay wallet at 1-operator / MVP
stage is ceremony with no security payoff. Declaring `payments_out.steward_wallet` in
repo-spec makes it git-tracked + governance-visible, exactly like `payments_in` pins
the Split. Swapping it for a Safe address later is a non-breaking change. Add a Safe
when there's a second human signer or the balance warrants it — not before.

## Invariants

- `NO_GENERIC_SIGNING` — `withdrawToSteward` encodes a fixed `transfer(stewardAddress, amount)`
  to a **config-pinned** recipient. The caller controls only the amount, never the
  destination. No raw calldata/sign surface is added. (spec: operator-wallet)
- `FAIL_CLOSED` — `withdrawToSteward` throws `STEWARD_NOT_CONFIGURED` when
  `payments_out` is absent; inbound credits + Split distribute are unaffected.
- `SPEND_CAP` — bounded by the existing `OPERATOR_MAX_TOPUP_USD` per-tx cap.
- `CREDITS_WITHOUT_REALTIME_SETTLEMENT` — inbound crediting must NOT fail-closed
  just because outbound auto-top-up is gone; outbound is now a separate, deferred
  human step.

## Built in this PR (the seam + trigger)

- `packages/repo-spec`: `payments_out.steward_wallet` schema + `extractStewardWalletConfig`.
- `packages/operator-wallet`: `OperatorWalletPort.withdrawToSteward` + Privy adapter
  impl (pinned ERC-20 transfer) + `ERC20_TRANSFER_ABI`.
- `node-shared`: `payments.steward_withdrawal` event.
- operator container + `repoSpec.server`: wire optional `stewardAddress` from repo-spec.
- Fake operator wallet: `withdrawToSteward` test double.
- **Trigger route**: `POST /api/v1/payments/steward-withdrawal` — session-gated +
  `STEWARD_SELF_AUTHORIZED` (caller wallet must equal the configured steward wallet,
  which at MVP is the governance approver/admin wallet). `{amountUsd}` → fixed USDC
  transfer to the pinned steward address; emits `payments.steward_withdrawal`;
  fails closed (503) when the operator/steward wallet is unconfigured.

## UI home: the node Admin tab

The trigger UI and top-up metrics live in the node **Admin** tab — the existing
approver/node-admin–gated surface (the "DAO Admin / Approver-gated surfaces" page,
alongside Epoch Review & Sign, Holdings, Governance System). Its own footer already
promises this: _"Services, budgets, and member management will surface here as those
capabilities ship."_ Provider top-ups are exactly such a service/budget capability, so
they belong there rather than in a bespoke page — reuse the Admin tab's RBAC gate and
card layout. Add a **"Provider Top-Ups"** card that:

- shows current provider balances (OpenRouter credits, Cherry team balance) + the
  steward wallet's USDC balance — the "watch" surface;
- initiates a steward withdrawal (amount-in-USD → `withdrawToSteward`) behind the same
  approver/node-admin gate;
- lists recent `payments.steward_withdrawal` / `payments.topup_confirmed` events.

## Admin tab (operator was behind — synced)

The DAO Admin tab is a node-template `(admin)/` route group that the **operator app did
not have** (operator only had `(app)`/`(infra)`/`(public)`). This PR ports it to operator:
`(admin)/{layout,AdminShell,admin/page}.tsx` + an "Admin" sidebar entry, and adds the
**Provider Top-Ups** surface (`/admin/payments`) with a real `StewardTopUpCard` button →
`POST /steward-withdrawal`. No more devtools.

Gate: node-template's `(admin)` uses `isLedgerApprover` (repo-spec `activity_ledger.approvers`).
Operator's runtime repo-spec (`nodes/operator/.cogni`) has no `activity_ledger`, and adding
one would synthesize a LEDGER_INGEST schedule as a side effect. So operator gates on
**`isDaoAdmin` = ledger approver OR steward wallet** (`payments_out.steward_wallet`) — works
without touching attribution config. At MVP steward == approver == admin (one wallet).

## Next steps (separate PRs)

1. **node-template parity**: port the Provider Top-Ups card into node-template's existing
   `(admin)` tab so all forks get it (its `(admin)` already exists).
2. **Confirm unification + metrics**: a single `provider balances` read wrapping
   OpenRouter `/credits` + the existing Cherry `compute/balances` (+ steward wallet USDC).
   Log `payments.topup_confirmed` with the delta.
3. **Retire the dead chain**: remove `fundOpenRouterTopUp`, `ProviderFundingPort`,
   `TransferIntent`, `openrouter-funding.adapter` (coordinate with the x402 branch's
   #1844 to avoid conflict).
4. **vNext**: x402 per-call to remove the human inch (the autonomous rung).

## Proof / validation plan (e2e CICD — flight + validate BEFORE merge)

Per `cicd-e2e-required-sequence`: flight → validate-candidate → human checkpoint →
merge → promote. **No merge until proven.** What's provable where:

- **Candidate-a** (`POST /steward-withdrawal`): auth gate (403 for non-steward), schema
  (400), and fail-closed (`503 OPERATOR_WALLET_UNCONFIGURED`) if candidate lacks Privy.
  If candidate has the operator wallet wired + funded (test = real Base $), a real small
  `withdrawToSteward` proves the on-chain transfer + `payments.steward_withdrawal` Loki event.
- **Outbound real-money caveat** (payments-expert): if candidate lacks Privy/funding, the
  real transfer is provable only on a wired env — the small real top-up then runs on prod
  after promote (operator wallet → steward wallet, our own admin wallet → low risk).

## Works for ALL nodes (propagation)

The steward wallet is a **per-node** capability, not operator-only:

- The capability lives in **shared packages** (`repo-spec` schema, `operator-wallet`
  port/adapter, `node-shared` event). These are the source every node inherits — so
  the seam is node-generic by construction. node-template + forks pick it up via
  `node-sync-prs` after this merges.
- The **app surfaces** (container wiring, `POST /steward-withdrawal` route, Admin-tab
  "Provider Top-Ups" card) are per-app. This PR wires the **operator** app (operator is
  itself a node). The same surfaces must be added to **node-template's app** so every
  fork gets them — node-template is the fork base, and its DAO Admin tab is where the
  card lands. The shared capability MUST originate here in `cogni-template/packages`
  (node-template consumes these); you cannot author the seam "in node-template" first.
- Each node sets its own `payments_out.steward_wallet` in its repo-spec. MVP: reuse the
  governance approver/admin wallet (operator uses `0x070075F1…0c949`).

## Activation state

- `payments_out.steward_wallet` is set in the operator repo-spec (root + `nodes/operator`)
  to the governance approver wallet `0x070075F1389Ae1182aBac722B36CA12285d0c949`.
- Live operator inbound Split = `0x4C4e…C294` (repo-spec `receiving_address`, splitHash
  `0xe620…2943`). The `0xd92E…f9C` seen earlier was only a unit-test fixture, not the
  deployed Split — no discrepancy.
