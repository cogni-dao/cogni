// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
//
// WALK E2E — full distribution proof in LOCAL DEV: sign → finalize → mint → claim.
//
// Proves Derek's Definition of Done end to end with ZERO prod risk and ZERO human
// friction: a contributor's attribution accrues, the ADMIN SIGNS that epoch's
// ledger (a real EIP-712 approver signature), the DAO MINTS the per-epoch delta
// into the ONE cumulative distributor, and the contributor CLAIMS the accrued
// tokens — a live sign→mint→claim, not green CI.
//
// WHAT IT DRIVES (full step discipline — all REAL product code, nothing faked):
//   seed review epoch (db:seed) → link ALICE/BEN wallets → deploy the vendored
//   1inch CumulativeMerkleDrop on an anvil Base-fork → transferOwnership(DAO) →
//   activate distributions in an OFF-TREE repo-spec → start the REAL host ledger
//   worker → compute finalAllocationSetHash with the SAME pure ledger functions
//   the app's /sign-data route uses → SIGN the EIP-712 with an anvil approver key
//   → start FinalizeEpochWorkflow directly on ledger-tasks (skips the app + SIWE)
//   → the worker verifies recover(sig)∈approvers[] and runs R3
//   buildAndPersistCumulativeDistribution → read the REAL persisted manifest →
//   DAO-impersonate mint(delta) + setMerkleRoot(root) on the fork → each linked
//   claimant claims (cumulative − claimed) → conservation asserts.
//
// PROD ISOLATION (guard-0, load-bearing): every on-chain WRITE targets the anvil
// fork at http://127.0.0.1:8545. The real Base RPC (EVM_RPC_URL) is used ONLY as
// anvil's --fork-url read source; this script never opens a viem client against
// it. The DB is the LOCAL dev postgres; the harness hard-aborts on any prod
// signal. The host ledger worker never sends an on-chain tx (the fold only
// BUILDS + persists the manifest).
//
//   # prerequisites (once): foundry (anvil) on PATH, `pnpm dev:infra` up.
//   # run:
//   pnpm tsx scripts/e2e/finalize-mint-claim.ts

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyReceiptWeightOverrides,
  buildEIP712TypedData,
  computeFinalClaimantAllocationSetHash,
  computeReceiptWeights,
  createValidatedAttributionStore,
  explodeToClaimants,
  toReviewSubjectOverrides,
} from "@cogni/attribution-ledger";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";
import {
  extractChainId,
  extractNodeId,
  extractScopeId,
  parseRepoSpec,
} from "@cogni/repo-spec";
import { Client, Connection } from "@temporalio/client";
import { sql } from "drizzle-orm";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
// REAL DAO TokenVoting ABI (the operator's proposal-abis).
import { TOKEN_VOTING_ABI } from "../../nodes/operator/app/src/features/governance/lib/proposal-abis";
// REAL vendored 1inch CumulativeMerkleDrop artifact (same bytecode the rig proved).
import {
  CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
  CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE,
} from "../../packages/cogni-contracts/src/cumulative-merkle-distributor";
// REAL GovernanceERC20 mint ABI (same module the publish-epoch client uses).
import { GOVERNANCE_ERC20_ABI } from "../../packages/node-shared/src/web3/node-formation/aragon-abi";
import { verifyCumulativeProof } from "./cumulative-merkle";

// ── constants ────────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const RPC = "http://127.0.0.1:8545"; // anvil fork — the ONLY on-chain write target
const TOKEN_BASE_UNITS = 10n ** 18n; // 1 credit → 1 whole token (matches ledger.ts)
const LEDGER_TASK_QUEUE = "ledger-tasks";

// Off-tree augmented repo-spec (distributions activated). NEVER edit the tracked
// .cogni/repo-spec.yaml — the host worker chdir's here to read this instead.
const SPEC_DIR = path.join(REPO_ROOT, ".context", "harness-run");

