// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/distribution/latest/route`
 * Purpose: Public HTTP endpoint serving an account's CUMULATIVE merkle claim from the latest finalized epoch's manifest.
 * Scope: Public route using wrapPublicRoute(); finds the most-recent finalized epoch that has a distribution manifest and returns that account's {account, cumulativeAmount, root, proof, distributor} cumulative claim, or claim:null when none exists. Does not contain business logic.
 * Invariants: NODE_SCOPED, CUMULATIVE_MODEL (amount = leaf cumulativeAmount), ALL_MATH_BIGINT, VALIDATE_IO, PUBLIC_READS_FINALIZED_ONLY, NO_SECRETS.
 * Side-effects: IO (HTTP response, database read)
 * Links: packages/node-contracts/src/attribution.latest-distribution.v1.contract.ts, packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts
 * @public
 */

import {
  epochDistributionOperation,
  latestDistributionOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";

export const dynamic = "force-dynamic";

export const GET = wrapPublicRoute(
  {
    routeId: "ledger.latest-distribution.public",
    cacheTtlSeconds: 30,
    staleWhileRevalidateSeconds: 120,
  },
  async (_ctx, request) => {
    const url = new URL(request.url);
    const accountParam = url.searchParams.get("account");
    if (!accountParam) {
      return NextResponse.json(
        { error: "account query param is required" },
        { status: 400 }
      );
    }
    // Reuse the distribution input validator (normalizes the EVM address).
    const { account } = epochDistributionOperation.input.parse({
      account: accountParam,
    });

    const store = getContainer().attributionStore;

    // CUMULATIVE_MODEL: the latest finalized epoch carrying a manifest holds the
    // current cumulative root + every account's cumulativeAmount + proof. A
    // single claim against this root pays out ALL unclaimed epochs.
    const allEpochs = await store.listEpochs(getNodeId());
    const finalizedDesc = allEpochs
      .filter((e) => e.status === "finalized")
      .map((e) => e.id)
      .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

    for (const epochId of finalizedDesc) {
      const manifest = await store.getDistributionManifestForEpoch(epochId);
      if (!manifest) continue;

      // Latest manifest found. Serve this account's cumulative leaf from it.
      const claim = await store.getDistributionClaimForAccount(
        epochId,
        account
      );
      if (!claim) {
        // The latest manifest exists but this account has no leaf in it.
        return NextResponse.json(
          latestDistributionOperation.output.parse({ claim: null })
        );
      }

      return NextResponse.json(
        latestDistributionOperation.output.parse({
          claim: {
            epochId: claim.epochId.toString(),
            root: claim.merkleRoot,
            distributor: claim.distributorAddress,
            chainId: claim.chainId,
            tokenAddress: claim.tokenAddress,
            account: claim.leaf.account,
            // CUMULATIVE_MODEL: leaf.amount is the cumulativeAmount.
            amount: claim.leaf.amount.toString(),
            proof: [...claim.leaf.proof],
          },
        })
      );
    }

    // No finalized manifest anywhere yet.
    return NextResponse.json(
      latestDistributionOperation.output.parse({ claim: null })
    );
  }
);
