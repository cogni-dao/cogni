# Walk RIG — anvil Base-fork CUMULATIVE-distributor e2e (Tier-1.5, no real money)

**Story:** story.5021 (Walk) · the test-isolation rig that proves the Cogni
token-distribution e2e with **ZERO production risk**.

A repeatable, documented harness that proves the **CUMULATIVE** recurring-reward
loop — one `CumulativeMerkleDrop` per node serving **multiple epochs** — entirely
against a **local anvil fork of Base mainnet**. No write tx ever touches the real
Base RPC.

This is the cumulative sibling of `spikes/walk-p4-mint-into-distributor/` (which
proved the one-shot Uniswap distributor). It reuses the same anvil-fork + viem +
real-frozen-source pattern.

---

## TL;DR — run it in two commands

```bash
# 1. (one-time) install foundry (anvil + cast)
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2a. start the fork (terminal A) — reads EVM_RPC_URL PURELY as the fork source
bash spikes/walk-rig-cumulative-fork/start-fork.sh

# 2b. run the cumulative proof (terminal B)
SPIKE_RPC=http://127.0.0.1:8545 \
  pnpm dlx tsx spikes/walk-rig-cumulative-fork/run-cumulative.ts
```

A passing run prints `[ok]` for every assertion and ends with
`RESULT: PASS — ONE 1inch CumulativeMerkleDrop served TWO epochs`.
A captured passing run is in [`CUMULATIVE_RUN.log`](./CUMULATIVE_RUN.log)
(21 `[ok]`, 0 `FAIL`).

> **Prereq:** a workspace install (`pnpm install`) so `viem` and the `@cogni/*`
> source packages resolve. The harness imports the **real vendored** contract
> artifacts + ABIs by relative path and runs under `tsx` (no build step).

---

## Start the fork — the exact command

`start-fork.sh` runs:

```bash
anvil --fork-url "$EVM_RPC_URL" --auto-impersonate --port 8545
```

- `$EVM_RPC_URL` is read from the repo's `.env.local` **purely as the fork
  SOURCE url**. anvil opens an RPC connection to Base mainnet to *read* state at
  the fork block, then serves a **local, throwaway** chain at
  `http://127.0.0.1:8545`. The fork is read-only against mainnet; all mutations
  live only in anvil's local memory.
- `--auto-impersonate` lets the harness send txs as any address (the genesis
  holder, the DAO, the TokenVoting plugin, two contributors) without holding
  private keys.
- Override the source: `FORK_URL=<rpc> bash start-fork.sh`, or
  `FORK_ENV_FILE=<path> ...`, or `FORK_PORT=<port> ...`.

Manual equivalent:

```bash
FORK_URL=$(grep -E '^EVM_RPC_URL=' /path/to/.env.local | cut -d= -f2-)
anvil --fork-url "$FORK_URL" --auto-impersonate --port 8545
```

---

## What the proof does (all on the fork, real contracts)

Uses the **REAL vendored / frozen production code** — nothing reinvented:

| concern                         | imported from                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| CumulativeMerkleDrop ABI+bytecode | `packages/cogni-contracts/src/cumulative-merkle-distributor` (vendored 1inch)      |
| GovernanceERC20 `mint`          | `packages/node-shared/src/web3/node-formation/aragon-abi`                            |
| DAO TokenVoting / ProposalCreated | `nodes/operator/app/src/features/governance/lib/proposal-abis`                     |
| cumulative merkle tree          | `spikes/walk-rig-cumulative-fork/cumulative-merkle.ts` (1inch leaf + sorted pairs)  |

**Token:** the **REAL** node-template GovernanceERC20 on Base
(`0x0166Db3d…B032c8`), owned by the real node-template DAO
(`0x717a747d…aeB56`). Discovered + verified on-chain (same constants the walk-p4
spike proved). No mock ERC20 was needed.

**Leaf format** (matches the vendored 1inch contract):
`leaf = keccak256(abi.encodePacked(address account, uint256 cumulativeAmount))` —
**no index**. Proof = sorted sibling pairs (OZ `MerkleProof`-compatible, i.e.
merkletreejs `{ hashLeaves:true, sortPairs:true }`).

### Steps

1. **Deploy** the vendored `CumulativeMerkleDrop(token)` (owner := deployer).
2. **transferOwnership** → the DAO. `distributor.owner() == DAO`.
3. **EPOCH 1**
   - DAO **early-executes** `mint(distributor, delta1=100)` through the REAL
     TokenVoting plugin (`createProposal(..., voteYes, tryEarlyExecution=true)`),
     impersonating the 100% genesis holder — tokens minted **straight into** the
     distributor (no central wallet, no pre-mint).
   - Build cumulative tree for **2 accounts** (A=60, B=40), `setMerkleRoot(root1)`
     as the owner (DAO).
   - A claims 60, B claims 40 → balances increase by the cumulative amounts.
   - A's **re-claim of the same cumulative REVERTS** (`cumulativeClaimed` blocks
     it); balance unchanged.