// Anvil well-known accounts. The approver's PRIVATE KEY is the ONLY key we need
// (for the off-chain EIP-712 signature). Every on-chain write uses impersonation.
const APPROVER = {
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const,
  privateKey:
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const,
};
// Contributor wallets we link to ALICE / BEN (seed linked users). Claimed via
// impersonation on the fork — no private key needed.
const ALICE = {
  userId: "d0000000-0000-4000-a000-000090000101",
  wallet: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const,
};
const BEN = {
  userId: "d0000000-0000-4000-a000-000090000102",
  wallet: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const,
};
const LINKED_WALLETS = new Set(
  [ALICE.wallet, BEN.wallet].map((w) => w.toLowerCase())
);

// REAL node-template Base addresses (chain 8453) — the proven mint path (rig #1920).
const DAO = "0x717a747df71111a678202BfCD2E3B0081A9aeB56" as const; // distributor owner + mint executor
const TOKEN = "0x0166Db3d42603E790Fb685059DcAa37087B032c8" as const; // GovernanceERC20
const PLUGIN = "0x6b8f7c9f18b33b8ad4e8b0710dd64a27388de6c9" as const; // TokenVoting
const HOLDER = "0x070075f1389ae1182abac722b36ca12285d0c949" as const; // 100% voter (deploy + propose)
const VOTE_YES = 2;

const log = (...a: unknown[]) => console.log(...a);
let failures = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    log(`  [ok] ${msg}`);
  } else {
    failures++;
    console.error(`  x  FAIL: ${msg}`);
  }
}

// ── anvil cheat helpers (write only to the fork) ───────────────────────────────
async function anvilRpc(method: string, params: unknown[]): Promise<unknown> {
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
  anvilRpc("anvil_setBalance", [addr, "0x56BC75E2D63100000"]); // 100 ETH
const impersonate = (addr: string) =>
  anvilRpc("anvil_impersonateAccount", [addr]);

// ── guard-0: refuse on any prod signal ─────────────────────────────────────────
function guard0(databaseUrl: string, forkUrl: string): void {
  log("STEP 0 — guard-0 preflight (prod-safety)");
  const dbHost = (() => {
    try {
      return new URL(databaseUrl).hostname;
    } catch {
      return "";
    }
  })();
  const localHosts = new Set(["localhost", "127.0.0.1", "postgres", "::1"]);
  if (!localHosts.has(dbHost)) {
    throw new Error(
      `guard-0 ABORT: DATABASE_URL host '${dbHost}' is not local {${[...localHosts].join(",")}}. Refusing to seed/finalize against a non-local DB.`
    );
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost):8545$/.test(RPC)) {
    throw new Error(
      `guard-0 ABORT: on-chain RPC ${RPC} is not a local anvil fork.`
    );
  }
  if (!forkUrl) {
    throw new Error(
      "guard-0 ABORT: EVM_RPC_URL is unset — needed as anvil's --fork-url read source."
    );
  }
  if (/127\.0\.0\.1|localhost/.test(forkUrl)) {
    throw new Error(
      `guard-0 ABORT: EVM_RPC_URL (${forkUrl}) points at localhost — expected a real Base RPC to fork from.`
    );
  }
  ok(true, `DATABASE_URL host is local (${dbHost})`);
  ok(true, `on-chain writes target the anvil fork only (${RPC})`);
  ok(true, "EVM_RPC_URL used ONLY as anvil --fork-url (never a client target)");
}

