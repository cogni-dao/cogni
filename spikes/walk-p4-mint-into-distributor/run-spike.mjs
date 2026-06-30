// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
//
// P4 DE-RISK SPIKE for story.5021 (Walk).
//
// THE QUESTION: Can the node-template DAO — with NO central wallet and NO
// pre-minted pile — mint an epoch's tokens DIRECTLY into a freshly-deployed
// stock Uniswap MerkleDistributor via a governance early-execute proposal, and
// can a contributor then claim?
//
// HOW THIS PROVES IT (all against a REAL Base-mainnet fork via anvil):
//   1. Deploy the stock Uniswap MerkleDistributor v1 (constructor (token, root))
//      with the GovernanceERC20 token + a 1-leaf merkle root.
//   2. Build a mint(distributor, amount) action and submit it through the
//      node-template DAO's TokenVoting plugin createProposal(..., voteYes,
//      tryEarlyExecution=true), impersonating the real on-chain governance-token
//      holder (the genesis EOA that holds 100% voting power).
//   3. Assert early-execute fired -> DAO.execute -> token.mint() ran straight
//      into the distributor (NO central wallet, NO pre-mint).
//   4. Call distributor.claim(index, account, amount, proof) and assert the
//      contributor received the tokens.
//
// Leaf format is the FROZEN Cogni format from
//   packages/aragon-osx/src/token-distribution.ts:
//   keccak256(abi.encodePacked(uint256 index, address account, uint256 amount))
//
// Run:  node spikes/walk-p4-mint-into-distributor/run-spike.mjs
// Requires: anvil already forking Base mainnet on http://127.0.0.1:8545
//   anvil --fork-url https://mainnet.base.org --auto-impersonate --port 8545

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  encodePacked,
  http,
  keccak256,
  parseAbi,
} from "viem";
import { base } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SPIKE_RPC ?? "http://127.0.0.1:8545";

// ── Real node-template Base addresses (chain 8453), verified on-chain ──────────
const DAO = "0x717a747df71111a678202BfCD2E3B0081A9aeB56";
const TOKEN = "0x0166Db3d42603E790Fb685059DcAa37087B032c8"; // GovernanceERC20
// TokenVoting plugin: discovered on-chain as the holder of EXECUTE_PERMISSION on
// the DAO (DAO Granted event, permissionId=keccak256("EXECUTE_PERMISSION")).
const PLUGIN = "0x6b8f7c9f18b33b8ad4e8b0710dd64a27388de6c9";
// Genesis governance-token holder (100% voting power, self-delegated) — the
// authorized proposer. Discovered from the formation mint Transfer(from=0x0).
const HOLDER = "0x070075f1389ae1182abac722b36ca12285d0c949";

// The contributor who will claim from the distributor.
const CONTRIBUTOR = "0xC0FFEe0000000000000000000000000000000001";
// Epoch distribution amount: 100 tokens (18 decimals). Arbitrary; the point is
// that this is MINTED fresh, not moved from any pre-existing pile.
const DISTRIBUTION_AMOUNT = 100n * 10n ** 18n;

// ── Load the stock Uniswap MerkleDistributor artifact (npm @1.0.1) ─────────────
const merkle = JSON.parse(
  readFileSync(join(__dirname, "artifacts", "MerkleDistributor.json"), "utf8")
);
const MERKLE_ABI = merkle.abi;
const MERKLE_BYTECODE = merkle.bytecode;

// ── ABIs ───────────────────────────────────────────────────────────────────
const TOKEN_VOTING_ABI = parseAbi([
  "struct Action { address to; uint256 value; bytes data; }",
  "function createProposal(bytes _metadata, Action[] _actions, uint256 _allowFailureMap, uint64 _startDate, uint64 _endDate, uint8 _voteOption, bool _tryEarlyExecution) returns (uint256 proposalId)",
  "function getProposal(uint256 _proposalId) view returns (bool open, bool executed, (uint8 votingMode, uint32 supportThreshold, uint64 startDate, uint64 endDate, uint64 snapshotBlock, uint256 minVotingPower) parameters, (uint256 abstain, uint256 yes, uint256 no) tally, (address to, uint256 value, bytes data)[] actions, uint256 allowFailureMap)",
]);
// SURPRISE (de-risk finding): in OSx 1.4 TokenVoting the on-chain proposalId is
// a HASH, NOT the value returned by an eth_call simulation against a forked
// state. The authoritative id comes from the ProposalCreated event. We parse it
// from the receipt logs rather than trusting the simulate() return.
const PROPOSAL_CREATED_ABI = parseAbi([
  "event ProposalCreated(uint256 indexed proposalId, address indexed creator, uint64 startDate, uint64 endDate, bytes metadata, (address to, uint256 value, bytes data)[] actions, uint256 allowFailureMap)",
]);
const TOKEN_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const DISTRIBUTOR_ABI = parseAbi([
  "function claim(uint256 index, address account, uint256 amount, bytes32[] merkleProof)",
  "function isClaimed(uint256 index) view returns (bool)",
  "function token() view returns (address)",
  "function merkleRoot() view returns (bytes32)",
]);

