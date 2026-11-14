# Spike 0090: Operator Wallet Payment Chain Experiments

> Validates the full payment chain on Base mainnet before building abstractions.
> **Budget: ~$3 total** (Base gas < $0.001/tx).

## Prerequisites

- Test wallet with ~$2 USDC + trace ETH on Base mainnet
- Second wallet address for treasury test recipient
- OpenRouter API key with credit purchase permissions

## Setup

```bash
cp scripts/experiments/.env.example scripts/experiments/.env
# Fill in your values
```

## Run

Scripts are independent but designed to run in order:

```bash
# Experiment 1: OpenRouter crypto top-up
# Resolves: ETH vs USDC input, contract address, minimum amount
pnpm tsx scripts/experiments/openrouter-topup.ts

# Experiment 2: 0xSplits deploy + USDC distribution
# Resolves: Splits works with Base USDC, gas costs
pnpm tsx scripts/experiments/splits-deploy.ts
# ↑ Outputs SPLIT_ADDRESS — add to .env for experiment 3

# Experiment 3: Full chain end-to-end
# Resolves: USDC → Split → wallet → OpenRouter credits
pnpm tsx scripts/experiments/full-chain.ts
```

## Key Unknowns Resolved

| Unknown                                                  | Resolved by  |
| -------------------------------------------------------- | ------------ |
| Which Coinbase Commerce function does OpenRouter return? | Experiment 1 |
| Does `metadata.contract_address` match `0xeADE6...`?     | Experiment 1 |
| Does 0xSplits `distribute()` work with Base USDC?        | Experiment 2 |
| Can the full chain complete in < 2 minutes?              | Experiment 3 |

## Post-Spike

After running all 3 experiments, update:

- `work/items/spike.0090.validate-operator-wallet-payment-chain.md` — mark complete
- `work/items/task.0084.operator-wallet-generation-wiring.md` — unblock with findings

## Links

- [Spike: spike.0090](../../work/items/spike.0090.validate-operator-wallet-payment-chain.md)
