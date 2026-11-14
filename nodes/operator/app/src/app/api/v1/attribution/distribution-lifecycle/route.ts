// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/distribution-lifecycle`
 * Purpose: Serve one page-level read of fold + on-chain cumulative publication evidence.
 * Scope: SIWE-authenticated read. Loads persisted manifests for this node, reads the ONE distributor
 *   root once, and reports the manifest epoch it matches. Does not authorize or build publish txs.
 * Invariants: NODE_SCOPED, FOLD_FROM_PERSISTED_MANIFEST, PUBLISH_FROM_ON_CHAIN_EVIDENCE,
 *   UNKNOWN_NEVER_COMPLETE.
 * Side-effects: IO (database + one best-effort RPC read)
 * Links: https://node-template.cognidao.org/knowledge/distribution-lifecycle, bug.5042
 * @public
 */

import { distributionLifecycleOperation } from "@cogni/node-contracts";
import { CHAINS } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { type Address, createPublicClient, http } from "viem";
import { base, sepolia } from "viem/chains";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const MERKLE_ROOT_ABI = [
  {
    type: "function",
    name: "merkleRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;
const VIEM_CHAINS_BY_ID: Record<number, typeof base | typeof sepolia> = {
  [CHAINS.BASE.chainId]: base,
  [CHAINS.SEPOLIA.chainId]: sepolia,
};

async function readLiveRoot(
  chainId: number,
  distributorAddress: string
): Promise<string | null> {
  const chain = VIEM_CHAINS_BY_ID[chainId];
  const rpcUrl = serverEnv().EVM_RPC_URL;
  if (!chain || !rpcUrl) return null;

  try {
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    return await client.readContract({
      abi: MERKLE_ROOT_ABI,
      address: distributorAddress as Address,
      functionName: "merkleRoot",
    });
  } catch {
    return null;
  }
}

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "ledger.distribution-lifecycle",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx) => {
    const store = getContainer().attributionStore;
    const epochs = await store.listEpochs(getNodeId());
    const manifests = (
      await Promise.all(
        epochs.map((epoch) => store.getDistributionManifestForEpoch(epoch.id))
      )
    )
      .filter((manifest) => manifest !== null)
      .sort((a, b) =>
        a.epochId < b.epochId ? -1 : a.epochId > b.epochId ? 1 : 0
      );

    const foldedEpochIds = manifests.map((manifest) =>
      manifest.epochId.toString()
    );
    const latest = manifests.at(-1) ?? null;

    if (!latest) {
      return NextResponse.json(
        distributionLifecycleOperation.output.parse({
          foldedEpochIds,
          latestFoldedEpochId: null,
          publishedThroughEpochId: null,
          publicationEvidence: "not_published",
        })
      );
    }

    if (!latest.distributorAddress) {
      return NextResponse.json(
        distributionLifecycleOperation.output.parse({
          foldedEpochIds,
          latestFoldedEpochId: latest.epochId.toString(),
          publishedThroughEpochId: null,
          publicationEvidence: "unknown",
        })
      );
    }

    const liveRoot = await readLiveRoot(
      latest.chainId,
      latest.distributorAddress
    );
    if (liveRoot === null) {
      ctx.log.warn(
        { event: "attribution.distribution_lifecycle_rpc_unknown" },
        "distribution lifecycle could not read the live root"
      );
      return NextResponse.json(
        distributionLifecycleOperation.output.parse({
          foldedEpochIds,
          latestFoldedEpochId: latest.epochId.toString(),
          publishedThroughEpochId: null,
          publicationEvidence: "unknown",
        })
      );
    }

    const normalizedRoot = liveRoot.toLowerCase();
    const liveManifest = manifests.find(
      (manifest) =>
        manifest.distributorAddress?.toLowerCase() ===
          latest.distributorAddress?.toLowerCase() &&
        manifest.merkleRoot.toLowerCase() === normalizedRoot
    );
    const publicationEvidence = liveManifest
      ? "matched"
      : normalizedRoot === ZERO_ROOT
        ? "not_published"
        : "unknown";

    return NextResponse.json(
      distributionLifecycleOperation.output.parse({
        foldedEpochIds,
        latestFoldedEpochId: latest.epochId.toString(),
        publishedThroughEpochId: liveManifest?.epochId.toString() ?? null,
        publicationEvidence,
      })
    );
  }
);
