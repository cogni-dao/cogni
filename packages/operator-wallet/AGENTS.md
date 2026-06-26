# operator-wallet · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Standalone workspace package (`@cogni/operator-wallet`) providing Privy-managed operator wallet custody — submits typed intents to Privy HSM for on-chain signing. No raw key material in the app process.

## Pointers

- [Operator Wallet Spec](../../docs/spec/operator-wallet.md) — lifecycle, custody, access control

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

- **Exports:** `OperatorWalletPort`, `PrivyOperatorWalletAdapter`, `PrivyOperatorWalletConfig`, `calculateSplitAllocations`, `SPLIT_TOTAL_ALLOCATION`, `OPENROUTER_CRYPTO_FEE_PPM`
- **Routes:** none
- **Env/Config keys:** `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_SIGNING_KEY`, `OPERATOR_MAX_TOPUP_USD` (consumed by `apps/operator` bootstrap, not by this package directly)

## Ports

- **Uses ports:** none (this package _is_ the adapter)
- **Implements ports:** `OperatorWalletPort`

## Responsibilities

- This directory **does**: implement `distributeSplit()` (Split distribute via Privy HSM on Base) and `withdrawToSteward()` (a fixed ERC-20 `transfer` to the config-pinned steward wallet); validate signing gates (STEWARD_CONFIGURED, POSITIVE_AMOUNT, MAX_TOPUP_CAP).
- This directory **does not**: hold raw key material, manage env vars, orchestrate charge creation, persist state, interact with databases, or expose a generic `signTypedData`/`signMessage` surface (NO_GENERIC_SIGNING — every signing method is named for its use-case). Polymarket CLOB order signing does NOT live here — it flows through `@privy-io/node/viem#createViemAccount` directly in the trader-role runtime (task.0315 CP2).

## Notes

- `withdrawToSteward` funds the human-custodied steward wallet (recipient pinned to repo-spec `payments_out.steward_wallet`); a human then settles vendor invoices via each vendor's hosted crypto checkout. The dead OpenRouter/Coinbase top-up path (`fundOpenRouterTopUp` + Transfers ABI) was retired — OpenRouter 410'd programmatic crypto top-up.
- Polymarket CLOB order signing does **not** live on this port. `@privy-io/node/viem#createViemAccount` returns a viem `LocalAccount` that `@polymarket/clob-client` consumes natively — the CP1 `signPolymarketOrder` port method + stub were deleted in CP3.1.5 as dead surface. Existing Base methods remain pinned to `BASE_CAIP2`; no chain parameterization needed today.
- CP2 evidence: `scripts/experiments/sign-polymarket-order.ts` — proves the Privy-HSM → clob-client signing seam on Polygon (chainId 137) with zero hand-rolled translation, zero shim, zero on-chain activity. `@polymarket/clob-client` is a root devDependency (only the experiment script consumes it); it moves to `packages/market-provider` as an optional peerDep in CP3.2.
- SIMULATE_BEFORE_BROADCAST deferred to Privy infrastructure (SDK has no pre-sign simulation hook).
