# aragon-osx · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Pure TypeScript package for Node Formation P0. Provides Aragon OSx encoding, address constants, and receipt helpers. No RPC, no env, no browser/Node.js APIs.

## Pointers

- [Node Formation Spec](../../docs/spec/node-formation.md)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
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

**External deps:** `viem` (ABI encoding). No Node.js APIs, no browser APIs.

## Public Surface

- **Exports:**
  - `encodeTokenVotingSetup()` - ABI-encode TokenVoting plugin setup data
  - `parseDaoTokenSupplyUnits()` - validate whole-token supplies and convert to 18-decimal base units
  - `buildDaoTokenMerkleDistribution()` - build deterministic EVM-compatible token claim manifests
  - `hashDaoTokenClaimLeaf()`, `verifyDaoTokenMerkleProof()` - claim leaf/proof helpers
  - `ARAGON_OSX_ADDRESSES` - Hardcoded OSx addresses per chainId
  - `getAragonAddresses()` - Lookup helper
  - `osx/events` - Event ABIs and topic constants
  - `osx/receipt` - Receipt decoders (strict, throws if events missing)
  - `osx/version` - Pinned version constants
  - Types: `HexAddress`, `Hex`, `SupportedChainId`, `AragonOsxAddresses`
- **Files considered API:** `index.ts`, `encoding.ts`, `aragon.ts`, `osx/*.ts`, `types.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** none

## Responsibilities

- This directory **does**: Encode TokenVoting setup structs, provide OSx address constants, extract addresses from receipts
- This directory **does not**: Make RPC calls, read env vars, perform server verification, handle wallet signing

## Usage

```bash
pnpm --filter @aragon-osx typecheck
pnpm --filter @aragon-osx test
```

## Standards

- Pure functions only (no I/O, no side effects)
- All exports must work in both browser and Node.js
- Encoding parity with Foundry scripts enforced via test fixture (P0 deliverable)

## Dependencies

- **Internal:** none (standalone package)
- **External:** `viem` (ABI encoding + types only)

## Change Protocol

- Update this file when public exports or boundaries change
- Encoding struct changes require parity test update
- Address changes must sync with [Node Formation Spec](../../docs/spec/node-formation.md) appendix

## Notes

- MintSettings struct supports both v1.3 and v1.4 via `mintSettingsVersion` parameter
- OSx v1.4.0 field verification required before production use
- Package isolation enforced: enables future repo split (Node vs Operator)
- Encoding parity test in `tests/encoding.parity.test.ts` validates struct field order
