// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/epochs/[id]/distribution/route`
 * Purpose: Public HTTP endpoint serving one claimant's DAO token merkle claim (leaf + proof) for a finalized epoch.
 * Scope: Public route using wrapPublicRoute(); returns the claim account's {index, amount, proof, root, distributor} from the epoch's distribution manifest, or claim:null when no leaf exists. Does not contain business logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, PUBLIC_READS_FINALIZED_ONLY, NO_SECRETS.
 * Side-effects: IO (HTTP response, database read)
 * Links: contracts/attribution.epoch-distribution.v1.contract, packages/aragon-osx/src/token-distribution.ts
 * @public
 */

import { epochDistributionOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";

export const dynamic = "force-dynamic";

export const GET = wrapPublicRoute(
  {
    routeId: "ledger.epoch-distribution.public",
    cacheTtlSeconds: 60,
    staleWhileRevalidateSeconds: 300,
  },
  async (_ctx, request, context) => {
    const { id } = await (context as { params: Promise<{ id: string }> })
      .params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    const url = new URL(request.url);
    const accountParam = url.searchParams.get("account");
    if (!accountParam) {
      return NextResponse.json(
        { error: "account query param is required" },
        { status: 400 }
      );
    }
    const { account } = epochDistributionOperation.input.parse({
      account: accountParam,
    });

    const store = getContainer().attributionStore;

    // PUBLIC_READS_FINALIZED_ONLY: verify epoch is finalized
    const epoch = await store.getEpoch(epochId);
    if (!epoch || epoch.status !== "finalized") {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    const claim = await store.getDistributionClaimForAccount(epochId, account);
    if (!claim) {
      // No manifest for this epoch, or no leaf for this account.
      return NextResponse.json({ error: "Claim not found" }, { status: 404 });
    }

    return NextResponse.json(
      epochDistributionOperation.output.parse({
        claim: {
          epochId: claim.epochId.toString(),
          root: claim.merkleRoot,
          distributor: claim.distributorAddress,
          chainId: claim.chainId,
          tokenAddress: claim.tokenAddress,
          index: claim.leaf.index,
          account: claim.leaf.account,
          amount: claim.leaf.amount.toString(),
          proof: [...claim.leaf.proof],
        },
      })
    );
  }
);
