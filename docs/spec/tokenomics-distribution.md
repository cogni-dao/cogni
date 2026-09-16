---
id: tokenomics-distribution-spec
type: spec
title: "Tokenomics: Distribution Lifecycle (finalize → publish → claim)"
status: draft
spec_state: proposed
trust: draft
summary: "The on-chain distribution half of tokenomics: how a finalized epoch's signed ledger becomes minted tokens a contributor can claim. Defines the finalize→fold→publish→claim lifecycle and the ONE-TIME authorization model that replaces per-epoch DAO voting."
read_when: Building or reviewing distributor deploy/activation, the execute/publish surface, the claim surface, or the cumulative manifest. Sibling to tokenomics.md (economics) — this doc owns the mechanism.
implements: proj.transparent-credit-payouts
owner: derekg1729
created: 2026-08-15
tags: [governance, tokenomics, distribution, attribution, walk]
---

# Tokenomics: Distribution Lifecycle

> `tokenomics.md` answers "how big is the pool + what do the numbers mean." **This doc answers "how does a signed epoch ledger become tokens in a contributor's wallet."** It is the mechanism spec for Walk (first on-chain claims) — deploy, activate, publish, claim — and the authorization model that makes it scale.

## Goal

**A DAO with a governance token, distributing per epoch via a Merkle distributor, driven by a single approver signature per epoch and authorized ONCE — never a per-epoch vote, never a human moving tokens, always a contributor pull.**

## Lifecycle

```
 STEP                 WHAT                                        PLANE       AUTHORIZED BY
 1 open→review   collect→select→allocate → creditAmount          off-chain   (automatic)
 2 FINALIZE      approver signs ONE EIP-712 over the final        off-chain   ◄ the ONLY per-epoch
   review→final  allocation set (ONE_ADMIN_SIGNATURE_PER_EPOCH)    (sig)         governance act
 3 FOLD (R3)     that signature → cumulative merkle manifest:     off-chain   (automatic, from the
   auto          root + per-account cumulative leaves + mint       (Postgres)   finalize signature)
                 DELTA (this epoch's new tokens). Never sends a tx.
 4 PUBLISH       DAO mint(delta) → distributor + setMerkleRoot    ON-CHAIN    ◄ ONE-TIME authorized
   per epoch     (root). Built FROM the manifest.                  (Base)        (see below) — NOT a vote
 5 CLAIM         contributor PULL: claim(acct, cumAmt, root,      ON-CHAIN    permissionless
   anytime       proof) → receives cumAmt − alreadyClaimed.        (Base)       (proof-gated)
                 ONE cumulative root covers ALL unclaimed epochs.
```

Steps 1,2,3,5 are built and correct today. **Step 4's authorization is the load-bearing design decision below.**

## Invariants

Per `tokenomics.md` ("Root rotation authority"): **Walk = "Safe/manual or equivalent trusted governance execution publishes roots and funding." Run = Governor/Timelock.** The per-epoch governance decision is the **off-chain finalize signature** (step 2). The on-chain publish (step 4) is a _mechanical consequence_ of that signature, gated by an authorization the DAO grants **once**.

