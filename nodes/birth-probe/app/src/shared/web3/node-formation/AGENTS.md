# node-formation · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Node Formation P0 web3 primitives: Aragon OSx ABIs and chain address constants. CogniSignal artifacts are in `@cogni/cogni-contracts`.

## Pointers

- [Node Formation Spec](../../../../../../docs/spec/node-formation.md)
- [Aragon OSx v1.4.0](https://github.com/aragon/osx/tree/v1.4.0)

## Boundaries

```json
{
  "layer": "shared",
  "may_import": ["shared", "types"],
  "must_not_import": ["core", "ports", "adapters", "features", "app"]
}
```

## Public Surface

- **Exports:**
  - `DAO_FACTORY_ABI` - DAOFactory.createDao + pluginSetupProcessor
  - `TOKEN_VOTING_ABI` - TokenVoting.getVotingToken
  - `GOVERNANCE_ERC20_ABI` - GovernanceERC20.balanceOf
  - `ARAGON_OSX_ADDRESSES` - Per-chain OSx deployment addresses
  - `TOKEN_VOTING_VERSION_TAG` - Plugin version (v1.4.0)
- **Files considered API:** `index.ts`, all exported constants

## Responsibilities

- This directory **does**: Provide minimal Aragon OSx ABIs for DAO formation, maintain chain address mappings
- This directory **does not**: Encode setup data (see `packages/aragon-osx`), provide CogniSignal artifacts (see `@cogni/cogni-contracts`), make RPC calls, handle wallet signing

## Usage

```typescript
import {
  DAO_FACTORY_ABI,
  TOKEN_VOTING_ABI,
} from "@/shared/web3/node-formation";

// CogniSignal artifacts from @cogni/cogni-contracts
import {
  COGNI_SIGNAL_ABI,
  COGNI_SIGNAL_BYTECODE,
} from "@cogni/cogni-contracts";
```

## Standards

- Minimal ABI surfaces only (no full contract interfaces)
- ABIs extracted from OSx v1.4.0 or cogni-gov-contracts Foundry artifacts
- Bytecode placeholders updated when artifacts available
- **CRITICAL:** Struct field order must match OSx exactly:
  - DAOSettings: trustedForwarder, daoURI, subdomain, metadata
  - PluginSetupRef: versionTag (uint8 release, uint16 build), pluginSetupRepo

## Dependencies

- **Internal:** none
- **External:** none (pure constants)

## Change Protocol

- Update when OSx addresses change or new chains added
- Sync address changes with [Node Formation Spec](../../../../../../docs/spec/node-formation.md) appendix
- Bytecode updates require artifact re-extraction

## Notes

- Real OSx addresses hardcoded (Base Mainnet, Base Sepolia, Sepolia)
- CogniSignal ABI/bytecode moved to `packages/cogni-contracts`
