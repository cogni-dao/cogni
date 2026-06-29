// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/activate-distributions`
 * Purpose: Open the distribution-activation PR into the NODE'S OWN repo: write the Aragon
 *   GovernanceERC20 token, DAO-controlled emissions holder, and `distributions.status: active` into
 *   `.cogni/repo-spec.yaml` through the cogni-operator GitHub App.
 * Scope: Bearer/session auth + owner-or-developer gating. The caller supplies on-chain addresses;
 *   this route verifies the V0 path (emissions holder is the DAO contract and it holds token
 *   inventory), then records the activation in git. Existing DAO nodes can activate without
 *   replaying formation because tokenAddress may be supplied when the operator row lacks one.
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED, NODE_SOVEREIGNTY (PR only; never force-push to node main).
 *   - SINGLE_HOME: targets the node's OWN repo (`NODE_MINT_OWNER`/slug), writes ONLY
 *     `.cogni/repo-spec.yaml`.
 *   - NO_BESPOKE_CONTRACTS: pins Uniswap MerkleDistributor v1 claim pattern; does not deploy a
 *     custom distributor.
 *   - OWNER_OR_DEVELOPER: node owner session OR `node.flight` authorizes activation.
 *   - NON_LINEAR_ACTIVATION: does not depend on payment activation and can run for already-active
 *     existing DAOs with a node repo.
 * Side-effects: IO (GitHub REST API, Postgres)
 * Links: src/adapters/server/vcs/github-repo-write.ts, docs/spec/tokenomics.md, task.0135
 * @public
 */

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
import { ERC20_ABI } from "@/shared/web3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE_ID = "v1.nodes.activate-distributions";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

// Map a NODE's chain id to its viem chain object. Distribution activation
// verifies an ARBITRARY node's token/DAO, so the chain is selected from the
// node row — NOT the operator's own governance config. Only BASE (8453) and
// SEPOLIA (11155111) are supported on-chain.
const VIEM_CHAINS_BY_ID: Record<number, typeof base | typeof sepolia> = {
  8453: base,
  11155111: sepolia,
};

const ActivateDistributionsInput = z.object({
  tokenAddress: z.string().optional(),
  emissionsHolderAddress: z.string(),
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
  const emissionsHolderAddress = checksummedAddress(
    parsed.data.emissionsHolderAddress
  );
  const daoAddress = checksummedAddress(node.daoAddress ?? "");
  if (!tokenAddress || !emissionsHolderAddress) {
    return NextResponse.json(
      {
        error: "invalid distribution activation address",
        hasTokenAddress: Boolean(tokenAddress),
        hasEmissionsHolder: Boolean(emissionsHolderAddress),
      },
      { status: 400 }
    );
  }
  if (!daoAddress) {
    return NextResponse.json(
      {
        error: "node missing DAO address for distribution activation",
        reason:
          "V0 distribution activation requires the DAO contract as the emissions holder",
      },
      { status: 409 }
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
  if (emissionsHolderAddress.toLowerCase() !== daoAddress.toLowerCase()) {
    return NextResponse.json(
      {
        error: "unsupported emissions holder",
        reason:
          "V0 distribution activation uses the DAO contract itself as the DAO-controlled emissions holder",
        expectedEmissionsHolder: daoAddress,
      },
      { status: 409 }
    );
  }
  if (!env.EVM_RPC_URL) {
    return NextResponse.json(
      {
        error: "operator not configured for distribution verification",
        reason:
          "EVM_RPC_URL required for on-chain token inventory verification",
      },
      { status: 503 }
    );
  }

  // Verify the ARBITRARY node's token/DAO against ITS OWN chain — not the
  // operator's governance config. Select the viem chain from node.chainId.
  const viemChain =
    node.chainId == null ? null : VIEM_CHAINS_BY_ID[node.chainId];
  if (!viemChain) {
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

  try {
    const client = createPublicClient({
      chain: viemChain,
      transport: http(env.EVM_RPC_URL),
    });
    const [tokenCode, holderCode, holderBalance] = await Promise.all([
      client.getBytecode({ address: tokenAddress }),
      client.getBytecode({ address: emissionsHolderAddress }),
      client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [emissionsHolderAddress],
      }) as Promise<bigint>,
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
        holderBalance: holderBalance.toString(),
      },
      "activate-distributions: verification result"
    );
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
    if (holderBalance <= 0n) {
      return NextResponse.json(
        {
          error: "emissions holder has no token inventory",
          tokenAddress,
          emissionsHolderAddress,
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

  const writer = createNodeRepoWriter(env);
  let result: Awaited<ReturnType<typeof writer.openDistributionActivationPr>>;
  try {
    result = await writer.openDistributionActivationPr({
      owner: mintOwner,
      repo: node.slug,
      slug: node.slug,
      tokenAddress,
      emissionsHolderAddress,
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
  });
}
