# Walk E2E — full distribution proof (sign → finalize → mint → claim)

`finalize-mint-claim.ts` proves the token-distribution Definition of Done end to
end in **LOCAL DEV** against an **anvil Base-fork**, with zero prod risk and zero
human friction:

> a contributor's attribution accrues → the **admin SIGNS** that epoch's ledger
> (a real EIP-712 approver signature) → the **DAO MINTS** the per-epoch delta into
> the ONE cumulative distributor → the **contributor CLAIMS** the accrued tokens.

Everything is driven through **real product code** — the R3 `finalizeEpoch` +
`buildAndPersistCumulativeDistribution` fold, the persisted manifest, the vendored
1inch `CumulativeMerkleDrop`. Only the harness (orchestration + the scripted admin
signature) is new. The finalize is driven by starting `FinalizeEpochWorkflow`
directly on `ledger-tasks` (no app, no SIWE); the worker verifies
`recover(sig) ∈ epoch.approvers[]` and runs the fold itself.

## Prerequisites

1. **Foundry / anvil** on PATH: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
2. **Local infra up**: `pnpm dev:infra` (docker postgres + temporal + redis …).
3. **A finalizable review epoch pinned to an anvil approver** — seed it:

   ```bash
   SEED_APPROVERS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 pnpm db:seed
   ```

   That anvil account (`anvil[0]`) is the one whose key the harness holds to sign
   the finalize statement.

## Run

```bash
pnpm tsx scripts/e2e/finalize-mint-claim.ts
```

The harness: guard-0 preflight → links ALICE/BEN wallets → spawns an anvil
Base-fork → deploys the distributor + `transferOwnership(DAO)` → writes an
**off-tree** augmented repo-spec (`.context/harness-run/.cogni/repo-spec.yaml`,
gitignored — never the tracked spec) that activates distributions → stops the
dockerized scheduler-worker and starts the **host** ledger worker at that cwd →
computes `finalAllocationSetHash` with the same pure functions as `/sign-data` →
signs the EIP-712 → starts `FinalizeEpochWorkflow` → reads the **real persisted
manifest** → DAO-impersonate `mint(delta)` + `setMerkleRoot(root)` → each linked
claimant claims. It kills the anvil + worker children on exit.

**PASS** = the workflow reaches `finalized`, a non-empty manifest is persisted,
ALICE + BEN balances increase by their cumulative amounts on the fork, and
conservation holds (exactly 2 leaves — the linked wallets; unlinked contributors
excluded; `mintDelta == Σ(leaf cumulative) == poolTotal × 10^18`; distributor
fully drained).

## Prod-safety (guard-0)

- All on-chain **writes** target `http://127.0.0.1:8545` (the fork) — hard-asserted.
- `EVM_RPC_URL` (real Base) is used **only** as anvil's `--fork-url` read source;
  the harness never opens a viem client against it.
- `DATABASE_URL` must resolve to a local host (`localhost`/`127.0.0.1`/`postgres`)
  — the harness aborts otherwise.
- The host ledger worker never sends an on-chain tx (the fold only BUILDS +
  persists the manifest).