// ── augmented off-tree repo-spec (distributions activated) ─────────────────────
function writeAugmentedSpec(distributorAddress: string): {
  nodeId: string;
  scopeId: string;
  chainId: number;
} {
  const trackedSpecPath = path.join(REPO_ROOT, ".cogni", "repo-spec.yaml");
  const raw = readFileSync(trackedSpecPath, "utf8");
  const spec = parseRepoSpec(raw);
  const nodeId = extractNodeId(spec);
  const scopeId = extractScopeId(spec);
  const chainId = extractChainId(spec);

  // Text-level augmentation (preserve the tracked spec verbatim). We inject
  // token_contract + emissions_holder INTO the existing governance block and
  // append a distributions block, via targeted string ops (no YAML-writer dep).
  // extractDaoTokenDistributionConfig requires governance.token_contract +
  // governance.emissions_holder when distributions.status is active;
  // extractDistributorAddress reads distributions.distributor_address.
  let out = raw;
  // 1. add token_contract + emissions_holder under `governance:` (after its
  //    `chain_id:` line, which every governance block in this repo has).
  out = out.replace(
    /(^governance:[\s\S]*?\n {2}chain_id:.*\n)/m,
    (m) =>
      `${m}  token_contract: "${TOKEN}" # HARNESS: GovernanceERC20 (fork mint target)\n  emissions_holder: "${DAO}" # HARNESS: DAO-controlled emissions holder\n`
  );
  // 2. append the distributions block.
  out +=
    "\n# HARNESS-ONLY: activate distributions so the R3 cumulative build runs.\n" +
    "distributions:\n" +
    "  status: active\n" +
    `  distributor_address: "${distributorAddress}" # deployed on the anvil fork this run\n`;

  mkdirSync(path.join(SPEC_DIR, ".cogni"), { recursive: true });
  writeFileSync(path.join(SPEC_DIR, ".cogni", "repo-spec.yaml"), out, "utf8");
  // Sanity: the augmented spec must parse + expose the distributor.
  const reparsed = parseRepoSpec(out);
  if (extractChainId(reparsed) !== chainId) {
    throw new Error("augmented spec chainId drifted from the tracked spec");
  }
  return { nodeId, scopeId, chainId };
}

// ── stop the dockerized scheduler-worker (else it races us for ledger-tasks) ───
function stopDockerSchedulerWorker(): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(
      "docker",
      [
        "compose",
        "--env-file",
        ".env.local",
        "-f",
        "infra/compose/runtime/docker-compose.dev.yml",
        "stop",
        "scheduler-worker",
      ],
      { cwd: REPO_ROOT, stdio: "inherit" }
    );
    p.on("close", () => resolve());
    p.on("error", () => resolve()); // best-effort — compose may not manage it
  });
}

// ── spawn anvil forking Base ───────────────────────────────────────────────────
async function spawnAnvil(forkUrl: string): Promise<ChildProcess> {
  const anvil = spawn(
    "anvil",
    ["--fork-url", forkUrl, "--chain-id", "8453", "--port", "8545", "--silent"],
    { cwd: REPO_ROOT, stdio: "inherit" }
  );
  anvil.on("error", (e) => {
    console.error(
      "\n  x anvil failed to start. Install Foundry: `curl -L https://foundry.paradigm.xyz | bash && foundryup`\n",
      e
    );
  });
  // Wait for the fork to answer (chainId == 8453).
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const id = await anvilRpc("eth_chainId", []);
      if (typeof id === "string" && Number.parseInt(id, 16) === 8453)
        return anvil;
    } catch {
      /* not up yet */
    }
  }
  throw new Error("anvil did not come up on 127.0.0.1:8545 within 60s");
}

// ── spawn the REAL host ledger worker (augmented spec cwd) ─────────────────────
function spawnHostWorker(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["tsx", "scripts/e2e/ledger-worker-host.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HARNESS_SPEC_DIR: SPEC_DIR,
        // The worker's createAttributionContainer reads config.DATABASE_URL —
        // it must be the BYPASSRLS service role (else RLS hides epoch_selection
        // and the allocator finds no receipts). Prod feeds the service URL here.
        DATABASE_URL:
          process.env.DATABASE_SERVICE_URL ?? process.env.DATABASE_URL ?? "",
        // The ledger worker never touches EVM; pin it away from real Base anyway.
        EVM_RPC_URL: RPC,
        APP_ENV: "development",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let settled = false;
    child.stdout?.on("data", (buf: Buffer) => {
      const s = buf.toString();
      process.stdout.write(s);
      if (!settled && s.includes("HARNESS_LEDGER_WORKER_READY")) {
        settled = true;
        resolve(child);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`host worker exited early (code ${code})`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("host worker did not report READY within 90s"));
      }
    }, 90_000);
  });
}

