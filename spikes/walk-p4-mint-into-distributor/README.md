# Walk P4 de-risk spike — mint an epoch into a stock distributor via early-execute

**Story:** story.5021 (Walk) · the make-or-break for the distribution loop.

## The question

Can the node-template DAO — with **NO central wallet** and **NO pre-minted pile** —
mint an epoch's tokens **directly into** a freshly-deployed stock Uniswap
`MerkleDistributor` via a governance **early-execute** proposal, and can a
contributor then **claim**?

## Answer

**YES.** Proven end-to-end against a real Base-mainnet fork of the live
node-template DAO. See [`REPORT.md`](./REPORT.md) for evidence + surprises.

## What the spike does (all on a forked Base mainnet, real contracts)

1. Builds a 1-leaf merkle root using the **frozen Cogni leaf format**
   (`keccak256(abi.encodePacked(uint256 index, address account, uint256 amount))`,
   `packages/aragon-osx/src/token-distribution.ts`).
2. Deploys the **stock Uniswap MerkleDistributor v1** (npm `@uniswap/merkle-distributor@1.0.1`,
   constructor `(address token, bytes32 merkleRoot)`) bound to the live
   GovernanceERC20 token + that root.
3. Submits a `mint(distributor, amount)` action through the live TokenVoting
   plugin's `createProposal(metadata, actions, allowFailureMap, startDate,
   endDate, voteOption=Yes, tryEarlyExecution=true)`, sent **as the real on-chain
   governance-token holder** (impersonated via anvil).
4. Asserts the proposal **early-executed in the same tx** -> `DAO.execute` ->
   `token.mint()` ran **straight into the distributor** (supply grew by exactly
   the distribution amount; no transfer hop).
5. Calls `distributor.claim(index, account, amount, proof)` and asserts the
   contributor received the tokens and the slot is now claimed.

## Run it yourself

```bash
# 1. Install foundry (anvil) if needed
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2. Fork Base mainnet at the live node-template DAO
anvil --fork-url https://mainnet.base.org --auto-impersonate --port 8545

# 3. Run the spike (deps resolve via the symlinked node_modules ->
#    packages/aragon-osx, which carries viem + @openzeppelin/merkle-tree)
SPIKE_RPC=http://127.0.0.1:8545 node spikes/walk-p4-mint-into-distributor/run-spike.mjs
```

A captured passing run is in [`SPIKE_RUN.log`](./SPIKE_RUN.log).

## Live addresses used (Base, chain 8453) — all verified on-chain

| role | address | how discovered |
|---|---|---|
| DAO | `0x717a747df71111a678202BfCD2E3B0081A9aeB56` | given |
| GovernanceERC20 | `0x0166Db3d42603E790Fb685059DcAa37087B032c8` | given; `name()` == "node-template", totalSupply == 1e18 |
| TokenVoting plugin | `0x6b8f7c9f18b33b8ad4e8b0710dd64a27388de6c9` | DAO `Granted` event, permissionId = `keccak256("EXECUTE_PERMISSION")`, `who` |
| Genesis holder / proposer | `0x070075f1389ae1182abac722b36ca12285d0c949` | formation mint `Transfer(from=0x0)`; holds 1e18 (100%), self-delegated |

The DAO holds `MINT_PERMISSION` on the token — verified via the DAO's
`Granted(permissionId=keccak256("MINT_PERMISSION"), where=token, who=DAO)` event
at the formation block.

## Files

- `run-spike.mjs` — the runnable spike (viem + anvil fork).
- `artifacts/MerkleDistributor.json` — stock Uniswap distributor ABI+bytecode (npm @1.0.1).
- `SPIKE_RUN.log` — captured passing run.
- `REPORT.md` — the honest findings + the surprises that change harness/loop shape.
