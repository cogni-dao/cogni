// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
//
// P4 DE-RISK HARNESS for story.5021 (Walk) — Tier-1.5 (on-chain, no real money).
//
// THE QUESTION: Can the node-template DAO — with NO central wallet and NO
// pre-minted pile — mint an epoch's tokens DIRECTLY into a freshly-deployed
// stock Uniswap MerkleDistributor via a governance early-execute proposal, and
// can a contributor then claim (with double-claim blocked)?
//
// HOW THIS PROVES IT (all against a REAL Base-mainnet fork via anvil):
//   1. Build a 1-leaf merkle root with the REAL FROZEN Cogni builder
//      (`buildDaoTokenMerkleDistribution` / `hashDaoTokenClaimLeaf` from
//      packages/aragon-osx/src/token-distribution.ts). NOT reinvented here.
//   2. Deploy the REAL vendored stock Uniswap MerkleDistributor v1 artifact
//      (`MERKLE_DISTRIBUTOR_ABI` + `MERKLE_DISTRIBUTOR_BYTECODE` from
//      packages/cogni-contracts/src/merkle-distributor) — constructor (token, root).
//   3. Submit `mint(distributor, amount)` through the live TokenVoting plugin's
//      `createProposal(..., voteOption=Yes, tryEarlyExecution=true)` using the
//      REAL `TOKEN_VOTING_ABI` (nodes/operator/.../governance/lib/proposal-abis.ts)
//      and the REAL `GOVERNANCE_ERC20_ABI` mint signature (@cogni/node-shared),
//      impersonating the real on-chain holder (100% voting power, self-delegated).
//   4. Assert early-execute fired -> DAO.execute -> token.mint() ran STRAIGHT
//      into the distributor (supply grew by exactly the amount; no transfer hop).
//   5. Call distributor.claim(index, account, amount, proof), assert the
//      contributor received the tokens, the slot is claimed, and a DOUBLE-CLAIM
//      REVERTS.
//
// This is a TS re-author of the original (lost-then-recovered) run-spike.mjs:
// it imports the REAL production code instead of re-deriving the leaf hash,
// distributor artifact, and ABIs inline. Run it with tsx so the workspace's
// frozen source resolves directly (no build step) — see README.md.
//
//   anvil --fork-url https://mainnet.base.org --auto-impersonate --port 8545
//   pnpm dlx tsx spikes/walk-p4-mint-into-distributor/run-spike.ts

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
} from "viem";
import { base } from "viem/chains";

// ── REAL frozen Cogni leaf/root builder (no reinvented merkle math) ───────────
import {
  buildDaoTokenMerkleDistribution,
  hashDaoTokenClaimLeaf,
} from "../../packages/aragon-osx/src/token-distribution";
// ── REAL vendored stock Uniswap MerkleDistributor artifact ────────────────────
import {
  MERKLE_DISTRIBUTOR_ABI,
  MERKLE_DISTRIBUTOR_BYTECODE,
} from "../../packages/cogni-contracts/src/merkle-distributor";
// ── REAL GovernanceERC20 mint ABI (same module the publish-epoch client uses) ─
import { GOVERNANCE_ERC20_ABI } from "../../packages/node-shared/src/web3/node-formation/aragon-abi";
// ── REAL DAO TokenVoting ABI (the operator's proposal-abis, incl. ProposalCreated) ─
import { TOKEN_VOTING_ABI } from "../../nodes/operator/app/src/features/governance/lib/proposal-abis";

const RPC = process.env.SPIKE_RPC ?? "http://127.0.0.1:8545";

// ── Real node-template Base addresses (chain 8453), verified on-chain ──────────
const DAO = "0x717a747df71111a678202BfCD2E3B0081A9aeB56" as const;
const TOKEN = "0x0166Db3d42603E790Fb685059DcAa37087B032c8" as const; // GovernanceERC20
// TokenVoting plugin: discovered on-chain as the holder of EXECUTE_PERMISSION on
// the DAO (DAO Granted event, permissionId=keccak256("EXECUTE_PERMISSION")).
const PLUGIN = "0x6b8f7c9f18b33b8ad4e8b0710dd64a27388de6c9" as const;
// Genesis governance-token holder (100% voting power, self-delegated) — the
// authorized proposer. Discovered from the formation mint Transfer(from=0x0).
const HOLDER = "0x070075f1389ae1182abac722b36ca12285d0c949" as const;

