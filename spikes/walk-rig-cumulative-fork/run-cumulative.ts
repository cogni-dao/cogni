// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
//
// WALK RIG — CUMULATIVE distributor e2e proof (Tier-1.5, on-chain, NO real money).
//
// Proves the CUMULATIVE recurring-reward loop end-to-end against a REAL Base-
// mainnet fork (anvil --fork-url), using:
//   - the REAL node-template DAO + GovernanceERC20 on Base (chain 8453),
//   - the REAL vendored 1inch CumulativeMerkleDrop bytecode/ABI
//     (packages/cogni-contracts/src/cumulative-merkle-distributor),
//   - a 1inch-compatible sorted-pair merkle tree (cumulative-merkle.ts).
//
// THE WHOLE POINT (vs the one-shot Uniswap distributor proven in walk-p4):
//   ONE distributor per node serves EVERY epoch. Per epoch the owner calls
//   setMerkleRoot(newCumulativeRoot) and the DAO mints only the DELTA. A claim
//   pays out `cumulativeAmount - cumulativeClaimed[account]`.
//
// LOOP PROVEN:
//   EPOCH 1: deploy distributor(token) -> transferOwnership(DAO) ->
//            DAO mints delta1 into distributor (real governance early-execute) ->
//            owner setMerkleRoot(root1) -> A & B claim cumulative1 ->
//            balances increase by cumulative1; 2nd claim is a no-op/reverts.
//   EPOCH 2: DAO mints delta2 into distributor -> owner setMerkleRoot(root2)
//            (root2 has A's HIGHER cumulative) -> A claims -> A receives ONLY
//            the DELTA (cumulative2 - cumulative1). <-- the cumulative property.
//
// PROD-ISOLATION: every write tx targets http://127.0.0.1:8545 (the anvil fork).
// The prod RPC (.env.local EVM_RPC_URL) is used ONLY as anvil's --fork-url read
// source — this script never opens a client against it. See RIG.md.
//
//   # start the fork (reads EVM_RPC_URL purely as fork source):
//   bash spikes/walk-rig-cumulative-fork/start-fork.sh
//   # run the proof:
//   SPIKE_RPC=http://127.0.0.1:8545 \
//     pnpm dlx tsx spikes/walk-rig-cumulative-fork/run-cumulative.ts

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
} from "viem";
import { base } from "viem/chains";

// ── REAL vendored 1inch CumulativeMerkleDrop artifact ─────────────────────────
import {
  CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
  CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE,
} from "../../packages/cogni-contracts/src/cumulative-merkle-distributor";
// ── REAL GovernanceERC20 mint ABI (same module the publish-epoch client uses) ─
import { GOVERNANCE_ERC20_ABI } from "../../packages/node-shared/src/web3/node-formation/aragon-abi";
// ── REAL DAO TokenVoting ABI (the operator's proposal-abis) ───────────────────
import { TOKEN_VOTING_ABI } from "../../nodes/operator/app/src/features/governance/lib/proposal-abis";
// ── 1inch-compatible cumulative merkle tree (sorted-pair, OZ-compatible) ───────
import {
  buildCumulativeTree,
  verifyCumulativeProof,
} from "./cumulative-merkle";

const RPC = process.env.SPIKE_RPC ?? "http://127.0.0.1:8545";

// Minimal OSx DAO.execute ABI — the action-executor a passed proposal calls.
// DAO.execute(bytes32 _callId, Action[] _actions, uint256 _allowFailureMap).
const DAO_EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_callId", type: "bytes32" },
      {
        name: "_actions",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "_allowFailureMap", type: "uint256" },
    ],
    outputs: [
      { name: "", type: "bytes[]" },
      { name: "", type: "uint256" },
    ],
  },
] as const;

// SAFETY: refuse to run against anything but a local fork.
if (!/(127\.0\.0\.1|localhost)/.test(RPC)) {
  console.error(
    `\n  x REFUSING TO RUN: SPIKE_RPC=${RPC} is not a local anvil fork.\n` +
      "    This rig only writes to http://127.0.0.1:8545.\n"
  );
  process.exit(1);
}

