// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/activate-distributions`
 * Purpose: Record distribution activation into the NODE'S OWN repo: write the Aragon GovernanceERC20
 *   token, DAO-controlled emissions holder, `distributions.status: active`, AND the ONE deployed
 *   cumulative Merkle distributor (address + chain + deploy tx) into `.cogni/repo-spec.yaml` through
 *   the cogni-operator GitHub App.
 * Scope: Bearer/session auth + owner-or-developer gating. The DISTRIBUTOR DEPLOY happens client-side
 *   (admin wallet, like payments activation) — see DistributionsCard.client.tsx: the wallet deploys
 *   the stock 1inch CumulativeMerkleDrop(token), transfers ownership to the DAO, then POSTs the
 *   deployed address + deploy tx here. This route VERIFIES on-chain that the distributor's token() is
 *   the node token and owner() is the DAO, verifies the token + DAO contracts exist, then records the
 *   activation in git. The DAO remains the GovernanceERC20 minter and owns setMerkleRoot; NO token
 *   supply is pre-minted and NO human custodies tokens. Existing DAO nodes can activate without
 *   replaying formation because tokenAddress may be supplied when the operator row lacks one.
 * Invariants:
 *   - CLIENT_DEPLOYS_DISTRIBUTOR: the ONE distributor is deployed by the admin wallet client-side;
 *     the server NEVER fires an on-chain tx — it only verifies + records the resulting address.
 *   - DAO_OWNS_DISTRIBUTOR: the recorded distributor's owner() MUST equal the DAO (ownership is
 *     transferred to the DAO right after deploy), and its token() MUST equal the node token.
 *   - DAO_IS_EMISSIONS_HOLDER: the emissions holder is the DAO contract unconditionally (the DAO is
 *     the GovernanceERC20 minter; it mints per-epoch into the distributor).
 *   - NO_BALANCE_GATE: activation never checks token inventory — nothing is pre-minted, so a zero
 *     balance is expected and correct.
 *   - IDEMPOTENT: if repo-spec already records a distributor address, the route surfaces it and does
 *     NOT require or expect a redeploy.
 *   - GH_APP_INSTALL_REQUIRED, NODE_SOVEREIGNTY (PR only; never force-push to node main).
 *   - SINGLE_HOME: targets the node's OWN repo (`NODE_MINT_OWNER`/slug), writes ONLY
 *     `.cogni/repo-spec.yaml`.
 *   - NO_BESPOKE_CONTRACTS: deploys the STOCK, vendored 1inch CumulativeMerkleDrop (ONE per node) —
 *     no custom contract is authored; pins the `1inch.cumulative-merkle-drop.v1` claim pattern.
 *   - OWNER_OR_DEVELOPER: node owner session OR `node.flight` authorizes activation.
 *   - NON_LINEAR_ACTIVATION: does not depend on payment activation and can run for already-active
 *     existing DAOs with a node repo.
 * Side-effects: IO (GitHub REST API, Postgres)
 * Surface: driven by the VISIBLE owner control `features/nodes/DistributionsCard.client.tsx` on the
 *   node page (not a hidden API); owners click "Activate distributions". `node.flight` lets a
 *   delegated agent exercise the same endpoint for candidate-a validation.
 * Links: src/adapters/server/vcs/github-repo-write.ts, src/features/nodes/DistributionsCard.client.tsx,
 *   docs/spec/tokenomics.md, task.0135
 * @public
 */

import { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
import { CHAINS } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { type Address, createPublicClient, getAddress, http } from "viem";
import { base, sepolia } from "viem/chains";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { resolveServiceDb } from "@/bootstrap/container";
import { withRootSpan } from "@/bootstrap/otel";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  createRequestContext,
  EVENT_NAMES,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE_ID = "v1.nodes.activate-distributions";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

// Map a NODE's chain id to its viem chain object. Distribution activation
// verifies an ARBITRARY node's token/DAO, so the chain is selected from the
// node row — NOT the operator's own governance config. Only BASE and SEPOLIA
// are supported on-chain. Chain ids come from the shared CHAINS registry (never
// hardcode chain ids — eslint no-restricted-syntax).
const VIEM_CHAINS_BY_ID: Record<number, typeof base | typeof sepolia> = {
  [CHAINS.BASE.chainId]: base,
  [CHAINS.SEPOLIA.chainId]: sepolia,
};

const ActivateDistributionsInput = z.object({
  tokenAddress: z.string().optional(),
  // Optional: the emissions holder is the DAO unconditionally. If supplied it
  // must equal the DAO; otherwise it defaults to node.daoAddress.
  emissionsHolderAddress: z.string().optional(),
  // R2: the client (admin wallet) deploys the ONE CumulativeMerkleDrop(token),
  // transfers ownership to the DAO, then POSTs the deployed address + deploy tx
  // here. The server VERIFIES token()==token & owner()==DAO on-chain, then
  // records it into repo-spec. Required for a fresh activation; on an idempotent
  // re-activation (address already in repo-spec) these may be omitted.
  distributorAddress: z.string().optional(),
  distributorDeployTx: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "invalid tx hash")
    .optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

function activationNodePayload(node: typeof nodes.$inferSelect) {
  return {
    id: node.id,
    slug: node.slug,
    status: node.status,
    tokenAddress: node.tokenAddress,
    repoUrl: node.repoUrl,
  };
}

function checksummedAddress(value: string): Address | null {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function canWriteDistributionActivation(status: NodeStatus): boolean {
  return ["published", "wallet_ready", "payments_ready", "active"].includes(
    status
  );
}

export async function POST(
  request: Request,
  routeArgs: RouteParams
): Promise<NextResponse> {
  return withRootSpan(
    "POST nodes.activate-distributions",
    { route_id: ROUTE_ID },
    async ({ traceId }) => {
      const ctx = createRequestContext({ baseLog, clock }, request, {
        routeId: ROUTE_ID,
        traceId,
      });
      return handleActivateDistributions(request, routeArgs, ctx);
    }
  );
}

async function handleActivateDistributions(
  request: Request,
  routeArgs: RouteParams,
  ctx: ReturnType<typeof createRequestContext>
): Promise<NextResponse> {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await routeArgs.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = ActivateDistributionsInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const env = serverEnv();
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    return NextResponse.json(
      {
        error: "operator not configured for repo write",
        reason: "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
      },
      { status: 503 }
    );
  }
  const mintOwner = env.NODE_MINT_OWNER;
  if (!mintOwner) {
    return NextResponse.json(
      {
        error: "operator not configured for node minting",
        reason: "NODE_MINT_OWNER required (env-scoped node-repo owner)",
      },
      { status: 503 }
    );
  }

  const db = resolveServiceDb();
  const existing = await db
    .select()
    .from(nodes)
    .where(nodeIdOrSlug(id))
    .limit(1);
  const node = existing[0];
  if (!node) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const isOwner = node.ownerUserId === sessionUser.id;
  if (!isOwner) {
    const gate = await resolveNodeAndAuthorize({
      id: node.id,
      userId: sessionUser.id,
      action: "node.flight",
    });
    if (!gate.ok) {
      const responseBody =
        gate.errorCode === "authz_unavailable"
          ? {
              error: "authorization not configured",
              errorCode: gate.errorCode,
            }
          : { error: "not authorized", errorCode: gate.errorCode };
      return NextResponse.json(responseBody, { status: gate.status });
    }
  }

  const status = node.status as NodeStatus;
  if (!canWriteDistributionActivation(status)) {
    return NextResponse.json(
      {
        error: "invalid state for distribution activation",
        reason:
          "distribution activation requires an existing node repo; it does not replay DAO formation",
        currentStatus: node.status,
      },
      { status: 409 }
    );
  }

  const tokenAddress = checksummedAddress(
    parsed.data.tokenAddress ?? node.tokenAddress ?? ""
  );
  const daoAddress = checksummedAddress(node.daoAddress ?? "");
  if (!daoAddress) {
    return NextResponse.json(
      {
        error: "node missing DAO address for distribution activation",
        reason:
          "distribution activation requires the DAO contract as the emissions holder",
      },
      { status: 409 }
    );
  }
  // The emissions holder is the DAO unconditionally (the DAO is the minter). If
  // the caller supplied one it must equal the DAO; otherwise default to the DAO.
  const emissionsHolderAddress = daoAddress;
  if (!tokenAddress) {
    return NextResponse.json(
      {
        error: "invalid distribution activation address",
        hasTokenAddress: false,
      },
      { status: 400 }
    );
  }
  if (
    parsed.data.tokenAddress &&
    node.tokenAddress &&
    tokenAddress.toLowerCase() !==
      checksummedAddress(node.tokenAddress)?.toLowerCase()
  ) {
    return NextResponse.json(
      {
        error: "token address mismatch",
        reason:
          "request tokenAddress does not match the node's verified GovernanceERC20",
      },
      { status: 409 }
    );
  }
  if (parsed.data.emissionsHolderAddress) {
    const requestedHolder = checksummedAddress(
      parsed.data.emissionsHolderAddress
    );
    if (
      !requestedHolder ||
      requestedHolder.toLowerCase() !== daoAddress.toLowerCase()
    ) {
      return NextResponse.json(
        {
          error: "unsupported emissions holder",
          reason:
            "the emissions holder must be the DAO contract itself (the DAO is the GovernanceERC20 minter)",
          expectedEmissionsHolder: daoAddress,
        },
        { status: 409 }
      );
    }
  }
  if (!env.EVM_RPC_URL) {
    return NextResponse.json(
      {
        error: "operator not configured for distribution verification",
        reason: "EVM_RPC_URL required for on-chain contract existence checks",
      },
      { status: 503 }
    );
  }

  // Verify the ARBITRARY node's token/DAO against ITS OWN chain — not the
  // operator's governance config. Select the viem chain from node.chainId.
  const nodeChainId = node.chainId;
  const viemChain = nodeChainId == null ? null : VIEM_CHAINS_BY_ID[nodeChainId];
  if (nodeChainId == null || !viemChain) {
    return NextResponse.json(
      {
        error: "unsupported chain for distribution verification",
        reason:
          "node.chainId is null or not a supported chain (8453 base, 11155111 sepolia)",
        chainId: node.chainId,
      },
      { status: 409 }
    );
  }

  ctx.log.info(
    {
      event: "node.distribution_activation.requested",
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      nodeId: node.id,
      slug: node.slug,
      tokenAddress,
      emissionsHolderAddress,
      chainId: node.chainId,
    },
    "activate-distributions: activation requested"
  );

  const writer = createNodeRepoWriter(env);

  // IDEMPOTENT: if repo-spec already records a distributor, surface it and do NOT
  // ask the client to redeploy. The ONE distributor is deployed once per node.
  let recordedDistributor: string | null;
  try {
    recordedDistributor = await writer.getRecordedDistributorAddress({
      owner: mintOwner,
      repo: node.slug,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: "failed to read recorded distributor", reason },
      { status: 502 }
    );
  }
  if (recordedDistributor) {
    ctx.log.info(
      {
        event: "node.distribution_activation.already_deployed",
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId: node.id,
        slug: node.slug,
        distributorAddress: recordedDistributor,
      },
      "activate-distributions: distributor already recorded — no redeploy"
    );
    return NextResponse.json({
      node: activationNodePayload(node),
      activation: { status: "already_deployed" },
      distributorAddress: recordedDistributor,
    });
  }

  // A fresh activation REQUIRES the client to have deployed the distributor and
  // transferred ownership to the DAO (client-side admin-wallet tx). The server
  // never deploys; it only verifies + records. Signal "deploy first" via 428.
  const distributorAddress = checksummedAddress(
    parsed.data.distributorAddress ?? ""
  );
  if (!distributorAddress || !parsed.data.distributorDeployTx) {
    return NextResponse.json(
      {
        error: "distributor deploy required",
        reason:
          "no distributor recorded yet; deploy CumulativeMerkleDrop(token) client-side, transferOwnership to the DAO, then resubmit with distributorAddress + distributorDeployTx",
        needsDeploy: true,
        tokenAddress,
        daoAddress,
        chainId: node.chainId,
      },
      { status: 428 }
    );
  }

  try {
    const client = createPublicClient({
      chain: viemChain,
      transport: http(env.EVM_RPC_URL),
    });
    // METADATA_ONLY / NO_BALANCE_GATE: verify the token + DAO contracts merely
    // exist on-chain. Nothing is pre-minted (the DAO mints per-epoch into the
    // distributor), so a zero token balance is expected — never gate on it.
    const [tokenCode, holderCode, distributorCode] = await Promise.all([
      client.getBytecode({ address: tokenAddress }),
      client.getBytecode({ address: emissionsHolderAddress }),
      client.getBytecode({ address: distributorAddress }),
    ]);
    if (!tokenCode || tokenCode === "0x") {
      return NextResponse.json(
        { error: "token contract missing", tokenAddress },
        { status: 409 }
      );
    }
    if (!holderCode || holderCode === "0x") {
      return NextResponse.json(
        { error: "emissions holder contract missing", emissionsHolderAddress },
        { status: 409 }
      );
    }
    if (!distributorCode || distributorCode === "0x") {
      return NextResponse.json(
        { error: "distributor contract missing", distributorAddress },
        { status: 409 }
      );
    }
    // DAO_OWNS_DISTRIBUTOR: the deployed distributor must be bound to the node
    // token and owned by the DAO (ownership transferred right after deploy).
    const [distributorToken, distributorOwner] = await Promise.all([
      client.readContract({
        address: distributorAddress,
        abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        functionName: "token",
      }),
      client.readContract({
        address: distributorAddress,
        abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        functionName: "owner",
      }),
    ]);
    ctx.log.info(
      {
        event: "node.distribution_activation.verified",
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId: node.id,
        slug: node.slug,
        chainId: node.chainId,
        hasTokenCode: Boolean(tokenCode && tokenCode !== "0x"),
        hasHolderCode: Boolean(holderCode && holderCode !== "0x"),
        hasDistributorCode: Boolean(
          distributorCode && distributorCode !== "0x"
        ),
        distributorToken,
        distributorOwner,
        daoIsEmissionsHolder: true,
      },
      "activate-distributions: verification result"
    );
    if (
      (distributorToken as string).toLowerCase() !== tokenAddress.toLowerCase()
    ) {
      return NextResponse.json(
        {
          error: "distributor token mismatch",
          reason:
            "distributor.token() does not equal the node's GovernanceERC20 token",
          distributorToken,
          expected: tokenAddress,
        },
        { status: 409 }
      );
    }
    if (
      (distributorOwner as string).toLowerCase() !== daoAddress.toLowerCase()
    ) {
      return NextResponse.json(
        {
          error: "distributor not owned by DAO",
          reason:
            "distributor.owner() must equal the DAO — transferOwnership to the DAO before recording",
          distributorOwner,
          expectedOwner: daoAddress,
        },
        { status: 409 }
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    ctx.log.error(
      {
        event: "node.distribution_activation.verify_failed",
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId: node.id,
        slug: node.slug,
        chainId: node.chainId,
        tokenAddress,
        emissionsHolderAddress,
        distributorAddress,
        err: reason,
        stack: err instanceof Error ? err.stack : undefined,
      },
      "activate-distributions: on-chain verification failed"
    );
    return NextResponse.json(
      { error: "distribution activation verification failed", reason },
      { status: 502 }
    );
  }

  let result: Awaited<ReturnType<typeof writer.openDistributionActivationPr>>;
  try {
    result = await writer.openDistributionActivationPr({
      owner: mintOwner,
      repo: node.slug,
      slug: node.slug,
      tokenAddress,
      emissionsHolderAddress,
      distributorAddress,
      distributorDeployTx: parsed.data.distributorDeployTx,
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const reason = err instanceof Error ? err.message : "unknown";
    ctx.log.error(
      {
        event: "node.distribution_activation.write_failed",
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId: node.id,
        slug: node.slug,
        err: reason,
        stack: err instanceof Error ? err.stack : undefined,
      },
      "activate-distributions: write-back failed"
    );
    return NextResponse.json(
      { error: "distribution activation write-back failed", reason },
      { status: typeof status === "number" ? status : 502 }
    );
  }

  ctx.log.info(
    {
      event: EVENT_NAMES.NODE_DISTRIBUTION_ACTIVATION_COMPLETE,
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      nodeId: node.id,
      slug: node.slug,
      chainId: node.chainId,
      status: result.status,
      prNumber: "prNumber" in result ? result.prNumber : undefined,
    },
    "activate-distributions: write result"
  );

  return NextResponse.json({
    node: activationNodePayload(node),
    activation: result,
    distributorAddress,
  });
}
