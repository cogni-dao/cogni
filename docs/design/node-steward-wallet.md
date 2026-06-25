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

## Built in this PR (the seam)

- `packages/repo-spec`: `payments_out.steward_wallet` schema + `extractStewardWalletConfig`.
- `packages/operator-wallet`: `OperatorWalletPort.withdrawToSteward` + Privy adapter
  impl (pinned ERC-20 transfer) + `ERC20_TRANSFER_ABI`.
- `node-shared`: `payments.steward_withdrawal` event.
- operator container + `repoSpec.server`: wire optional `stewardAddress` from repo-spec.
- Fake operator wallet: `withdrawToSteward` test double.

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

## Next steps (→ /implement, separate PRs)

1. **Trigger surface**: `POST /api/v1/payments/steward-withdrawal` (RBAC: node-admin),
   amount-in-USD → `withdrawToSteward`, emit `payments.steward_withdrawal`. Surfaced via
   the Admin-tab "Provider Top-Ups" card (above), not a standalone page.
2. **Confirm unification + metrics**: a single `provider balances` read wrapping
   OpenRouter `/credits` + the existing Cherry `compute/balances` (+ steward wallet USDC),
   rendered in the Admin-tab card. Log `payments.topup_confirmed` with the delta.
3. **Retire the dead chain**: remove `fundOpenRouterTopUp`, `ProviderFundingPort`,
   `TransferIntent`, `openrouter-funding.adapter` (coordinate with the x402 branch's
   #1844 to avoid conflict).
4. **vNext**: x402 per-call to remove the human inch (the autonomous rung).

## Open reconciliation

- The deployed 0xSplits address in code (`0xd92E…f9C`) differs from a value cited in
  an earlier handoff (`0x4C4e…C294`). Confirm the live Split before activating.