4. **EPOCH 2** — the whole point of *cumulative*:
   - DAO mints **only the delta2=40** into the **same** distributor.
   - `setMerkleRoot(root2)` with A's **higher** cumulative (A=100, B=40).
   - A claims `cumulative2` → receives **only `cumulative2 − alreadyClaimed`
     = 40**, total balance now exactly 100.
   - B (no new earnings) claiming the unchanged cumulative **REVERTS**.
5. Prints a PASS/FAIL summary with tx hashes + before/after balances.

---

## Prod-isolation guarantee — what stops a real tx

1. **Every write goes to `http://127.0.0.1:8545`.** The harness only ever
   constructs viem clients with `transport: http(SPIKE_RPC)` where `SPIKE_RPC`
   defaults to the local fork. It never opens a client against `EVM_RPC_URL`.
2. **Hard guard in the script.** `run-cumulative.ts` refuses to run unless
   `SPIKE_RPC` matches `127.0.0.1` / `localhost` — set it to a remote RPC and the
   script exits before sending anything.
3. **The prod RPC is read-only.** `EVM_RPC_URL` is passed to anvil **only** as
   `--fork-url` (the source it reads mainnet state from). Reads against mainnet
   cost nothing and change nothing; all mutations are anvil-local and vanish when
   anvil stops.
4. **Impersonation is an anvil cheat.** `--auto-impersonate` /
   `anvil_impersonateAccount` only exist on the local fork — they cannot forge a
   signature against real Base mainnet.

> **Why `.env.local` being PROD-WIRED is safe here:** `APP_ENV=production`,
> the prod DAO treasury, and `EVM_RPC_URL=base-mainnet…` are read **only** as the
> fork source URL. The rig has no code path that sends a write tx to
> `base-mainnet.g.alchemy.com`.

---

## Pointing the APP itself at the fork (next iteration)

This rig proves the **on-chain** half against the fork. To exercise the **full
app** (publish-epoch client → on-chain mint → claim) against the same fork without
prod risk, override the chain RPC and flip the app off production mode:

```bash
# .env.local.fork (used instead of .env.local for a fork run)
APP_ENV=development                 # NOT production — disables live-money guards
EVM_RPC_URL=http://127.0.0.1:8545   # the anvil fork, not base-mainnet
# DAO/token addresses can stay the same — they exist on the fork (it forked Base)
```

The single load-bearing override is **`EVM_RPC_URL` → the fork** (so every chain
write the app makes lands on anvil) plus **`APP_ENV != production`** (so the
app's live-payment/settlement guards stay in their non-shipping "skip" mode —
see the `settlement_skipped` cand-a behavior). Wiring the full app end-to-end
against the fork is deferred; this iteration proves the contract loop.

---

## Surprises / findings (loop-shape relevant)

- **Minting non-delegated tokens dilutes future governance participation.** OSx
  TokenVoting's participation gate (`minVotingPower`) is a percentage of **total
  token supply** at the proposal snapshot. Epoch 1's mint of 100 tokens into the
  distributor (a contract that never delegates → 0 voting power) inflated supply
  from ~1e18 to ~101e18, so a *fresh* epoch-2 proposal demanded ~50.5e18 of
  participation while the lone holder still had only 1e18 of voting power →
  early-execute became **impossible**. This is real and orthogonal to the
  cumulative distributor. **Implication for the live loop:** a node that funds
  epochs by minting into a non-voting distributor will progressively starve its
  own governance participation unless the voting base scales too (or the
  distributor's holdings are excluded from the participation denominator).
- **Workaround used for epoch 2:** fund the delta via `DAO.execute([mint])`,
  impersonating the TokenVoting plugin (verified holder of `EXECUTE_PERMISSION`
  on the DAO). This is the **identical on-chain effect** of a passed-and-executed
  proposal — it just skips the vote tally that the participation quirk blocks.
  Epoch 1 still uses the **full** `createProposal + early-execute` path, so both
  the vote path and the execute path are exercised.
- **A raw impersonated `DAO → token.mint()` reverts.** `mint` is
  `auth(MINT_PERMISSION)`, which routes through the DAO's ACL and requires the
  call to arrive via `DAO.execute` (the EXECUTE flow) — not an EOA-style call
  from the DAO address. Hence the plugin-impersonated `DAO.execute` above.
- **`claim` needs a padded gas limit** (300k). GovernanceERC20's
  `_afterTokenTransfer` runs ERC20Votes checkpoint + delegation writes; viem's
  auto-estimate undershoots and trips the OZ ReentrancyGuard 63/64 sentry. Real
  wallets pad; harness artifact, not a loop blocker (same as walk-p4).

---

## Files

- `start-fork.sh` — one-command anvil Base-mainnet fork (reads `EVM_RPC_URL` as
  the fork source only).
- `run-cumulative.ts` — **the proof.** Deploy → transferOwnership → 2-epoch
  cumulative loop with assertions + PASS/FAIL summary. Run under `tsx`.
- `cumulative-merkle.ts` — 1inch-compatible cumulative merkle tree
  (leaf = `keccak256(packed(address, uint256))`, sorted-pair OZ proofs), inline
  (no merkletreejs dep), with an off-chain `verify`.
- `CUMULATIVE_RUN.log` — captured passing run (21 `[ok]`, 0 `FAIL`).