// ── Real node-template Base addresses (chain 8453), verified on-chain ──────────
const DAO = "0x717a747df71111a678202BfCD2E3B0081A9aeB56" as const;
const TOKEN = "0x0166Db3d42603E790Fb685059DcAa37087B032c8" as const; // GovernanceERC20
const PLUGIN = "0x6b8f7c9f18b33b8ad4e8b0710dd64a27388de6c9" as const; // TokenVoting
const HOLDER = "0x070075f1389ae1182abac722b36ca12285d0c949" as const; // 100% voter

// Two contributor accounts to make the merkle tree non-trivial (≥2 leaves).
const ACCOUNT_A = "0xc0ffee0000000000000000000000000000000001" as const;
const ACCOUNT_B = "0xc0ffee0000000000000000000000000000000002" as const;

// enum IMajorityVoting.VoteOption { None=0, Abstain=1, Yes=2, No=3 }
const VOTE_YES = 2;

// Epoch amounts (18 decimals). Cumulative semantics:
//   epoch 1: A cumulative = 60,  B cumulative = 40   (delta minted = 100)
//   epoch 2: A cumulative = 100, B cumulative = 40   (delta minted = 40; A +40, B +0)
const A_CUM_1 = 60n * 10n ** 18n;
const B_CUM_1 = 40n * 10n ** 18n;
const A_CUM_2 = 100n * 10n ** 18n; // A earned 40 more in epoch 2
const B_CUM_2 = 40n * 10n ** 18n; // B earned nothing new

const DELTA_1 = A_CUM_1 + B_CUM_1; // 100 — fresh mint for epoch 1
const DELTA_2 = A_CUM_2 + B_CUM_2 - DELTA_1; // 40 — fresh mint for epoch 2

const log = (...a: unknown[]) => console.log(...a);
let failures = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++;
    console.error(`  x FAIL: ${msg}`);
  } else {
    log(`  [ok] ${msg}`);
  }
};

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}
const setBalance = (addr: string) =>
  rpc("anvil_setBalance", [addr, "0x56BC75E2D63100000"]); // 100 ETH
const impersonate = (addr: string) =>
  rpc("anvil_impersonateAccount", [addr]);