// The contributor who will claim from the distributor.
const CONTRIBUTOR = "0xC0FFEe0000000000000000000000000000000001" as const;
// Epoch distribution amount: 100 tokens (18 decimals). Arbitrary; the point is
// that this is MINTED fresh, not moved from any pre-existing pile.
const DISTRIBUTION_AMOUNT = 100n * 10n ** 18n;

// enum IMajorityVoting.VoteOption { None=0, Abstain=1, Yes=2, No=3 }
const VOTE_YES = 2;

const log = (...a: unknown[]) => console.log(...a);
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`\n  x ASSERTION FAILED: ${msg}\n`);
    process.exit(1);
  }
  log(`  [ok] ${msg}`);
};

async function setBalance(addr: string, hexWei: string): Promise<void> {
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [addr, hexWei],
    }),
  });
}

async function main(): Promise<void> {
  const transport = http(RPC);
  const pub = createPublicClient({ chain: base, transport });

  log("======================================================================");
  log(" P4 HARNESS - mint epoch tokens into stock distributor via early-execute");
  log("======================================================================");
  const block = await pub.getBlockNumber();
  log(` Forked Base mainnet @ block ${block}`);
  log(` DAO          ${DAO}`);
  log(` Token        ${TOKEN}`);
  log(` Plugin       ${PLUGIN}`);
  log(` Holder       ${HOLDER}`);
  log("");

  // Wallet clients (anvil --auto-impersonate lets us send as any address).
  const holderWallet = createWalletClient({
    account: HOLDER,
    chain: base,
    transport,
  });
  const contributorWallet = createWalletClient({
    account: CONTRIBUTOR,
    chain: base,
    transport,
  });

  // Fund the impersonated senders with ETH for gas (anvil cheat).
  for (const addr of [HOLDER, CONTRIBUTOR]) {
    await setBalance(addr, "0x56BC75E2D63100000"); // 100 ETH
  }

  // ── Pre-state ───────────────────────────────────────────────────────────
  const supplyBefore = await pub.readContract({
    address: TOKEN,
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "totalSupply",
  });
  log("STEP 0 - pre-state");
  log(
    `  token.totalSupply BEFORE = ${supplyBefore} (== 1e18, the lone genesis token)`
  );
  ok(
    supplyBefore === 10n ** 18n,
    "no pre-minted pile exists (supply is exactly the 1 genesis token)"
  );

  // ── STEP 1: build the 1-leaf root via the REAL FROZEN Cogni builder ───────
  log(
    "\nSTEP 1 - build 1-leaf merkle root via REAL buildDaoTokenMerkleDistribution"
  );
  const distribution = buildDaoTokenMerkleDistribution({
    distributionId: "epoch-p4-harness",
    nodeId: "node-template",
    scopeId: "walk-p4",
    statementHash: "0xharness",
    chainId: 8453,
    tokenAddress: TOKEN,
    distributionAmount: DISTRIBUTION_AMOUNT,
    allocations: [
      {
        claimantKey: "contributor",
        account: CONTRIBUTOR,
        creditAmount: 1n,
      },
    ],
  });
  ok(distribution.leaves.length === 1, "frozen builder produced exactly 1 leaf");
  const leaf = distribution.leaves[0];
  const root = distribution.merkleRoot;
  const index = leaf.index;
  const amount = leaf.amount;
  const proof = leaf.proof; // empty for single leaf
  ok(
    amount === DISTRIBUTION_AMOUNT,
    "1-leaf allocation receives the full distribution amount"
  );
  // Cross-check: the builder's leaf hash equals hashDaoTokenClaimLeaf directly.
  ok(
    leaf.leafHash ===
      hashDaoTokenClaimLeaf(index, CONTRIBUTOR, DISTRIBUTION_AMOUNT),
    "leaf hash matches the frozen hashDaoTokenClaimLeaf(index, account, amount)"
  );
  log(`  leaf  = ${leaf.leafHash}`);
  log(`  root  = ${root}`);
  log(`  proof = [${proof.join(", ")}] (empty for single leaf)`);

  // ── STEP 2: deploy the REAL vendored stock Uniswap MerkleDistributor ──────
  log("\nSTEP 2 - deploy REAL stock Uniswap MerkleDistributor(token, root)");
  const deployHash = await holderWallet.deployContract({
    abi: MERKLE_DISTRIBUTOR_ABI,
    bytecode: MERKLE_DISTRIBUTOR_BYTECODE as `0x${string}`,
    args: [TOKEN, root],
  });
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const distributor = deployRcpt.contractAddress;
  ok(!!distributor, `distributor deployed @ ${distributor}`);
  if (!distributor) return;
  const boundToken = await pub.readContract({
    address: distributor,
    abi: MERKLE_DISTRIBUTOR_ABI,
    functionName: "token",
  });
  const boundRoot = await pub.readContract({
    address: distributor,
    abi: MERKLE_DISTRIBUTOR_ABI,
    functionName: "merkleRoot",
  });
  ok(
    boundToken.toLowerCase() === TOKEN.toLowerCase(),
    "distributor.token() == GovernanceERC20 (constructor binding)"
  );
  ok(
    boundRoot.toLowerCase() === root.toLowerCase(),
    "distributor.merkleRoot() == our FROZEN 1-leaf root"
  );

  const distBalBefore = await pub.readContract({
    address: TOKEN,
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "balanceOf",
    args: [distributor],
  });
  ok(
    distBalBefore === 0n,
    "distributor token balance BEFORE mint == 0 (empty, no pre-funding)"
  );

  // ── STEP 3: build mint(distributor, amount) action (REAL gov ABI) ─────────
  log("\nSTEP 3 - build the DAO action: token.mint(distributor, amount)");
  const mintCalldata = encodeFunctionData({
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "mint",
    args: [distributor, DISTRIBUTION_AMOUNT],
  });
  const actions = [{ to: TOKEN, value: 0n, data: mintCalldata }];
  log(`  action.to   = ${TOKEN} (GovernanceERC20)`);
  log(`  action.data = mint(${distributor}, ${DISTRIBUTION_AMOUNT})`);

  // ── STEP 4: createProposal with voteYes + tryEarlyExecution=true ──────────
  log(
    "\nSTEP 4 - createProposal(...) as the holder, voteYes + tryEarlyExecution=true"
  );
  // startDate=0 => "now" (contract treats 0 as block.timestamp);
  // endDate must satisfy minDuration (3600s).
  const now = (await pub.getBlock()).timestamp;
  const startDate = 0n;
  const endDate = now + 7200n;

  const proposalArgs = [
    "0x",
    actions,
    0n,
    startDate,
    endDate,
    VOTE_YES,
    true,
  ] as const;

  // Simulate first to surface any revert reason clearly. We do NOT trust the
  // returned id — in OSx 1.4 the authoritative id comes from ProposalCreated.
  try {
    await pub.simulateContract({
      address: PLUGIN,
      abi: TOKEN_VOTING_ABI,
      functionName: "createProposal",
      // biome-ignore lint/suspicious/noExplicitAny: viem tuple-arg typing on a runtime const
      args: proposalArgs as any,
      account: HOLDER,
    });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    console.error(
      "\n  x createProposal SIMULATION REVERTED:\n",
      err.shortMessage ?? err.message
    );
    throw e;
  }

  const propHash = await holderWallet.writeContract({
    address: PLUGIN,
    abi: TOKEN_VOTING_ABI,
    functionName: "createProposal",
    // biome-ignore lint/suspicious/noExplicitAny: viem tuple-arg typing on a runtime const
    args: proposalArgs as any,
  });
  const propRcpt = await pub.waitForTransactionReceipt({ hash: propHash });
  ok(propRcpt.status === "success", `createProposal tx mined: ${propHash}`);

  // PUBLISH_PROPOSAL_ID_FROM_EVENT: parse the authoritative id from the
  // ProposalCreated event (OSx 1.4 — the simulate() return is a different hash).
  let proposalId: bigint | undefined;
  for (const lg of propRcpt.logs) {
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
      // not the event we want
    }
  }
  ok(
    proposalId !== undefined,
    `parsed real proposalId from ProposalCreated event: ${proposalId}`
  );
  if (proposalId === undefined) return;

  // ── STEP 5: assert early-execute fired and minted into the distributor ────
  log("\nSTEP 5 - assert early-execute minted straight into the distributor");
  const prop = await pub.readContract({
    address: PLUGIN,
    abi: TOKEN_VOTING_ABI,
    functionName: "getProposal",
    args: [proposalId],
  });
  const executed = (prop as readonly unknown[])[1] as boolean;
  const tally = (prop as readonly unknown[])[3] as {
    abstain: bigint;
    yes: bigint;
    no: bigint;
  };
  log(`  proposal.executed = ${executed}`);
  log(`  tally yes/no/abstain = ${tally.yes}/${tally.no}/${tally.abstain}`);
  ok(
    executed === true,
    "proposal EARLY-EXECUTED in the same tx (no separate execute call)"
  );

  const supplyAfter = await pub.readContract({
    address: TOKEN,
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "totalSupply",
  });
  const distBalAfter = await pub.readContract({
    address: TOKEN,
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "balanceOf",
    args: [distributor],
  });
  log(`  token.totalSupply AFTER  = ${supplyAfter} (was ${supplyBefore})`);
  log(`  distributor balance AFTER = ${distBalAfter}`);
  ok(
    supplyAfter === supplyBefore + DISTRIBUTION_AMOUNT,
    "totalSupply increased by exactly the distribution amount (fresh MINT, not a transfer)"
  );
  ok(
    distBalAfter === DISTRIBUTION_AMOUNT,
    "tokens were minted STRAIGHT INTO the distributor (no central wallet hop)"
  );

  // ── STEP 6: contributor claims against the FROZEN root ────────────────────
  log("\nSTEP 6 - contributor claims from the distributor (FROZEN root)");
  const claimedBefore = await pub.readContract({
    address: distributor,
    abi: MERKLE_DISTRIBUTOR_ABI,
    functionName: "isClaimed",
    args: [BigInt(index)],
  });
  ok(claimedBefore === false, "isClaimed(0) == false before claim");

  const claimHash = await contributorWallet.writeContract({
    address: distributor,
    abi: MERKLE_DISTRIBUTOR_ABI,
    functionName: "claim",
    args: [BigInt(index), CONTRIBUTOR, amount, [...proof]],
    // Explicit gas: GovernanceERC20's _afterTokenTransfer runs ERC20Votes
    // checkpoint + delegation writes; viem's auto-estimate undershoots and the
    // OZ ReentrancyGuard's 63/64 sentry trips ReentrancySentryOOG. Real wallets
    // (and `cast`) pad the limit, so this is a harness artifact, not a
    // loop-shape blocker. 300k is comfortably above the ~185k actually used.
    gas: 300_000n,
  });
  const claimRcpt = await pub.waitForTransactionReceipt({ hash: claimHash });
  ok(claimRcpt.status === "success", `claim tx mined: ${claimHash}`);

  const contribBal = await pub.readContract({
    address: TOKEN,
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "balanceOf",
    args: [CONTRIBUTOR],
  });
  const claimedAfter = await pub.readContract({
    address: distributor,
    abi: MERKLE_DISTRIBUTOR_ABI,
    functionName: "isClaimed",
    args: [BigInt(index)],
  });
  ok(
    contribBal === DISTRIBUTION_AMOUNT,
    `contributor received exactly ${DISTRIBUTION_AMOUNT} tokens`
  );
  ok(claimedAfter === true, "isClaimed(0) == true after claim");

  // ── STEP 7: double-claim MUST revert ──────────────────────────────────────
  log(
    "\nSTEP 7 - double-claim must REVERT (Uniswap distributor: 'already claimed')"
  );
  let doubleClaimReverted = false;
  try {
    await pub.simulateContract({
      address: distributor,
      abi: MERKLE_DISTRIBUTOR_ABI,
      functionName: "claim",
      args: [BigInt(index), CONTRIBUTOR, amount, [...proof]],
      account: CONTRIBUTOR,
    });
  } catch {
    doubleClaimReverted = true;
  }
  ok(
    doubleClaimReverted,
    "second claim(0, ...) REVERTS — distributor blocks the double-claim"
  );
  const contribBalFinal = await pub.readContract({
    address: TOKEN,
    abi: GOVERNANCE_ERC20_ABI,
    functionName: "balanceOf",
    args: [CONTRIBUTOR],
  });
  ok(
    contribBalFinal === DISTRIBUTION_AMOUNT,
    "contributor balance unchanged after the reverted double-claim (no second payout)"
  );

  log("\n======================================================================");
  log(" RESULT: YES. The DAO minted an epoch's tokens directly into a stock");
  log(" Uniswap MerkleDistributor via a governance early-execute proposal -");
  log(" no central wallet, no pre-mint - the contributor claimed against the");
  log(" FROZEN root, and a double-claim reverts.");
  log("======================================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