// ── Cogni FROZEN leaf format (token-distribution.ts) ─────────────────────────
function hashDaoTokenClaimLeaf(index, account, amount) {
  return keccak256(
    encodePacked(["uint256", "address", "uint256"], [BigInt(index), account, amount])
  );
}

const log = (...a) => console.log(...a);
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`\n  x ASSERTION FAILED: ${msg}\n`);
    process.exit(1);
  }
  log(`  [ok] ${msg}`);
};

async function main() {
  const transport = http(RPC);
  const pub = createPublicClient({ chain: base, transport });

  log("======================================================================");
  log(" P4 SPIKE - mint epoch tokens into stock distributor via early-execute");
  log("======================================================================");
  const block = await pub.getBlockNumber();
  log(` Forked Base mainnet @ block ${block}`);
  log(` DAO          ${DAO}`);
  log(` Token        ${TOKEN}`);
  log(` Plugin       ${PLUGIN}`);
  log(` Holder       ${HOLDER}`);
  log("");

  // Wallet clients (anvil --auto-impersonate lets us send as any address).
  const holderWallet = createWalletClient({ account: HOLDER, chain: base, transport });
  const contributorWallet = createWalletClient({ account: CONTRIBUTOR, chain: base, transport });

  // Fund the impersonated senders with ETH for gas (anvil cheat).
  for (const addr of [HOLDER, CONTRIBUTOR]) {
    await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setBalance",
        params: [addr, "0x56BC75E2D63100000"], // 100 ETH
      }),
    });
  }

  // ── Pre-state ───────────────────────────────────────────────────────────
  const supplyBefore = await pub.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName: "totalSupply" });
  log("STEP 0 - pre-state");
  log(`  token.totalSupply BEFORE = ${supplyBefore} (== 1e18, the lone genesis token)`);
  ok(supplyBefore === 10n ** 18n, "no pre-minted pile exists (supply is exactly the 1 genesis token)");

  // ── STEP 1: build the 1-leaf merkle root (frozen Cogni format) ────────────
  log("\nSTEP 1 - build 1-leaf merkle root (Cogni frozen leaf format)");
  const index = 0;
  const leaf = hashDaoTokenClaimLeaf(index, CONTRIBUTOR, DISTRIBUTION_AMOUNT);
  const tree = SimpleMerkleTree.of([leaf]);
  const root = tree.root;
  const proof = tree.getProof(0); // empty for a 1-leaf tree
  log(`  leaf  = ${leaf}`);
  log(`  root  = ${root}`);
  log(`  proof = [${proof.join(", ")}] (empty for single leaf)`);

  // ── STEP 2: deploy the STOCK Uniswap MerkleDistributor (token, root) ──────
  log("\nSTEP 2 - deploy stock Uniswap MerkleDistributor(token, root)");
  const deployHash = await holderWallet.deployContract({
    abi: MERKLE_ABI,
    bytecode: MERKLE_BYTECODE,
    args: [TOKEN, root],
  });
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const distributor = deployRcpt.contractAddress;
  ok(!!distributor, `distributor deployed @ ${distributor}`);
  const boundToken = await pub.readContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: "token" });
  const boundRoot = await pub.readContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: "merkleRoot" });
  ok(boundToken.toLowerCase() === TOKEN.toLowerCase(), "distributor.token() == GovernanceERC20 (constructor binding)");
  ok(boundRoot.toLowerCase() === root.toLowerCase(), "distributor.merkleRoot() == our 1-leaf root");

  const distBalBefore = await pub.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName: "balanceOf", args: [distributor] });
  ok(distBalBefore === 0n, "distributor token balance BEFORE mint == 0 (empty, no pre-funding)");

  // ── STEP 3: build mint(distributor, amount) action ────────────────────────
  log("\nSTEP 3 - build the DAO action: token.mint(distributor, amount)");
  const mintCalldata = encodeFunctionData({
    abi: TOKEN_ABI,
    functionName: "mint",
    args: [distributor, DISTRIBUTION_AMOUNT],
  });
  const actions = [{ to: TOKEN, value: 0n, data: mintCalldata }];
  log(`  action.to   = ${TOKEN} (GovernanceERC20)`);
  log(`  action.data = mint(${distributor}, ${DISTRIBUTION_AMOUNT})`);

  // ── STEP 4: createProposal with voteYes + tryEarlyExecution=true ──────────
  log("\nSTEP 4 - createProposal(...) as the holder, voteYes + tryEarlyExecution=true");
  // startDate=0 => "now"; endDate must satisfy minDuration (3600s).
  const now = (await pub.getBlock()).timestamp;
  const startDate = 0n; // contract treats 0 as block.timestamp
  const endDate = now + 7200n; // > minDuration
  const VOTE_YES = 2; // enum VoteOption { None=0, Abstain=1, Yes=2, No=3 }

  const proposalArgs = ["0x", actions, 0n, startDate, endDate, VOTE_YES, true];

  // Simulate first to surface any revert reason clearly. (We do NOT trust the
  // returned id — see PROPOSAL_CREATED_ABI note above.)
  try {
    await pub.simulateContract({
      address: PLUGIN,
      abi: TOKEN_VOTING_ABI,
      functionName: "createProposal",
      args: proposalArgs,
      account: HOLDER,
    });
  } catch (e) {
    console.error("\n  x createProposal SIMULATION REVERTED:\n", e.shortMessage ?? e.message);
    throw e;
  }

  const propHash = await holderWallet.writeContract({
    address: PLUGIN,
    abi: TOKEN_VOTING_ABI,
    functionName: "createProposal",
    args: proposalArgs,
  });
  const propRcpt = await pub.waitForTransactionReceipt({ hash: propHash });
  ok(propRcpt.status === "success", `createProposal tx mined: ${propHash}`);

  // Parse the authoritative proposalId from the ProposalCreated event.
  let proposalId;
  for (const lg of propRcpt.logs) {
    if (lg.address.toLowerCase() !== PLUGIN.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: PROPOSAL_CREATED_ABI, ...lg });
      if (ev.eventName === "ProposalCreated") {
        proposalId = ev.args.proposalId;
        break;
      }
    } catch {
      // not the event we want
    }
  }
  ok(proposalId !== undefined, `parsed real proposalId from ProposalCreated event: ${proposalId}`);

  // ── STEP 5: assert early-execute fired and minted into the distributor ────
  log("\nSTEP 5 - assert early-execute minted straight into the distributor");
  const prop = await pub.readContract({
    address: PLUGIN,
    abi: TOKEN_VOTING_ABI,
    functionName: "getProposal",
    args: [proposalId],
  });
  const executed = prop[1];
  const tally = prop[3];
  log(`  proposal.executed = ${executed}`);
  log(`  tally yes/no/abstain = ${tally.yes}/${tally.no}/${tally.abstain}`);
  ok(executed === true, "proposal EARLY-EXECUTED in the same tx (no separate execute call)");

  const supplyAfter = await pub.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName: "totalSupply" });
  const distBalAfter = await pub.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName: "balanceOf", args: [distributor] });
  log(`  token.totalSupply AFTER  = ${supplyAfter} (was ${supplyBefore})`);
  log(`  distributor balance AFTER = ${distBalAfter}`);
  ok(supplyAfter === supplyBefore + DISTRIBUTION_AMOUNT, "totalSupply increased by exactly the distribution amount (fresh MINT, not a transfer)");
  ok(distBalAfter === DISTRIBUTION_AMOUNT, "tokens were minted STRAIGHT INTO the distributor (no central wallet hop)");

  // ── STEP 6: contributor claims ────────────────────────────────────────────
  log("\nSTEP 6 - contributor claims from the distributor");
  const claimedBefore = await pub.readContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: "isClaimed", args: [BigInt(index)] });
  ok(claimedBefore === false, "isClaimed(0) == false before claim");

  const claimHash = await contributorWallet.writeContract({
    address: distributor,
    abi: DISTRIBUTOR_ABI,
    functionName: "claim",
    args: [BigInt(index), CONTRIBUTOR, DISTRIBUTION_AMOUNT, proof],
    // Explicit gas: GovernanceERC20's _afterTokenTransfer runs ERC20Votes
    // checkpoint + delegation writes; viem's auto-estimate undershoots and the
    // OZ ReentrancyGuard's 63/64 sentry trips ReentrancySentryOOG. Real wallets
    // (and `cast`) pad the limit, so this is a harness artifact, not a
    // loop-shape blocker. 300k is comfortably above the ~185k actually used.
    gas: 300_000n,
  });
  const claimRcpt = await pub.waitForTransactionReceipt({ hash: claimHash });
  ok(claimRcpt.status === "success", `claim tx mined: ${claimHash}`);

  const contribBal = await pub.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName: "balanceOf", args: [CONTRIBUTOR] });
  const claimedAfter = await pub.readContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: "isClaimed", args: [BigInt(index)] });
  ok(contribBal === DISTRIBUTION_AMOUNT, `contributor received exactly ${DISTRIBUTION_AMOUNT} tokens`);
  ok(claimedAfter === true, "isClaimed(0) == true after claim (double-claim blocked)");

  log("\n======================================================================");
  log(" RESULT: YES. The DAO minted an epoch's tokens directly into a stock");
  log(" Uniswap MerkleDistributor via a governance early-execute proposal -");
  log(" no central wallet, no pre-mint - and the contributor claimed them.");
  log("======================================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