async function main(): Promise<void> {
  const transport = http(RPC);
  const pub = createPublicClient({ chain: base, transport });

  log("======================================================================");
  log(" WALK RIG — CUMULATIVE distributor e2e (1inch CumulativeMerkleDrop)");
  log("======================================================================");
  const block = await pub.getBlockNumber();
  log(` Forked Base mainnet @ block ${block} (chain ${await pub.getChainId()})`);
  log(` RPC          ${RPC}  (writes go ONLY here — the fork)`);
  log(` DAO          ${DAO}`);
  log(` Token        ${TOKEN} (GovernanceERC20)`);
  log(` Plugin       ${PLUGIN} (TokenVoting)`);
  log(` Holder       ${HOLDER} (100% voting power)`);
  log(` Account A    ${ACCOUNT_A}`);
  log(` Account B    ${ACCOUNT_B}`);
  log("");

  // Fund + impersonate the senders (anvil cheats; never touches prod).
  for (const a of [HOLDER, ACCOUNT_A, ACCOUNT_B, DAO]) await setBalance(a);
  for (const a of [HOLDER, ACCOUNT_A, ACCOUNT_B, DAO]) await impersonate(a);

  const holderWallet = createWalletClient({ account: HOLDER, chain: base, transport });
  const aWallet = createWalletClient({ account: ACCOUNT_A, chain: base, transport });
  const bWallet = createWalletClient({ account: ACCOUNT_B, chain: base, transport });
  // The DAO itself, impersonated, is the distributor owner (setMerkleRoot).
  const daoWallet = createWalletClient({ account: DAO, chain: base, transport });

  const bal = (who: string) =>
    pub.readContract({
      address: TOKEN,
      abi: GOVERNANCE_ERC20_ABI,
      functionName: "balanceOf",
      args: [who as `0x${string}`],
    }) as Promise<bigint>;
  const cumClaimed = (dist: `0x${string}`, who: string) =>
    pub.readContract({
      address: dist,
      abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
      functionName: "cumulativeClaimed",
      args: [who as `0x${string}`],
    }) as Promise<bigint>;

  // ── STEP 1: deploy the REAL vendored CumulativeMerkleDrop(token) ────────────
  log("STEP 1 — deploy REAL 1inch CumulativeMerkleDrop(token)");
  const deployHash = await holderWallet.deployContract({
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    bytecode: CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE as `0x${string}`,
    args: [TOKEN], // constructor(address token_) — owner := msg.sender (HOLDER)
  });
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const distributor = deployRcpt.contractAddress as `0x${string}`;
  ok(!!distributor, `distributor deployed @ ${distributor}`);
  log(`     deploy tx ${deployHash}`);

  const boundToken = (await pub.readContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "token",
  })) as string;
  ok(
    boundToken.toLowerCase() === TOKEN.toLowerCase(),
    "distributor.token() == GovernanceERC20"
  );
  const owner0 = (await pub.readContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "owner",
  })) as string;
  ok(owner0.toLowerCase() === HOLDER.toLowerCase(), "deployer is initial owner");

  // ── STEP 2: transferOwnership(distributor) -> the DAO ───────────────────────
  log("\nSTEP 2 — transferOwnership(distributor) -> DAO");
  const toHash = await holderWallet.writeContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "transferOwnership",
    args: [DAO],
  });
  await pub.waitForTransactionReceipt({ hash: toHash });
  const owner1 = (await pub.readContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "owner",
  })) as string;
  ok(owner1.toLowerCase() === DAO.toLowerCase(), "distributor.owner() == DAO");
  log(`     transferOwnership tx ${toHash}`);

  // ──────────────────────────────── EPOCH 1 ──────────────────────────────────
  log("\n================== EPOCH 1 ==================");
  const supply0 = (await pub.readContract({
    address: TOKEN,
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "totalSupply",
  })) as bigint;
  const distBal0 = await bal(distributor);

  // 1a. DAO mints DELTA_1 into the distributor via REAL governance early-execute.
  log(`\nEPOCH1 a — DAO early-execute mint(distributor, ${DELTA_1}) [DELTA]`);
  await daoEarlyExecuteMint(
    pub,
    holderWallet,
    distributor,
    DELTA_1
  );
  const distBal1 = await bal(distributor);
  const supply1 = (await pub.readContract({
    address: TOKEN,
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "totalSupply",
  })) as bigint;
  ok(
    distBal1 === distBal0 + DELTA_1,
    `distributor funded with delta1 = ${DELTA_1} (mint straight in, no wallet hop)`
  );
  ok(
    supply1 === supply0 + DELTA_1,
    "totalSupply grew by exactly delta1 (fresh mint)"
  );

  // 1b. Build cumulative tree for epoch 1 and setMerkleRoot as owner (the DAO).
  log("\nEPOCH1 b — build cumulative tree (A,B) + setMerkleRoot(root1) as DAO");
  const tree1 = buildCumulativeTree([
    { account: ACCOUNT_A, cumulativeAmount: A_CUM_1 },
    { account: ACCOUNT_B, cumulativeAmount: B_CUM_1 },
  ]);
  log(`     root1 = ${tree1.root}`);
  for (const lf of tree1.leaves) {
    ok(
      verifyCumulativeProof(lf.leafHash, lf.proof, tree1.root),
      `off-chain proof verifies for ${lf.account} (cum=${lf.cumulativeAmount})`
    );
  }
  const sr1 = await daoWallet.writeContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "setMerkleRoot",
    args: [tree1.root],
  });
  await pub.waitForTransactionReceipt({ hash: sr1 });
  const onchainRoot1 = (await pub.readContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "merkleRoot",
  })) as string;
  ok(onchainRoot1.toLowerCase() === tree1.root.toLowerCase(), "on-chain merkleRoot == root1");
  log(`     setMerkleRoot tx ${sr1}`);

  // 1c. A claims cumulative1; assert balance += A_CUM_1.
  log("\nEPOCH1 c — A claims cumulative1, then B claims cumulative1");
  const aLeaf1 = tree1.leaves.find((l) => l.account === ACCOUNT_A)!;
  const bLeaf1 = tree1.leaves.find((l) => l.account === ACCOUNT_B)!;
  const aBalBefore = await bal(ACCOUNT_A);
  const aClaim1 = await aWallet.writeContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "claim",
    args: [ACCOUNT_A, A_CUM_1, tree1.root, aLeaf1.proof],
    gas: 300_000n, // GovernanceERC20 _afterTokenTransfer checkpointing pad
  });
  await pub.waitForTransactionReceipt({ hash: aClaim1 });
  const aBalAfter1 = await bal(ACCOUNT_A);
  ok(
    aBalAfter1 === aBalBefore + A_CUM_1,
    `A balance += cumulative1 (${A_CUM_1}): ${aBalBefore} -> ${aBalAfter1}`
  );
  ok((await cumClaimed(distributor, ACCOUNT_A)) === A_CUM_1, "cumulativeClaimed[A] == A_CUM_1");
  log(`     A claim1 tx ${aClaim1}`);

  const bClaim1 = await bWallet.writeContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "claim",
    args: [ACCOUNT_B, B_CUM_1, tree1.root, bLeaf1.proof],
    gas: 300_000n,
  });
  await pub.waitForTransactionReceipt({ hash: bClaim1 });
  ok((await bal(ACCOUNT_B)) === B_CUM_1, `B balance == cumulative1 (${B_CUM_1})`);
  log(`     B claim1 tx ${bClaim1}`);

  // 1d. A double-claim against root1 must be a no-op/revert (NothingToClaim).
  log("\nEPOCH1 d — A re-claims cumulative1 (must REVERT NothingToClaim)");
  let dbl1Reverted = false;
  let dbl1Reason = "";
  try {
    await pub.simulateContract({
      address: distributor,
      abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
      functionName: "claim",
      args: [ACCOUNT_A, A_CUM_1, tree1.root, aLeaf1.proof],
      account: ACCOUNT_A,
    });
  } catch (e) {
    dbl1Reverted = true;
    dbl1Reason = (e as { shortMessage?: string }).shortMessage ?? "revert";
  }
  ok(dbl1Reverted, `2nd claim of same cumulative REVERTS (${dbl1Reason})`);
  ok(
    (await bal(ACCOUNT_A)) === aBalAfter1,
    "A balance unchanged after reverted double-claim (no second payout)"
  );

  // ──────────────────────────────── EPOCH 2 ──────────────────────────────────
  log("\n================== EPOCH 2 ==================");
  log(" (A earned 40 more; B earned nothing. ONE distributor, NEW root, DELTA mint.)");

  // 2a. DAO mints DELTA_2 (only the new earnings) into the SAME distributor.
  //
  // SURPRISE (documented in RIG.md): we DON'T reuse the *full vote* early-execute
  // path for epoch 2. OSx TokenVoting's participation gate (`minVotingPower`) is
  // a percentage of TOTAL TOKEN SUPPLY at the proposal's snapshot block. Epoch
  // 1's mint of 100 tokens INTO THE DISTRIBUTOR (which never delegates → 0
  // voting power) inflated total supply from ~1e18 to ~101e18, so a fresh epoch-2
  // proposal's minVotingPower jumps to ~50.5e18 while the lone holder still has
  // only 1e18 of voting power → participation can never be met → early-execute
  // is blocked. This is a real GOVERNANCE-PARTICIPATION quirk, ORTHOGONAL to the
  // cumulative distributor under test (and a genuine loop-shape finding: minting
  // non-delegated tokens dilutes future participation).
  //
  // We fund epoch 2's delta the way an APPROVED proposal ultimately does it: by
  // executing the mint action through the DAO. We impersonate the TokenVoting
  // PLUGIN (which holds EXECUTE_PERMISSION on the DAO, verified on-chain) and
  // call DAO.execute([mint(distributor, delta2)]) — identical on-chain effect to
  // a passed-then-executed proposal, just without re-running the vote tally that
  // the participation quirk would block.
  log(`\nEPOCH2 a — DAO.execute(mint(distributor, ${DELTA_2})) via plugin (see RIG.md)`);
  const distBalBeforeE2 = await bal(distributor);
  await daoExecuteMint(pub, distributor, DELTA_2);
  const distBalAfterE2 = await bal(distributor);
  ok(
    distBalAfterE2 === distBalBeforeE2 + DELTA_2,
    `distributor funded with delta2 = ${DELTA_2} only (not the full cumulative)`
  );

  // 2b. New cumulative root (A=100, B=40) -> setMerkleRoot(root2) as DAO.
  log("\nEPOCH2 b — setMerkleRoot(root2) on the SAME distributor (mutable root)");
  const tree2 = buildCumulativeTree([
    { account: ACCOUNT_A, cumulativeAmount: A_CUM_2 },
    { account: ACCOUNT_B, cumulativeAmount: B_CUM_2 },
  ]);
  log(`     root2 = ${tree2.root}`);
  ok(tree2.root.toLowerCase() !== tree1.root.toLowerCase(), "root2 != root1 (root is mutable)");
  const sr2 = await daoWallet.writeContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "setMerkleRoot",
    args: [tree2.root],
  });
  await pub.waitForTransactionReceipt({ hash: sr2 });
  log(`     setMerkleRoot tx ${sr2}`);

  // 2c. A claims root2 cumulative -> receives ONLY the delta (cum2 - cum1).
  log("\nEPOCH2 c — A claims cumulative2; receives ONLY the DELTA (cum2 - claimed)");
  const aLeaf2 = tree2.leaves.find((l) => l.account === ACCOUNT_A)!;
  const aBalBeforeE2 = await bal(ACCOUNT_A);
  const claimedBeforeE2 = await cumClaimed(distributor, ACCOUNT_A);
  const expectedDelta = A_CUM_2 - claimedBeforeE2;
  const aClaim2 = await aWallet.writeContract({
    address: distributor,
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    functionName: "claim",
    args: [ACCOUNT_A, A_CUM_2, tree2.root, aLeaf2.proof],
    gas: 300_000n,
  });
  await pub.waitForTransactionReceipt({ hash: aClaim2 });
  const aBalAfterE2 = await bal(ACCOUNT_A);
  ok(
    aBalAfterE2 - aBalBeforeE2 === expectedDelta,
    `A received ONLY the delta = ${expectedDelta} (= cum2 ${A_CUM_2} - already-claimed ${claimedBeforeE2})`
  );
  ok(
    aBalAfterE2 === A_CUM_2,
    `A total balance now == full cumulative2 = ${A_CUM_2} (${aBalBeforeE2} + ${expectedDelta})`
  );
  ok(
    (await cumClaimed(distributor, ACCOUNT_A)) === A_CUM_2,
    "cumulativeClaimed[A] advanced to A_CUM_2"
  );
  log(`     A claim2 tx ${aClaim2}`);

  // 2d. B has nothing new -> claiming the unchanged cumulative MUST revert.
  log("\nEPOCH2 d — B claims unchanged cumulative (must REVERT NothingToClaim)");
  const bLeaf2 = tree2.leaves.find((l) => l.account === ACCOUNT_B)!;
  let bE2Reverted = false;
  let bE2Reason = "";
  try {
    await pub.simulateContract({
      address: distributor,
      abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
      functionName: "claim",
      args: [ACCOUNT_B, B_CUM_2, tree2.root, bLeaf2.proof],
      account: ACCOUNT_B,
    });
  } catch (e) {
    bE2Reverted = true;
    bE2Reason = (e as { shortMessage?: string }).shortMessage ?? "revert";
  }
  ok(bE2Reverted, `B claim with no new earnings REVERTS (${bE2Reason})`);
  ok((await bal(ACCOUNT_B)) === B_CUM_1, "B balance unchanged (still cumulative1)");

  // ── SUMMARY ─────────────────────────────────────────────────────────────────
  log("\n======================================================================");
  log(" SUMMARY (final balances)");
  log(`   Account A : ${await bal(ACCOUNT_A)}   (cumulative2 = ${A_CUM_2})`);
  log(`   Account B : ${await bal(ACCOUNT_B)}   (cumulative  = ${B_CUM_1})`);
  log(`   distributor leftover : ${await bal(distributor)}`);
  log("======================================================================");
  if (failures > 0) {
    log(`\n RESULT: FAIL — ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  log("\n RESULT: PASS — ONE 1inch CumulativeMerkleDrop served TWO epochs:");
  log("   • root is mutable (setMerkleRoot per epoch, owner=DAO),");
  log("   • DAO minted only the DELTA each epoch (no central wallet/pre-mint),");
  log("   • epoch-2 claim paid out ONLY (cumulative − alreadyClaimed),");
  log("   • stale/no-new-earnings claims revert. This is the cumulative loop.");
}

/**
 * Mint `amount` straight into `distributor` via the REAL TokenVoting plugin's
 * createProposal(..., voteYes, tryEarlyExecution=true) — faithful to the
 * no-central-wallet design (same path proven in walk-p4).
 */
async function daoEarlyExecuteMint(
  pub: ReturnType<typeof createPublicClient>,
  holderWallet: ReturnType<typeof createWalletClient>,
  distributor: `0x${string}`,
  amount: bigint
): Promise<void> {
  const mintCalldata = encodeFunctionData({
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "mint",
    args: [distributor, amount],
  });
  const actions = [{ to: TOKEN, value: 0n, data: mintCalldata }];
  const now = (await pub.getBlock()).timestamp;
  const proposalArgs = ["0x", actions, 0n, 0n, now + 7200n, VOTE_YES, true] as const;

  // biome-ignore lint/suspicious/noExplicitAny: viem tuple-arg typing on runtime const
  const args = proposalArgs as any;
  await pub.simulateContract({
    address: PLUGIN,
    abi: TOKEN_VOTING_ABI,
    functionName: "createProposal",
    args,
    account: HOLDER,
  });
  const propHash = await holderWallet.writeContract({
    address: PLUGIN,
    abi: TOKEN_VOTING_ABI,
    functionName: "createProposal",
    args,
    // biome-ignore lint/suspicious/noExplicitAny: viem chain typing on runtime client
  } as any);
  const rcpt = await pub.waitForTransactionReceipt({ hash: propHash });

  // Confirm early-execute fired (parse ProposalCreated -> getProposal.executed).
  let proposalId: bigint | undefined;
  for (const lg of rcpt.logs) {
    if (lg.address.toLowerCase() !== PLUGIN.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({
        abi: TOKEN_VOTING_ABI,
        data: lg.data,
        topics: lg.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (ev.eventName === "ProposalCreated") {
        proposalId = (ev.args as { proposalId: bigint }).proposalId;
        break;
      }
    } catch {
      /* not the event */
    }
  }
  if (proposalId === undefined) throw new Error("no ProposalCreated event");
  const prop = (await pub.readContract({
    address: PLUGIN,
    abi: TOKEN_VOTING_ABI,
    functionName: "getProposal",
    args: [proposalId],
  })) as readonly unknown[];
  if (prop[1] !== true) {
    throw new Error("proposal did not early-execute");
  }
  log(`     mint proposal #${proposalId} early-executed in tx ${propHash}`);
}

/**
 * Execute `mint(distributor, amount)` THROUGH the DAO — the same on-chain effect
 * a passed-and-executed governance proposal has. Impersonates the TokenVoting
 * plugin (holder of EXECUTE_PERMISSION on the DAO) and calls DAO.execute. Used
 * for epoch 2 to sidestep the participation-inflation quirk (see RIG.md).
 */
async function daoExecuteMint(
  pub: ReturnType<typeof createPublicClient>,
  distributor: `0x${string}`,
  amount: bigint
): Promise<void> {
  await setBalance(PLUGIN);
  await impersonate(PLUGIN);
  const pluginWallet = createWalletClient({
    account: PLUGIN,
    chain: base,
    transport: http(RPC),
  });
  const mintCalldata = encodeFunctionData({
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "mint",
    args: [distributor, amount],
  });
  const callId =
    "0x0000000000000000000000000000000000000000000000000000000000000002" as const;
  const execHash = await pluginWallet.writeContract({
    address: DAO,
    abi: DAO_EXECUTE_ABI,
    functionName: "execute",
    args: [callId, [{ to: TOKEN, value: 0n, data: mintCalldata }], 0n],
    gas: 400_000n,
    // biome-ignore lint/suspicious/noExplicitAny: viem chain typing on runtime client
  } as any);
  const rcpt = await pub.waitForTransactionReceipt({ hash: execHash });
  if (rcpt.status !== "success") {
    throw new Error(`DAO.execute mint reverted (tx ${execHash})`);
  }
  log(`     DAO.execute mint tx ${execHash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