/**
 * Mint `amount` straight into `distributor` via the REAL TokenVoting plugin's
 * createProposal(..., voteYes, tryEarlyExecution=true) — faithful to the
 * no-central-wallet design (the same path the rig proved for the first epoch).
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
  // biome-ignore lint/suspicious/noExplicitAny: viem tuple-arg typing on runtime const
  const args = ["0x", actions, 0n, 0n, now + 7200n, VOTE_YES, true] as any;
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
  if (prop[1] !== true) throw new Error("mint proposal did not early-execute");
  log(`     mint proposal #${proposalId} early-executed (tx ${propHash})`);
}

async function main(): Promise<void> {
  // The ledger reads (epoch_selection etc.) are RLS-gated — app_user sees zero
  // rows, so the allocator would find no receipts. The scheduler-worker runs as
  // the BYPASSRLS service role in prod; locally that's DATABASE_SERVICE_URL.
  const databaseUrl =
    process.env.DATABASE_SERVICE_URL ?? process.env.DATABASE_URL ?? "";
  const forkUrl = process.env.EVM_RPC_URL ?? "";
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const temporalNamespace =
    process.env.TEMPORAL_NAMESPACE ?? "cogni-production";

  log("======================================================================");
  log(
    " WALK E2E — sign → finalize → mint → claim (LOCAL DEV, anvil Base-fork)"
  );
  log("======================================================================");
  guard0(databaseUrl, forkUrl);

  const children: ChildProcess[] = [];
  const cleanup = () => {
    for (const c of children) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  const db = createServiceDbClient(databaseUrl);

  try {
    // ── STEP 1: find the seeded review epoch + link ALICE/BEN wallets ──────────
    log("\nSTEP 1 — locate seeded review epoch + link contributor wallets");
    const raw = readFileSync(
      path.join(REPO_ROOT, ".cogni", "repo-spec.yaml"),
      "utf8"
    );
    const scopeId = extractScopeId(parseRepoSpec(raw));
    const nodeId = extractNodeId(parseRepoSpec(raw));
    const store = createValidatedAttributionStore(
      new DrizzleAttributionAdapter(db, scopeId)
    );
    const epochs = await store.listEpochs(nodeId);
    const reviewEpoch = epochs.find(
      (e) => e.status === "review" && e.allocationAlgoRef
    );
    if (!reviewEpoch) {
      throw new Error(
        `no finalizable review epoch found (statuses: ${epochs.map((e) => `${e.id}=${e.status}`).join(", ")}). ` +
          "Run: SEED_APPROVERS=" +
          APPROVER.address +
          " pnpm db:seed"
      );
    }
    const epochId = reviewEpoch.id;
    ok(
      true,
      `review epoch #${epochId} (allocationAlgoRef=${reviewEpoch.allocationAlgoRef})`
    );

    // Verify the pinned approver is our anvil key (else the sig can't verify).
    if (
      !reviewEpoch.approvers?.some(
        (a) => a.toLowerCase() === APPROVER.address.toLowerCase()
      )
    ) {
      throw new Error(
        `epoch #${epochId} approvers ${JSON.stringify(reviewEpoch.approvers)} do not include the anvil approver ${APPROVER.address}. ` +
          `Re-seed with: SEED_APPROVERS=${APPROVER.address} pnpm db:seed`
      );
    }
    ok(true, `epoch approver set pins the anvil signer ${APPROVER.address}`);

    for (const c of [ALICE, BEN]) {
      await db.execute(
        sql`UPDATE users SET wallet_address = ${c.wallet} WHERE id = ${c.userId}`
      );
    }
    ok(true, `linked wallets: ALICE→${ALICE.wallet}  BEN→${BEN.wallet}`);

    // ── STEP 2: anvil fork + deploy distributor + transferOwnership(DAO) ───────
    log("\nSTEP 2 — anvil Base-fork + deploy CumulativeMerkleDrop + own→DAO");
    children.push(await spawnAnvil(forkUrl));
    const transport = http(RPC);
    const pub = createPublicClient({ chain: base, transport });
    ok(
      (await pub.getChainId()) === 8453,
      `forked Base mainnet @ block ${await pub.getBlockNumber()} (chain 8453)`
    );
    for (const a of [HOLDER, DAO, ALICE.wallet, BEN.wallet])
      await setBalance(a);
    for (const a of [HOLDER, DAO, ALICE.wallet, BEN.wallet])
      await impersonate(a);
    const holderWallet = createWalletClient({
      account: HOLDER,
      chain: base,
      transport,
    });
    const daoWallet = createWalletClient({
      account: DAO,
      chain: base,
      transport,
    });

    const deployHash = await holderWallet.deployContract({
      abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
      bytecode: CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE as `0x${string}`,
      args: [TOKEN],
    });
    const deployRcpt = await pub.waitForTransactionReceipt({
      hash: deployHash,
    });
    const distributor = deployRcpt.contractAddress as `0x${string}`;
    ok(
      !!distributor,
      `distributor deployed @ ${distributor} (tx ${deployHash})`
    );
    await pub.waitForTransactionReceipt({
      hash: await holderWallet.writeContract({
        address: distributor,
        abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        functionName: "transferOwnership",
        args: [DAO],
      }),
    });
    ok(
      (
        (await pub.readContract({
          address: distributor,
          abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
          functionName: "owner",
        })) as string
      ).toLowerCase() === DAO.toLowerCase(),
      "distributor.owner() == DAO"
    );

    // ── STEP 3: activate distributions off-tree + start host worker ───────────
    log(
      "\nSTEP 3 — write off-tree augmented repo-spec + start host ledger worker"
    );
    const ids = writeAugmentedSpec(distributor);
    ok(
      ids.nodeId === nodeId && ids.scopeId === scopeId,
      `augmented spec identity matches tracked spec (chain ${ids.chainId})`
    );
    await stopDockerSchedulerWorker();
    children.push(await spawnHostWorker());
    ok(true, "host ledger worker polling ledger-tasks (distributions ACTIVE)");

    // ── STEP 4: compute the hash the worker will recompute + SIGN (no SIWE) ────
    log(
      "\nSTEP 4 — compute finalAllocationSetHash (same pure fns as /sign-data) + SIGN"
    );
    const poolComponents = await store.getPoolComponentsForEpoch(epochId);
    const poolTotal = poolComponents.reduce((s, c) => s + c.amountCredits, 0n);
    const [lockedClaimants, selections, overrideRecords] = await Promise.all([
      store.loadLockedClaimants(epochId),
      store.getSelectedReceiptsForAllocation(epochId),
      store.getReviewSubjectOverridesForEpoch(epochId),
    ]);
    const rawWeights = computeReceiptWeights(
      reviewEpoch.allocationAlgoRef as string,
      selections,
      reviewEpoch.weightConfig
    );
    const overrides = toReviewSubjectOverrides(overrideRecords);
    const receiptWeights = applyReceiptWeightOverrides(rawWeights, overrides);
    const claimantAllocations = explodeToClaimants(
      receiptWeights,
      lockedClaimants,
      overrides
    );
    const finalAllocationSetHash =
      await computeFinalClaimantAllocationSetHash(claimantAllocations);
    const typedData = buildEIP712TypedData({
      nodeId,
      scopeId,
      epochId: epochId.toString(),
      finalAllocationSetHash,
      poolTotalCredits: poolTotal.toString(),
      chainId: ids.chainId,
    });
    const approverAccount = privateKeyToAccount(APPROVER.privateKey);
    const signature = await approverAccount.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
    ok(
      true,
      `signed EIP-712 (hash ${finalAllocationSetHash.slice(0, 14)}…, pool ${poolTotal})`
    );

    // ── STEP 5: start FinalizeEpochWorkflow directly on ledger-tasks ───────────
    log(
      "\nSTEP 5 — start FinalizeEpochWorkflow via Temporal (worker verifies the sig + runs R3)"
    );
    const connection = await Connection.connect({ address: temporalAddress });
    const client = new Client({ connection, namespace: temporalNamespace });
    const workflowId = `ledger-finalize-${scopeId}-${epochId.toString()}`;
    const handle = await client.workflow.start("FinalizeEpochWorkflow", {
      taskQueue: LEDGER_TASK_QUEUE,
      workflowId,
      args: [
        {
          epochId: epochId.toString(),
          signature,
          signerAddress: APPROVER.address,
        },
      ],
    });
    let workflowMintDelta: bigint | null = null;
    try {
      const result = (await handle.result()) as {
        cumulativeDistribution?: {
          mintDelta?: string;
          merkleRoot?: string;
        } | null;
      };
      if (result?.cumulativeDistribution?.mintDelta) {
        workflowMintDelta = BigInt(result.cumulativeDistribution.mintDelta);
      }
      ok(true, `FinalizeEpochWorkflow completed (workflowId ${workflowId})`);
    } catch (e) {
      throw new Error(
        `FinalizeEpochWorkflow FAILED — most likely the finalAllocationSetHash/sig did not match ` +
          `what the worker recomputed, or distributions were not activated. Underlying: ${(e as Error).message}`
      );
    } finally {
      await connection.close();
    }
    const finalized = await store.getEpoch(epochId);
    ok(
      finalized?.status === "finalized",
      `epoch #${epochId} status == finalized`
    );

    // ── STEP 6: read the REAL persisted manifest (do NOT rebuild the tree) ─────
    log(
      "\nSTEP 6 — read the persisted cumulative manifest + verify proofs off-chain"
    );
    const manifest = await store.getDistributionManifestForEpoch(epochId);
    if (!manifest)
      throw new Error(
        "no distribution manifest persisted — R3 fold did not run"
      );
    const leaves = await store.getDistributionLeavesForEpoch(epochId);
    ok(
      leaves.length > 0,
      `manifest persisted: root ${manifest.merkleRoot.slice(0, 14)}…, ${leaves.length} leaves`
    );
    ok(
      leaves.length === 2 &&
        leaves.every((l) => LINKED_WALLETS.has(l.account.toLowerCase())),
      "CONSERVATION: exactly 2 leaves, both are the LINKED wallets (unlinked excluded)"
    );
    for (const leaf of leaves) {
      ok(
        verifyCumulativeProof(
          leaf.leafHash as `0x${string}`,
          leaf.proof as `0x${string}`[],
          manifest.merkleRoot as `0x${string}`
        ),
        `proof verifies off-chain for ${leaf.account} (cumulative ${leaf.amount})`
      );
    }
    const cumulativeSum = leaves.reduce((s, l) => s + l.amount, 0n);
    const mintDelta = workflowMintDelta ?? manifest.distributionAmount;
    ok(
      mintDelta === cumulativeSum,
      `CONSERVATION: mintDelta ${mintDelta} == Σ(leaf cumulative) ${cumulativeSum} (epoch-1: delta==cumulative)`
    );
    // R3 mints ONLY wallet-resolved credits, never the full pool: unresolved
    // (unlinked) contributors' credits are excluded until they link a wallet.
    // So mintDelta strictly LESS THAN poolTotal×10^18 when any contributor is
    // unlinked — that gap IS the conservation guarantee.
    ok(
      mintDelta <= poolTotal * TOKEN_BASE_UNITS,
      `CONSERVATION: mintDelta ${mintDelta} ≤ poolTotal×10^18 ${poolTotal * TOKEN_BASE_UNITS} (unresolved credits NOT minted)`
    );

    // ── STEP 7: DAO mint(delta) + setMerkleRoot(root) on the fork ──────────────
    log(
      "\nSTEP 7 — DAO mint(delta) into distributor + setMerkleRoot(root) on the fork"
    );
    const bal = (who: string) =>
      pub.readContract({
        address: TOKEN,
        abi: GOVERNANCE_ERC20_ABI,
        functionName: "balanceOf",
        args: [who as `0x${string}`],
      }) as Promise<bigint>;
    const distBal0 = await bal(distributor);
    await daoEarlyExecuteMint(pub, holderWallet, distributor, mintDelta);
    ok(
      (await bal(distributor)) === distBal0 + mintDelta,
      `distributor funded with delta ${mintDelta}`
    );
    await pub.waitForTransactionReceipt({
      hash: await daoWallet.writeContract({
        address: distributor,
        abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        functionName: "setMerkleRoot",
        args: [manifest.merkleRoot as `0x${string}`],
      }),
    });
    ok(
      (
        (await pub.readContract({
          address: distributor,
          abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
          functionName: "merkleRoot",
        })) as string
      ).toLowerCase() === manifest.merkleRoot.toLowerCase(),
      "on-chain merkleRoot == persisted manifest root"
    );

    // ── STEP 8: each linked claimant claims (cumulative − claimed) ─────────────
    log(
      "\nSTEP 8 — contributors claim their accrued tokens from the distributor"
    );
    for (const leaf of leaves) {
      const account = leaf.account as `0x${string}`;
      const before = await bal(account);
      const claimant = createWalletClient({ account, chain: base, transport });
      await pub.waitForTransactionReceipt({
        hash: await claimant.writeContract({
          address: distributor,
          abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
          functionName: "claim",
          args: [
            account,
            leaf.amount,
            manifest.merkleRoot as `0x${string}`,
            leaf.proof as `0x${string}`[],
          ],
          gas: 300_000n,
        }),
      });
      const after = await bal(account);
      ok(
        after - before === leaf.amount,
        `${account} balance += cumulative ${leaf.amount} (${before} → ${after})`
      );
      const claimed = (await pub.readContract({
        address: distributor,
        abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        functionName: "cumulativeClaimed",
        args: [account],
      })) as bigint;
      ok(
        claimed === leaf.amount,
        `cumulativeClaimed[${account}] == ${leaf.amount}`
      );
    }
    ok(
      (await bal(distributor)) === 0n,
      "distributor fully drained (Σ claims == mintDelta — conservation)"
    );

    // ── SUMMARY ───────────────────────────────────────────────────────────────
    log(
      "\n======================================================================"
    );
    log(" SUMMARY");
    for (const leaf of leaves) {
      log(`   ${leaf.account}  claimed ${leaf.amount}  (${leaf.claimantKey})`);
    }
    log(`   mintDelta ${mintDelta}   merkleRoot ${manifest.merkleRoot}`);
    log(
      `   distributor ${manifest.distributorAddress}   token ${manifest.tokenAddress}`
    );
    log(
      "======================================================================"
    );
  } finally {
    cleanup();
  }

  if (failures > 0) {
    log(`\n RESULT: FAIL — ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  log(
    "\n RESULT: PASS — admin SIGNED the epoch, DAO MINTED the delta, contributors CLAIMED.\n" +
      "   The full sign→mint→claim distribution ran end-to-end against REAL product code\n" +
      "   (R3 finalize fold + persisted manifest), unlinked contributors excluded (conservation)."
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("\n harness error:", e);
  process.exit(1);
});
