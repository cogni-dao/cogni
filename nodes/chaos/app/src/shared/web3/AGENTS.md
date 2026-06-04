# web3 · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Shared blockchain configuration for web3 integrations. Provides Base mainnet chain constants, EVM RPC client interface, and Node Formation primitives (ABIs, bytecode, OSx addresses).

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Chain Configuration](../../../../../docs/spec/chain-config.md)
- [Repo Spec](../../../../../.cogni/repo-spec.yaml)

## Boundaries

```json
{
  "layer": "shared",
  "may_import": ["shared"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters/server",
    "adapters/worker",
    "adapters/cli",
    "mcp"
  ]
}
```

## Public Surface

- **Exports:**
  - `CHAIN` - wagmi Chain object for Base mainnet
  - `CHAIN_ID` - Chain ID constant
  - `getChainId()` - Function returning chain ID
  - `USDC_TOKEN_ADDRESS` - USDC contract address
  - `MIN_CONFIRMATIONS` - Payment verification confirmations
  - `VERIFY_THROTTLE_SECONDS` - Verification polling throttle
  - `ERC20_ABI` - Generic ERC20 ABI
  - `EvmOnchainClient` - Infrastructure interface for EVM RPC operations
  - `getAddressExplorerUrl()`, `getTransactionExplorerUrl()` - Block explorer URLs
  - `node-formation/*` - Node Formation ABIs, bytecode, OSx addresses (see node-formation/AGENTS.md)
- **Env/Config keys:** none (chain hardcoded)
- **Files considered API:** chain.ts, evm-wagmi.ts, erc20-abi.ts, block-explorer.ts, wagmi.config.ts, onchain/, node-formation/, index.ts

## Responsibilities

- This directory **does**: provide single source of truth for chain configuration; export Base mainnet constants
- This directory **does not**: perform network calls; handle wallet connections; manage environment variables

## Usage

```typescript
import { CHAIN, CHAIN_ID, USDC_TOKEN_ADDRESS } from "@/shared/web3";
```

## Standards

- Chain configuration is hardcoded (no env override)
- Build-time validation enforces consistency with .cogni/repo-spec.yaml via scripts/validate-chain-config.ts
- EVM-only (wagmi Chain); Solana would require separate module

## Dependencies

- **Internal:** none
- **External:** wagmi/chains

## Change Protocol

- Update this file when adding new chain constants or changing target chain
- Update .cogni/repo-spec.yaml cogni_dao.chain_id to match
- Bump **Last reviewed** date
- Run `pnpm validate:chain` to verify consistency

## Notes

- Chain locked to Base mainnet (8453)
- wagmi.config.ts exists for client-side wallet config but NOT exported from index.ts (prevents server-side import)
- EvmOnchainClient extended with getBytecode() and readContract() for Node Formation verification
- node-formation/ subdirectory contains P0 DAO formation primitives (isolated from payment/treasury code)
- evm-wagmi.ts separates wagmi types from framework-agnostic chain.ts
- EvmOnchainClient is an infrastructure seam (NOT a domain port) shared by multiple adapters
- Production uses ViemEvmOnchainClient with lazy initialization (allows builds without EVM_RPC_URL)
- Tests use FakeEvmOnchainClient (no RPC calls, no URL needed)
- Build fails if repo-spec chain_id mismatches app CHAIN_ID
