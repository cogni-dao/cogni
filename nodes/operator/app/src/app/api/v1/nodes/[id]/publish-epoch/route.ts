// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/publish-epoch`
 * Purpose: Server step of the publish-epoch distribution flow (story.5021 Walk, P4). Loads a node's
 *   FINALIZED, signed epoch statement, builds the DaoTokenMerkleDistribution (root + leaves) via the
 *   FROZEN `buildEpochDistribution`, persists the manifest (distributorAddress still null), and returns
 *   the on-chain refs the wallet client needs to deploy the distributor + submit the DAO mint proposal.
 * Scope: Session auth + owner-or-`node.flight` gating. Builds + persists ONLY — it never deploys a
 *   contract, mints, or holds tokens (the wallet does the on-chain work; the DAO mints; no central
 *   custody). Reads the DAO/token/plugin addresses from the node row; reads the statement from the
 *   operator's own attribution store.
 * Invariants:
 *   - PUBLISH_FINALIZED_ONLY: refuses any epoch whose status !== 'finalized' (the statement must be signed).
 *   - PUBLISH_NO_CENTRAL_CUSTODY: returns mint-proposal refs; the DAO mints straight into the distributor.
 *   - PUBLISH_FROZEN_ROOT: merkle root/leaves come unchanged from buildEpochDistribution.
 *   - PUBLISH_SOLO_SCOPE: atomic early-execute (handled client-side) only holds for a solo, self-delegated
 *     DAO (the operator). Multi-holder DAOs need a real vote — out of scope; documented in the client.
 *   - OWNER_OR_DEVELOPER: node owner session OR `node.flight` authorizes publishing.
 *   - NODE_SCOPED, VALIDATE_IO, NO_SECRETS.
 * Side-effects: IO (Postgres read + manifest upsert, on-chain wallet-resolver read)
 * Links: nodes/operator/app/src/features/governance/publish-epoch/build-distribution.ts,
 *   packages/aragon-osx/src/epoch-distribution-service.ts, spikes/walk-p4-mint-into-distributor, story.5021
 * @public
 */

import { buildEpochDistribution } from "@cogni/aragon-osx";
import { DrizzleClaimantWalletResolver } from "@cogni/db-client";
import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import {
  epochTokenBudgetFromStatement,
  toFinalizedEpochStatement,
} from "@/features/governance/publish-epoch/build-distribution";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { nodes } from "@/shared/db/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PublishEpochInput = z.object({
  epochId: z.string().regex(/^\d+$/, "epochId must be a decimal string"),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

function checksum(value: string | null | undefined): `0x${string}` | null {
  if (!value) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

export async function POST(
  request: Request,
  routeArgs: RouteParams
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
  const parsed = PublishEpochInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const epochId = BigInt(parsed.data.epochId);

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

  // OWNER_OR_DEVELOPER gate (mirrors activate-distributions).
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
          ? { error: "authorization not configured", errorCode: gate.errorCode }
          : { error: "not authorized", errorCode: gate.errorCode };
      return NextResponse.json(responseBody, { status: gate.status });
    }
  }

  // On-chain refs come from the node row (the DAO mints; the plugin governs).
  const tokenAddress = checksum(node.tokenAddress);
  const daoAddress = checksum(node.daoAddress);
  const pluginAddress = checksum(node.pluginAddress);
  const chainId = node.chainId;
  if (!tokenAddress || !daoAddress || !pluginAddress || chainId == null) {
    return NextResponse.json(
      {
        error: "node missing on-chain governance addresses",
        reason:
          "publish-epoch requires the node's GovernanceERC20 token, DAO, TokenVoting plugin, and chainId",
        hasToken: Boolean(tokenAddress),
        hasDao: Boolean(daoAddress),
        hasPlugin: Boolean(pluginAddress),
        chainId,
      },
      { status: 409 }
    );
  }

  const store = getContainer().attributionStore;

  // PUBLISH_FINALIZED_ONLY: the statement must be signed (epoch finalized).
  const epoch = await store.getEpoch(epochId);
  if (epoch?.status !== "finalized") {
    return NextResponse.json(
      {
        error: "epoch not finalized",
        reason:
          "publish-epoch distributes a finalized, admin-signed statement; the epoch is not finalized",
        epochId: parsed.data.epochId,
        status: epoch?.status ?? null,
      },
      { status: 409 }
    );
  }
  const statement = await store.getStatementForEpoch(epochId);
  if (!statement) {
    return NextResponse.json(
      {
        error: "no signed statement for finalized epoch",
        epochId: parsed.data.epochId,
      },
      { status: 409 }
    );
  }

  // Build the distribution from the signed statement (FROZEN root math).
  const finalized = toFinalizedEpochStatement(epoch, statement, {
    tokenAddress,
    chainId,
  });
  const budget = epochTokenBudgetFromStatement(statement);
  const resolver = new DrizzleClaimantWalletResolver(db);
  const { distribution, blockers, unresolvedClaimantKeys } =
    await buildEpochDistribution(finalized, budget, resolver);

  if (!distribution) {
    return NextResponse.json(
      {
        error: "no distributable allocation",
        reason:
          "no positive, wallet-resolved allocation remains to build a merkle distribution",
        blockers,
        unresolvedClaimantKeys,
      },
      { status: 409 }
    );
  }

  // Persist the manifest (header + leaves). distributorAddress stays null until
  // the wallet deploys the on-chain MerkleDistributor (the /distributor step).
  const manifest = await store.upsertDistributionManifest({
    nodeId: distribution.nodeId,
    scopeId: distribution.scopeId,
    epochId,
    distributionId: distribution.distributionId,
    statementHash: distribution.statementHash,
    merkleRoot: distribution.merkleRoot,
    chainId: distribution.chainId,
    tokenAddress: distribution.tokenAddress,
    distributionAmount: distribution.distributionAmount,
    totalAllocated: distribution.totalAllocated,
    distributorAddress: null,
    leaves: distribution.leaves.map((l) => ({
      index: l.index,
      claimantKey: l.claimantKey,
      account: l.account,
      amount: l.amount,
      leafHash: l.leafHash,
      proof: [...l.proof],
    })),
  });

  // Return the refs the wallet client needs to deploy the distributor and
  // submit the DAO mint proposal (ALL_MATH_BIGINT → strings on the wire).
  return NextResponse.json({
    epochId: epochId.toString(),
    onchain: {
      chainId,
      dao: daoAddress,
      token: tokenAddress,
      plugin: pluginAddress,
    },
    distribution: {
      distributionId: manifest.distributionId,
      merkleRoot: manifest.merkleRoot,
      // The DAO mints exactly the manifest's distributionAmount into the distributor.
      distributionAmount: manifest.distributionAmount.toString(),
      totalAllocated: manifest.totalAllocated.toString(),
      leafCount: distribution.leaves.length,
    },
    // Non-blocking blockers (e.g. some claimants unresolved → excluded).
    blockers,
    unresolvedClaimantKeys,
  });
}
