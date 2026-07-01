// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/publish-epoch/distributor`
 * Purpose: Final server step of the publish-epoch flow — after the wallet has deployed the on-chain
 *   MerkleDistributor and the DAO has early-execute-minted into it, record the deployed distributor
 *   address on the epoch's distribution manifest.
 * Scope: Session auth + owner-or-`node.flight` gating. Re-builds the distribution DETERMINISTICALLY
 *   from the same finalized, signed statement (frozen root + identical leaves) and re-upserts the
 *   manifest with the deployed distributorAddress. Does NO chain writes and holds no tokens.
 * Invariants:
 *   - PUBLISH_DISTRIBUTOR_AFTER_DEPLOY: only persists once a manifest exists for the epoch.
 *   - PUBLISH_FROZEN_ROOT: the re-built root MUST equal the persisted root (asserted) — the manifest
 *     upsert replaces leaves wholesale, so we re-supply the IDENTICAL frozen leaves rather than wipe them.
 *   - PUBLISH_FUNDING_TX_NOT_PERSISTED: the manifest schema (P3, do-not-touch) has no fundingTx column,
 *     so the mint tx hash is echoed but not stored — a schema follow-up, not invented here.
 *   - OWNER_OR_DEVELOPER, NODE_SCOPED, VALIDATE_IO, NO_SECRETS.
 * Side-effects: IO (Postgres read + manifest upsert, on-chain wallet-resolver read)
 * Links: ../route.ts (build step), packages/aragon-osx/src/epoch-distribution-service.ts, story.5021
 * @public
 */

import { buildEpochDistribution } from "@cogni/aragon-osx";
import { DrizzleClaimantWalletResolver } from "@cogni/db-client";
import { NextResponse } from "next/server";
import { getAddress, isHash } from "viem";
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

const PersistDistributorInput = z.object({
  epochId: z.string().regex(/^\d+$/, "epochId must be a decimal string"),
  distributorAddress: z.string(),
  // The DAO mint tx (early-execute). Echoed; not persisted (no manifest column).
  fundingTx: z.string().optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
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
  const parsed = PersistDistributorInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const epochId = BigInt(parsed.data.epochId);

  let distributorAddress: `0x${string}`;
  try {
    distributorAddress = getAddress(parsed.data.distributorAddress);
  } catch {
    return NextResponse.json(
      { error: "invalid distributorAddress" },
      { status: 400 }
    );
  }
  if (parsed.data.fundingTx && !isHash(parsed.data.fundingTx)) {
    return NextResponse.json(
      { error: "invalid fundingTx (expected 0x-prefixed 32-byte hash)" },
      { status: 400 }
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
          ? { error: "authorization not configured", errorCode: gate.errorCode }
          : { error: "not authorized", errorCode: gate.errorCode };
      return NextResponse.json(responseBody, { status: gate.status });
    }
  }

  const store = getContainer().attributionStore;

  // The manifest must already exist (built by the publish-epoch route).
  const manifest = await store.getDistributionManifestForEpoch(epochId);
  if (!manifest) {
    return NextResponse.json(
      {
        error: "no distribution manifest for epoch",
        reason:
          "build the distribution (POST publish-epoch) before recording a distributor",
        epochId: parsed.data.epochId,
      },
      { status: 409 }
    );
  }

  // Re-build the distribution DETERMINISTICALLY from the same signed statement.
  // The manifest upsert replaces leaves wholesale and the store exposes no
  // all-leaves read, so re-supplying the IDENTICAL frozen leaves is how we set
  // distributorAddress without wiping them. PUBLISH_FROZEN_ROOT: assert the root
  // is unchanged before persisting.
  const epoch = await store.getEpoch(epochId);
  if (epoch?.status !== "finalized") {
    return NextResponse.json(
      { error: "epoch not finalized", epochId: parsed.data.epochId },
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

  const finalized = toFinalizedEpochStatement(epoch, statement, {
    tokenAddress: manifest.tokenAddress as `0x${string}`,
    chainId: manifest.chainId,
  });
  const budget = epochTokenBudgetFromStatement(statement);
  const resolver = new DrizzleClaimantWalletResolver(db);
  const { distribution } = await buildEpochDistribution(
    finalized,
    budget,
    resolver
  );
  if (!distribution) {
    return NextResponse.json(
      {
        error: "distribution no longer buildable",
        epochId: parsed.data.epochId,
      },
      { status: 409 }
    );
  }
  if (
    distribution.merkleRoot.toLowerCase() !== manifest.merkleRoot.toLowerCase()
  ) {
    // The on-chain distributor was deployed against the persisted root; if a
    // re-build disagrees, refuse to overwrite (frozen-root guardrail).
    return NextResponse.json(
      {
        error: "merkle root drift",
        reason:
          "re-built root does not match the persisted manifest root; refusing to record a distributor",
        persistedRoot: manifest.merkleRoot,
        rebuiltRoot: distribution.merkleRoot,
      },
      { status: 409 }
    );
  }

  const updated = await store.upsertDistributionManifest({
    nodeId: manifest.nodeId,
    scopeId: manifest.scopeId,
    epochId,
    distributionId: manifest.distributionId,
    statementHash: manifest.statementHash,
    merkleRoot: manifest.merkleRoot,
    chainId: manifest.chainId,
    tokenAddress: manifest.tokenAddress,
    distributionAmount: manifest.distributionAmount,
    totalAllocated: manifest.totalAllocated,
    distributorAddress,
    leaves: distribution.leaves.map((l) => ({
      index: l.index,
      claimantKey: l.claimantKey,
      account: l.account,
      amount: l.amount,
      leafHash: l.leafHash,
      proof: [...l.proof],
    })),
  });

  return NextResponse.json({
    epochId: epochId.toString(),
    distributor: updated.distributorAddress,
    // PUBLISH_FUNDING_TX_NOT_PERSISTED: echoed only (no manifest column).
    fundingTx: parsed.data.fundingTx ?? null,
  });
}