| Rule                       | Constraint                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ONE_TIME_AUTHORIZATION     | The DAO authorizes distributions with ONE governance action (at activation). No subsequent epoch requires a DAO vote. A design that puts a tokenholder vote on the per-epoch publish path is WRONG.                                                                                                                                                                                                                           |
| MULTI_MEMBER_BY_DEFAULT    | **Assume every DAO is a real multi-member DAO** — they start somewhere (often 1 member) but WILL grow. The one-time authorization must therefore be **SCOPED**: the executor may publish distributions and NOTHING else. An _unconditional_ EXECUTE grant (executor gains arbitrary DAO authority — treasury, re-permissioning) is NOT acceptable even for a 1-member node, because the design must hold as membership grows. |
| SIGNATURE_IS_THE_AUTHORITY | The per-epoch authority to publish is the approver's finalize EIP-712 signature over the allocation set — already produced in step 2. On-chain publish verifies/derives from it; it does not re-decide it.                                                                                                                                                                                                                    |
| DAO_IS_MINTER              | The DAO holds MINT_PERMISSION on its GovernanceERC20 and mints `delta` per epoch into the distributor. Never pre-minted, never a human-moved float.                                                                                                                                                                                                                                                                           |
| DAO_OWNS_DISTRIBUTOR       | The ONE per-node CumulativeMerkleDistributor is owned by the DAO; only the DAO (or its authorized executor) can `setMerkleRoot`.                                                                                                                                                                                                                                                                                              |
| CONSERVATION               | minted == claimable == Σ(leaves); one cumulative root supersedes prior roots (SINGLE_CLAIM_COVERS_ALL).                                                                                                                                                                                                                                                                                                                       |
| PULL_NOT_PUSH              | Tokens are never pushed to wallets. Contributors claim what they're owed. (Push-to-wallet may be an opt-in node policy, vNext.)                                                                                                                                                                                                                                                                                               |

## Design

### Walk mechanism (default — scoped EXECUTE via IPermissionCondition)

At **activation**, the DAO performs ONE governance action: `grantWithCondition(where=DAO, who=executor, EXECUTE_PERMISSION, condition=DistributionPublishCondition)`. The condition is a tiny on-chain contract (`DistributionPublishCondition(token, distributor)`, deployed once per node) whose `isGranted` accepts only an atomic compare-and-swap publish: `_callId` equals the distributor's live root, `_allowFailureMap == 0`, and the action set is exactly `[token.mint(distributor, *), distributor.setMerkleRoot(newRoot)]`. A stale payload is denied before mint, and mint/root rotation cannot fail independently. Thereafter each epoch's publish is **one direct `DAO.execute([mint, setRoot])`** by the executor — no proposal, no vote. The executor may be a Safe (m-of-n) or an agent wallet (Privy). Scope is enforced on-chain: a compromised executor key is capped to publish-shaped actions — it CANNOT drain the treasury or re-permission the DAO. **Residual trust (Walk):** CAS eliminates replay but does NOT bind the mint _amount_ or new _root_ to the finalized ledger — a malicious executor could over-mint into the distributor and set a self-serving root. Binding amount+root to the approver's finalize signature on-chain is exactly what the Run `EmissionsExecutor` (below) does; until then the executor is trusted on the values (mitigate with a Safe m-of-n).
Verified feasible: OSx `PermissionManager._auth` forwards the full `execute` calldata to a bound `IPermissionCondition.isGranted`; `grantWithCondition` is authorized by `ROOT_PERMISSION` (held by the DAO itself). See story.5005 design spike.

### Run mechanism (north star — permissionless)

A minimal **`EmissionsExecutor`** contract the DAO authorizes once (grants MINT + distributor `setMerkleRoot` authority). It exposes `publishDistribution(epochId, delta, root, approverSig)` that: (1) verifies `approverSig` against the DAO-pinned approver set, (2) enforces the budget cap on-chain (`totalMinted + delta ≤ policySupply`), (3) enforces epoch monotonicity (replay guard), (4) mints + setMerkleRoot. Submission is then **permissionless** — the finalize signature IS the authorization, so an agent/keeper (or the contributor) can trigger publish with no special key at all. This is what lets the whole loop run via API + an external-agent-controlled wallet (e.g. Privy), and it removes the trusted executor entirely.

### Idempotency & replay safety (per-layer)

A security review (story.5005) mapped double-spend/replay at every layer. Summary:

| operation                       | idempotent?                      | guard                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **finalize** (re-sign an epoch) | ✅ yes                           | repair branch returns the existing statement; pool/lines come from the persisted statement, never recomputed — no double-pool.                                                                                                                                                                                                     |
| **fold** (re-run the build)     | ✅ yes (FROZEN after first fold) | `priorCumulative` reads the PRIOR epoch's persisted manifest (not the current); builder asserts `cumulativeTotal == priorTotal + delta`. **bug.5022:** once THIS epoch has a manifest the fold FREEZES it — a re-run preserves it byte-identical (`mintDelta 0`), never re-folds/overwrites. No doubled delta, no mutated root.    |
| **claim**                       | ✅ yes (on-chain)                | 1inch `cumulativeClaimed[account]` — double-claim reverts `NothingToClaim`; stale-root claim reverts `MerkleRootWasUpdated`. On-chain state is the guard, not off-chain intent.                                                                                                                                                    |
| **publish** (mint + setRoot)    | ✅ CAS-replay-safe               | `DistributionPublishCondition` requires `_callId == distributor.merkleRoot()`, zero allow-failure map, and a different next root. Concurrent or repeated payloads become stale and are denied before mint. Amount/root authenticity remains executor-trusted until Run's `EmissionsExecutor` binds both to the approver signature. |

The remaining publish gap is value authenticity: CAS constrains shape, atomicity, and replay, but not the mint amount or new root. Only the `EmissionsExecutor` binds those values to the signed ledger on-chain. Until then, mitigate with a Safe m-of-n executor.

**bug.5022 (Stage 1, shipped #2021) — closed the last off-chain re-mint path.** The original Walk guard was client-only AND the manifest root was mutable: the fold's repair path re-folded and OVERWROTE an existing manifest, so a late wallet-link between publishes produced a NEW root the client guard no longer recognized → a second `mint(delta)`. Two server-side guards now close it:

1. **Fold FREEZE** (`buildAndPersistCumulativeDistribution`): once an epoch has a persisted manifest it is IMMUTABLE — the repair path preserves it (returns `mintDelta 0`), never re-folds/overwrites. The first finalize builds it; every later call preserves it. Late-resolved wallets flow into the NEXT epoch's cumulative fold, never a retro-overwrite.
2. **Route guard** (`distribution-tx`): reads the distributor's live `merkleRoot()` and returns `409 already_published` when it equals the epoch's root — server-side, not just UI. Best-effort (fails soft); the fold FREEZE is the load-bearing guard.

Proven on a real Base fork (`pnpm test:walk:dev` STEP 6b): re-finalizing a published epoch preserves the manifest byte-identical and mints nothing. `EmissionsExecutor` remains the on-chain class-elimination.

> **Sunday-run operational HARD RULE (freeze-on-manifest-exists):** because the freeze keys on _"a manifest exists"_ (not a recorded published-flag), a folded epoch is **final** — it can no longer be re-folded, even before publish. **Fix-ups (late wallet links, missed receipts, corrections) go to the NEXT epoch's cumulative fold; never re-finalize/re-fold a folded epoch to "patch" it.** This is safe because the model is cumulative (the next epoch's fold includes all credits to date). If a recovery path that re-folds an _unpublished_ epoch is ever required, switch to a recorded `published_root` (Stage 1.5) so the freeze gates only on published — do NOT weaken the freeze.

> Remediation note: tokens minted by an erroneous re-publish sit in the distributor with no matching claim leaf. They are recoverable only by a future epoch's cumulative root absorbing them, or (while the DAO owns the distributor) a sweep — never by the claim path.

## Non-Goals

### NOT acceptable (both fail the multi-member bar)

- **Per-epoch tokenholder vote** (Aragon `createProposal` per epoch). Only _appears_ to work when one owner holds ~100% (auto early-execution); a grown DAO would vote every epoch. Dead-end.
- **Unconditional EXECUTE grant** to a Safe/EOA — gives the executor arbitrary DAO authority (treasury, re-permissioning), not just publishing. Even for a 1-member node this is wrong, because membership grows. The condition (above) is what makes the grant safe.
  Both are preserved only as reference on branch `toks2-e2e-rig` — not pursued.

## Recipient (claimant) resolution — `actor_id`, not `user_id`

