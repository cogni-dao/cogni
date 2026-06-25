# operator-wallet · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Standalone workspace package (`@cogni/operator-wallet`) providing Privy-managed operator wallet custody — submits typed intents to Privy HSM for on-chain signing. No raw key material in the app process.

## Pointers

- [Operator Wallet Spec](../../docs/spec/operator-wallet.md) — lifecycle, custody, access control
- [Web3 OpenRouter Payments Spec](../../docs/spec/web3-openrouter-payments.md) — top-up economics and flow
- [Spike: full-chain.ts](../../scripts/experiments/full-chain.ts) — proof-of-concept for approve + transfer

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

**External deps:** `viem` (ABI encoding, address utils), `@privy-io/node` (HSM wallet SDK), `@0xsplits/splits-sdk` (Split ABI).

## Public Surface

- **Exports:** `OperatorWalletPort`, `X402PaymentParams`, `PrivyOperatorWalletAdapter`, `PrivyOperatorWalletConfig`, `calculateSplitAllocations`, `SPLIT_TOTAL_ALLOCATION`, `OPENROUTER_CRYPTO_FEE_PPM`, `buildX402TypedData` + x402 EIP-3009 domain constants (`buildX402Domain`, `X402_EIP712_TYPES`, `USDC_ADDRESS`, `BASE_CHAIN_ID`, …)
- **Routes:** none
- **Env/Config keys:** `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_SIGNING_KEY`, `OPERATOR_MAX_TOPUP_USD` (consumed by `apps/operator` bootstrap, not by this package directly)

## Ports

- **Uses ports:** none (this package _is_ the adapter)
- **Implements ports:** `OperatorWalletPort`

## Responsibilities

- This directory **does**: implement `distributeSplit()` (Split distribute via Privy HSM on Base) and `signX402Payment()` (EIP-3009 `TransferWithAuthorization` signature for x402 AI-egress settlement — signs only, the facilitator broadcasts).
- This directory **does not**: hold raw key material, manage env vars, orchestrate charge creation, persist state, interact with databases, or expose a generic `signTypedData`/`signMessage` surface (NO_GENERIC_SIGNING — every signing method is named for its use-case). Polymarket CLOB order signing does NOT live here — it flows through `@privy-io/node/viem#createViemAccount` directly in the trader-role runtime (task.0315 CP2).

## Notes

- `signX402Payment` enforces one gate (`from === operator address`) then delegates to Privy `eth_signTypedData_v4`. The EIP-712 domain/struct is built by `src/domain/x402-eip3009.ts` (pure, deterministic, unit-tested). The dead OpenRouter/Coinbase top-up path (`fundOpenRouterTopUp` + Transfers ABI) was retired — OpenRouter 410'd programmatic crypto top-up; Cogni now pays per-request in USDC over x402.
- Polymarket CLOB order signing does **not** live on this port. `@privy-io/node/viem#createViemAccount` returns a viem `LocalAccount` that `@polymarket/clob-client` consumes natively — the CP1 `signPolymarketOrder` port method + stub were deleted in CP3.1.5 as dead surface. Existing Base methods remain pinned to `BASE_CAIP2`; no chain parameterization needed today.
- CP2 evidence: `scripts/experiments/sign-polymarket-order.ts` — proves the Privy-HSM → clob-client signing seam on Polygon (chainId 137) with zero hand-rolled translation, zero shim, zero on-chain activity. `@polymarket/clob-client` is a root devDependency (only the experiment script consumes it); it moves to `packages/market-provider` as an optional peerDep in CP3.2.
- SIMULATE_BEFORE_BROADCAST deferred to Privy infrastructure (SDK has no pre-sign simulation hook).
- USDC EIP-712 domain pins `name="USD Coin"`, `version="2"`, chainId 8453, verifyingContract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base FiatTokenV2_2). The x402 client shim + litellm wiring (which calls `signX402Payment`) land in a later PR once a Hyperbolic key + backend are chosen.
