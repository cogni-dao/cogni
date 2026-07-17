# P4 de-risk spike — REPORT (story.5021 Walk)

> Brutally honest. Every claim below is backed by a real tx on a Base-mainnet
> fork of the **live** node-template DAO. No fabrication. The full passing run
> is in `SPIKE_RUN.log`; re-runnable via `run-spike.mjs`.

## THE QUESTION

Can the node-template DAO — with NO central wallet and NO pre-minted pile — mint
an epoch's tokens directly into a freshly-deployed stock Uniswap MerkleDistributor
via a governance early-execute proposal, and can a contributor then claim?

## THE ANSWER: YES — proven end-to-end.

| step                                     | result | evidence                                                                                                               |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| No pre-mint exists                       | PASS   | live `token.totalSupply()` == `1e18` (the lone genesis "solo_one_token")                                               |
| Deploy stock distributor `(token, root)` | PASS   | `distributor.token()` == GovernanceERC20, `distributor.merkleRoot()` == our 1-leaf root, balance 0                     |
| Early-execute mints into distributor     | PASS   | proposal `executed=true` in the **same tx**; `totalSupply` 1e18 -> 101e18; distributor balance 0 -> 100e18             |
| Mint was a real MINT (not a transfer)    | PASS   | `Transfer(from=0x0, to=distributor, 100e18)` in the createProposal receipt; supply delta == amount                     |
| Contributor claims                       | PASS   | `claim(0, contributor, 100e18, [])` -> contributor balance == 100e18, `isClaimed(0)` == true, double-claim now blocked |

### Did early-execute actually mint into the distributor?

**YES.** In a single `createProposal(..., voteOption=Yes, tryEarlyExecution=true)`
transaction sent by the genesis holder, the receipt contains, in order:

- `ProposalCreated(proposalId, creator=holder, ...)`
- `Transfer(from=0x0, to=distributor, 100e18)` on the GovernanceERC20 — the **mint**
- DAO `Executed(plugin)` event — the DAO ran the action
- `ProposalExecuted(proposalId)` on the plugin

Post-state reads: `getProposal(realId)` -> `executed=true`, tally `yes=1e18/no=0/abstain=0`,
action = `mint(distributor, 100e18)` (calldata selector `40c10f19`). `totalSupply`
went `1e18 -> 101e18`; distributor token balance went `0 -> 100e18`. **No central
wallet was ever in the path.**

### Did the claim succeed?

**YES.** `Claimed(0, contributor, 100e18)` emitted; contributor ERC20 balance ==
100e18; `isClaimed(0)` flipped to true.

---

## SURPRISES (these change harness shape; one is a LOOP-DESIGN note)

### 1. The proposer MUST vote Yes in the same call, and they need delegated voting power

The production proposal client
(`nodes/operator/app/src/app/(public)/propose/merge/merge-proposal.client.tsx:112`)
hard-codes `_voteOption = 0` (None) and `_tryEarlyExecution = false`. With those
values the proposal is created but does **not** execute — it just opens for voting.
For the mint-into-distributor loop to be **atomic** (propose -> mint, one tx) the
caller must pass `_voteOption = 2` (Yes) **and** `_tryEarlyExecution = true`.

Why it works for node-template today: the plugin is configured `votingMode=1`
(EarlyExecution), `supportThreshold=50%`, `minParticipation=50%`, and the genesis
holder holds **100%** of voting power **and has self-delegated** (verified:
`delegates(holder)==holder`, `getVotes(holder)==1e18`). One Yes vote from 100% of
supply immediately satisfies support + participation AND makes the outcome
unchangeable -> early-execute fires. **If a node ever has >1 holder, or the
proposer hasn't self-delegated, early-execute will NOT be atomic** and the loop
needs a real vote + a later `execute()` call. For the V0 solo-node Walk this is
fine; flag it for the >1-holder future.

### 2. OSx 1.4 `proposalId` is a HASH, not the simulate() return value

`pub.simulateContract(createProposal)` returns a `proposalId`, but it does **not**
match the id under which the proposal is actually stored (querying `getProposal`
with it returns all-zeros). The authoritative id must be parsed from the
`ProposalCreated` event in the tx receipt. Any code that builds on top of
`createProposal` (status polling, claim-manifest pinning) must read the event,
never trust the call return. The spike does this.

### 3. Merkle format is COMPATIBLE (no surprise here, but it was the scariest unknown)

Cogni's `SimpleMerkleTree` (OZ `@openzeppelin/merkle-tree`) builds the tree from
**pre-hashed** leaves (`leaf = keccak256(abi.encodePacked(index, account, amount))`).
For a 1-leaf tree, `root === leaf` and the proof is `[]`. Uniswap's distributor
computes `node = keccak256(abi.encodePacked(index, account, amount))` and runs
OZ `MerkleProof.verify([], root, node)` -> `node == root` -> true. **They agree.**
The 1-leaf path is proven; multi-leaf needs the same `SimpleMerkleTree` proofs
(pair-sorted, which matches OZ `MerkleProof.verify`) — consistent, but only the
1-leaf path is exercised here. Worth a follow-up 3-leaf assertion before Run.

### 4. Harness-only: GovernanceERC20 transfer trips `ReentrancySentryOOG` under viem's gas auto-estimate

The distributor's `claim` -> `token.transfer` runs ERC20Votes checkpoint +
delegation writes in `_afterTokenTransfer`. viem's auto gas estimate undershoots
and the OZ ReentrancyGuard 63/64 sentry reverts `ReentrancySentryOOG`. Real
wallets and `cast` pad the limit; the spike sets `gas: 300_000n` on the claim.
**Not a loop blocker — a harness artifact.** Worth noting for any future
auto-estimating claim UI on a Votes token.

---

## What this de-risks for story.5021

- The core mechanic is sound: **born-with-no-treasury DAO can fund a distributor
  by minting at distribution time**, through normal Aragon governance, in one tx.
- The stock Uniswap distributor needs **no modification** — `(token, root)`
  constructor + the frozen Cogni leaf format claim cleanly.
- The MINT_PERMISSION the DAO already holds (from TokenVotingSetup at formation)
  is exactly what's needed; no extra permission grant is required.

## Open follow-ups (prose, not work-items)

1. Wire a distribution-flavored proposal builder that passes `voteOption=Yes` +
   `tryEarlyExecution=true` (the merge client's `false/None` is wrong for this loop).
2. Add a 3-leaf merkle assertion to prove non-empty proofs verify against the
   stock distributor (expected to pass; not yet exercised).
3. Decide the >1-holder / undelegated-proposer story: atomic early-execute only
   holds while one self-delegated holder owns 100% of supply.

## Environment / reproducibility

- Foundry `anvil 1.7.1` forking `https://mainnet.base.org` at block ~47,997,7xx.
- viem 2.39.3 + `@openzeppelin/merkle-tree` 1.0.8 (resolved from `packages/aragon-osx`).
- Stock distributor artifact: npm `@uniswap/merkle-distributor@1.0.1`
  (`artifacts/MerkleDistributor.json`).