The claimant a manifest leaf pays is an **economic subject** (`actor_id`, kind = user | agent | system | org), resolved to a wallet via `actor_bindings`. Agents are first-class DAO participants — an `agent` actor earns and can hold tokens. When an agent works **on-behalf-of** a user (`subjectId = user:{user_id}`), _who owns the earned tokens_ (the agent's own wallet vs the delegating user's) is an **explicit delegation policy**, never an implicit default. See [identity-model.md § Distribution Authority + Recipient](./identity-model.md#distribution-authority--recipient).

> OPEN: the resolver is user-centric today (`user:{user_id}` / `identity:{provider}:{externalId}`); `agent:{actor_id}` + subjectId-delegated routing is forward work.

## Activation (one guided flow, git-authoritative)

Activation is ONE owner-driven flow (not two buttons), recorded git-authoritatively in the node's repo-spec via the operator GitHub App (`distributions.status: active`, `governance.token_contract`, `governance.emissions_holder`, `distributions.distributor_address`, `claim_contract_pattern`). It:

1. verifies the node has a DAO + GovernanceERC20 (prereq),
2. deploys the ONE distributor (owner wallet) → `transferOwnership(DAO)` — on-chain evidence (`owner()==DAO`, `token()==token`),
3. deploys the CAS condition and performs the **ONE_TIME_AUTHORIZATION** grant,
4. verifies authorization with paired probes (canonical atomic publish allowed; non-atomic twin denied),
5. only then records `distributions.status: active` in ONE repo-spec PR.

The operator `/nodes/:id` page is the sole hosted setup owner. Node-local `/gov/*` surfaces own recurring review, publish, and claim only. The activation route repeats the chain checks server-side, so a direct call cannot mark a partially configured node active.

## Local rig vs production — what is REAL vs SIMULATED (read this before trusting a local "proof")

The finalize→publish→claim loop can be exercised end-to-end in local dev, but the local rig
replaces the parts of the production plane that need hosted credentials with seeded / off-tree
substitutes. **The MECHANISM is real; the DATA and the git/App plumbing around it are simulated.**
A future agent must not read a green local run as a green production run. What each side does:

| Concern                                                                            | PRODUCTION (hosted)                                                                                                                                                    | LOCAL RIG (this repo, `scripts/e2e/*` + `.harness/`)                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain / wallet / money                                                             | Real Base 8453, owner wallet, real gas                                                                                                                                 | **SAME — real Base, real wallet, real gas.** NOT simulated. Governance is `toks2` (throwaway DAO `0x7DeD…`), never the prod Cogni DAO `0xF61c…`.                                                                                                                                              |
| DAO / token / distributor                                                          | Deployed per node at activation                                                                                                                                        | **SAME — real toks2 contracts on Base**, pre-deployed.                                                                                                                                                                                                                                        |
| Contracts / fold math / merkle proofs / claim                                      | Vendored `CumulativeMerkleDistributor` + scoped condition; fold builds the cumulative root                                                                             | **SAME code path — no forks.** The one exception is fork-verification (`verify-publish-condition-on-fork.ts`) which runs on an anvil Base fork (no gas) purely to prove `grantWithCondition`.                                                                                                 |
| repo-spec write-back (terminal activation record)                                  | operator **GitHub App** re-verifies distributor + CAS publisher authority, then commits `distributions.status: active` + `distributor_address` to the node repo (a PR) | **NO App creds locally.** The harness reads an off-tree fixture from `.harness/.cogni/repo-spec.yaml` (`COGNI_REPO_PATH`/`HARNESS_SPEC_DIR` in `.env.local`); this does not prove hosted activation write-back. **This is the single biggest divergence.**                                    |
| per-node distribution-config gateway (fold reads the finalizing node's governance) | worker calls the operator gateway (App-read of the node repo) → `emissionsHolderAddress` authoritative                                                                 | **No App-read locally** → `distributionConfigClient` is null (no `COGNI_NODE_ENDPOINTS`) → the fold uses the **baked** identity from `.harness`. The container now bakes `governance.emissions_holder` too, so the bug.5020 execute-guard still asserts on this path.                         |
| attribution receipts (what an epoch pays)                                          | real GitHub PR-merge receipts via webhooks                                                                                                                             | **Fabricated** — `seed-toks2.mts` inserts 3 `pr_merged` receipts, all attributed to the owner wallet. Allocations are synthetic.                                                                                                                                                              |
| worker DB role                                                                     | `app_service` (BYPASSRLS) via `DATABASE_SERVICE_URL`                                                                                                                   | SAME role, but **manually exported** (`DATABASE_URL=$DATABASE_SERVICE_URL`); on `app_user` the fold sees no selections ("no claimant allocations").                                                                                                                                           |
| epoch reseed                                                                       | epochs advance monotonically from live activity                                                                                                                        | **`TRUNCATE epochs` with `session_replication_role=replica`** to bypass the finalize-freeze trigger — a superuser hack, never a production op. Reseeds can leave **non-monotonic epoch ids** that don't line up with the on-chain published root — a live-DB footgun, not a product behavior. |

**Net for a future agent:** a local run proves the _contracts + fold + claim mechanism_ on real Base. It does NOT prove the _activation/record git-plane_ (App write-back) or the _gateway fold-resolution_ — those are stubbed by `.harness`. To prove those, run on candidate-a where the operator App is installed. Never put this rig config in `.context/` — it lives in `.env.local` + `.harness/` (git-ignored) and is documented here.

## What is proven (2026-08-15)

First real distribution shipped on Base for `toks2`: deploy `0xb8a2…7ceb` → finalize epoch 17 → fold (root `0x17bcc008…`, 12000e18, 1 leaf) → publish (mint+setRoot) → claim. Conservation held; distributor drained. The publish used the dead-end proposal mechanism (single-owner) — the loop is proven; the authorization model is what this spec replaces.

## Surfaces + invariants map

| surface             | file(s)                                                                                                                                                                         | invariant                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| deploy + activate   | `features/nodes/DistributionsCard.client.tsx`, `useDeployDistributor.ts`, `api/v1/nodes/[id]/activate-distributions/route.ts`                                                   | DAO_OWNS_DISTRIBUTOR, ONE_TIME_AUTHORIZATION, RECORD_IS_TERMINAL    |
| fold                | `services/scheduler-worker/src/activities/ledger.ts` (`buildAndPersistCumulativeDistribution`), `packages/aragon-osx/src/epoch-distribution-service.ts`                         | fold-never-undoes-finalize, CONSERVATION                            |
| authorize (1-time)  | `features/governance/hooks/useAuthorizePublishing.ts`, `packages/cogni-contracts/src/distribution-publish-condition/` (scoped condition, fork-verified), `lib/proposal-abis.ts` | ONE_TIME_AUTHORIZATION, MULTI_MEMBER_BY_DEFAULT (scoped grant)      |
| publish (per-epoch) | `features/governance/components/ExecuteDistributionPanel.tsx`, `useExecuteDistribution.ts` (direct `DAO.execute`, NO vote)                                                      | CAS_REPLAY_SAFE, ATOMIC_PUBLISH, no per-epoch vote                  |
| claim               | `features/governance/components/CumulativeClaimPanel.tsx`, `useCumulativeClaim.ts`, `api/v1/public/attribution/distribution/latest`                                             | PULL_NOT_PUSH, SINGLE_CLAIM_COVERS_ALL                              |
| ownership page      | `app/(app)/gov/holdings/`                                                                                                                                                       | show NODE tokenomics + viewer's FULL position, not just distributed |

## Related

- `docs/spec/tokenomics.md` — economics (budget policy, phases, enforcement progression). This doc is its distribution-mechanism sibling.
- `docs/spec/attribution-ledger.md` — steps 1–3 (epochs, selection, finalize, fold).
- Skill: `tokenomics-expert` — the one-pager entry point; links here.
- Work: story.5004 (activation unify) · story.5005 (one-time publish authorization) · task.5012 (test:chain) · task.5013 (agent-controlled wallet / Privy).
