# Walk P4 harness — mint an epoch into a stock distributor via early-execute (Tier-1.5)

**Story:** story.5021 (Walk) · the make-or-break for the distribution loop.

A committed, repeatable **on-chain harness** that proves the on-chain half of the
publish-epoch → claim loop **WITHOUT real money**, against an `anvil --fork-url`
fork of the **live** node-template DAO on Base mainnet.

## The question

Can the node-template DAO — with **NO central wallet** and **NO pre-minted pile** —
mint an epoch's tokens **directly into** a freshly-deployed stock Uniswap
`MerkleDistributor` via a governance **early-execute** proposal, and can a
contributor then **claim** (with a double-claim blocked)?

## Answer

**YES.** Proven end-to-end against a real Base-mainnet fork of the live
node-template DAO. See [`REPORT.md`](./REPORT.md) for evidence + surprises, and
[`SPIKE_RUN.log`](./SPIKE_RUN.log) for a captured passing run.

## What the harness does (all on a forked Base mainnet, real contracts)

Uses the **REAL production code** — not reinvented logic:

| concern                           | imported from                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| root + leaf (FROZEN)              | `buildDaoTokenMerkleDistribution` / `hashDaoTokenClaimLeaf` — `packages/aragon-osx/src/token-distribution.ts` |
| stock distributor artifact        | `MERKLE_DISTRIBUTOR_ABI` + `MERKLE_DISTRIBUTOR_BYTECODE` — `packages/cogni-contracts/src/merkle-distributor`  |
| GovernanceERC20 mint              | `GOVERNANCE_ERC20_ABI` — `@cogni/node-shared` (`packages/node-shared/src/web3/node-formation/aragon-abi.ts`)  |
| DAO TokenVoting / ProposalCreated | `TOKEN_VOTING_ABI` — `nodes/operator/app/src/features/governance/lib/proposal-abis.ts`                        |

Steps:

1. Builds a **1-leaf** merkle root with the **frozen Cogni builder** (leaf =
   `keccak256(abi.encodePacked(uint256 index, address account, uint256 amount))`).
2. Deploys the **stock Uniswap MerkleDistributor v1** (the vendored
   `@cogni/cogni-contracts` bytecode — byte-for-byte the npm
   `@uniswap/merkle-distributor@1.0.1` artifact) bound to the live
   GovernanceERC20 token + that root.
3. Submits a `mint(distributor, amount)` action through the live TokenVoting
   plugin's `createProposal(..., voteOption=Yes, tryEarlyExecution=true)`, sent
   **as the real on-chain governance-token holder** (impersonated via anvil),
   self-delegated, holding 100% of voting power.
4. Asserts the proposal **early-executed in the same tx** → `DAO.execute` →
   `token.mint()` ran **straight into the distributor** (supply grew by exactly
   the distribution amount; no transfer hop).
5. Calls `distributor.claim(index, account, amount, proof)` and asserts the
   contributor received the tokens against the **FROZEN** root and the slot is
   now claimed.
6. Asserts a **double-claim REVERTS** (the contributor's balance is unchanged).

## Run it yourself (one command, after anvil is up)

```bash
# 1. Install foundry (anvil) if needed
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2. Fork Base mainnet at the live node-template DAO (any recent Base RPC works)
anvil --fork-url https://mainnet.base.org --auto-impersonate --port 8545

# 3. In another shell, from the repo root, run the harness.
#    tsx resolves the FROZEN source directly — no build step. The workspace
#    install provides viem + @openzeppelin/merkle-tree.
SPIKE_RPC=http://127.0.0.1:8545 pnpm dlx tsx spikes/walk-p4-mint-into-distributor/run-spike.ts
```

Notes / prerequisites:

- **Requires a workspace install** (`pnpm install`) so `viem` and the
  `@cogni/*` source packages resolve. The harness imports the frozen source by
  relative path and runs under `tsx` (no `dist` build needed).
- `--auto-impersonate` is mandatory — the harness sends txs as the real on-chain
  holder + the DAO without holding any private keys.
- Use any Base mainnet RPC for `--fork-url`. The default `SPIKE_RPC` is
  `http://127.0.0.1:8545`.
- A passing run prints `[ok]` for every assertion and ends with the
  `RESULT: YES.` banner (see [`SPIKE_RUN.log`](./SPIKE_RUN.log) for the original
  spike's captured run, against the same constants and the same frozen root
  `0xf58f4a25…1429ab1df7`).

## Live addresses used (Base, chain 8453) — all verified on-chain

| role                      | address                                      | how discovered                                                               |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| DAO                       | `0x717a747df71111a678202BfCD2E3B0081A9aeB56` | given                                                                        |
| GovernanceERC20           | `0x0166Db3d42603E790Fb685059DcAa37087B032c8` | given; `name()` == "node-template", totalSupply == 1e18                      |
| TokenVoting plugin        | `0x6b8f7c9f18b33b8ad4e8b0710dd64a27388de6c9` | DAO `Granted` event, permissionId = `keccak256("EXECUTE_PERMISSION")`, `who` |
| Genesis holder / proposer | `0x070075f1389ae1182abac722b36ca12285d0c949` | formation mint `Transfer(from=0x0)`; holds 1e18 (100%), self-delegated       |

The DAO holds `MINT_PERMISSION` on the token — verified via the DAO's
`Granted(permissionId=keccak256("MINT_PERMISSION"), where=token, who=DAO)` event
at the formation block. No extra permission grant is required.

## Files

- `run-spike.ts` — **the harness** (viem + anvil fork) importing the REAL frozen
  production code. Run this.
- `run-spike.mjs` — the original recovered spike (self-contained, inlined ABIs +
  a leaf-hash copy + the JSON artifact). Kept for provenance; `run-spike.ts`
  supersedes it by importing the real modules and adding the explicit
  double-claim-revert assertion.
- `artifacts/MerkleDistributor.json` — stock Uniswap distributor ABI+bytecode
  (npm `@uniswap/merkle-distributor@1.0.1`). The vendored
  `@cogni/cogni-contracts` bytecode is byte-for-byte identical to this (the only
  diff is the `0x` prefix), which is why `run-spike.ts` deploys the cogni-contracts
  constant directly.
- `artifacts/uniswap-merkle-distributor-package.json` — the npm package manifest
  for provenance.
- `SPIKE_RUN.log` — captured passing run of the original spike.
- `REPORT.md` — the honest findings + the surprises that change harness/loop shape.
