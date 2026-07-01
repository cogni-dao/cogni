// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useCumulativeClaim`
 * Purpose: React hook resolving an account's CUMULATIVE token claim — fetch the latest cumulative manifest leaf (off-chain) and read cumulativeClaimed (on-chain), then derive claimable.
 * Scope: Client-side data + on-chain read for the /gov/holdings claim panel and the /claim/[epoch] page. Does not perform DB access or write transactions (the write is the caller's wagmi useWriteContract).
 * Invariants:
 *   - CUMULATIVE_MODEL: claimable = cumulativeAmount(latest manifest) − cumulativeClaimed(on-chain). Never negative (clamped to 0).
 *   - ALL_MATH_BIGINT: amounts stay bigint; only formatted at display.
 *   - SINGLE_CLAIM_COVERS_ALL: one cumulative root covers every unclaimed epoch.
 * Side-effects: IO (HTTP GET to the latest-distribution route), blockchain read (cumulativeClaimed).
 * Links: nodes/operator/app/src/app/api/v1/public/attribution/distribution/latest/route.ts, packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts
 * @public
 */

import { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
import type { LatestDistributionClaimDto } from "@cogni/node-contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useReadContract } from "wagmi";

/** Endpoint variant: latest cumulative manifest, or a specific epoch's manifest. */
type ClaimSource = { kind: "latest" } | { kind: "epoch"; epochId: string };

function claimUrl(source: ClaimSource, account: string): string {
  if (source.kind === "epoch") {
    return `/api/v1/public/attribution/epochs/${encodeURIComponent(
      source.epochId
    )}/distribution?account=${account}`;
  }
  return `/api/v1/public/attribution/distribution/latest?account=${account}`;
}

async function fetchClaim(
  source: ClaimSource,
  account: string
): Promise<LatestDistributionClaimDto | null> {
  const res = await fetch(claimUrl(source, account), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  // 404 = epoch not found / no leaf for this account → no allocation, calmly null.
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  const body = (await res.json()) as {
    claim: LatestDistributionClaimDto | null;
  };
  return body.claim;
}

export interface CumulativeClaimState {
  /** Off-chain leaf (account, cumulativeAmount, root, proof, distributor, chain, token). */
  readonly claim: LatestDistributionClaimDto | null;
  /** On-chain cumulativeClaimed(account) in base units. undefined until read. */
  readonly cumulativeClaimed: bigint | undefined;
  /** claimable = cumulativeAmount − cumulativeClaimed, clamped ≥ 0. */
  readonly claimable: bigint | undefined;
  readonly isLoading: boolean;
  readonly isClaimedLoading: boolean;
  readonly error: Error | null;
  /** Re-read cumulativeClaimed (call after a claim tx confirms). */
  readonly refetchClaimed: () => void;
}

/**
 * Resolve the cumulative claim for `account`. Pass `source` to target the latest
 * cumulative manifest (default) or a specific epoch's manifest.
 *
 * `enabled` gates both the off-chain fetch and the on-chain read.
 */
export function useCumulativeClaim(
  account: string | undefined,
  source: ClaimSource = { kind: "latest" },
  enabled = true
): CumulativeClaimState {
  const normalized = account?.toLowerCase();
  const active = enabled && Boolean(normalized);

  const {
    data: claim,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["governance", "cumulative-claim", source, normalized],
    queryFn: () => fetchClaim(source, normalized as string),
    enabled: active,
    staleTime: 30_000,
  });

  const distributor = claim?.distributor as `0x${string}` | null | undefined;

  // On-chain cumulativeClaimed(account) — the source of truth for what's already
  // been paid out. claimable is derived against the off-chain cumulativeAmount.
  const {
    data: cumulativeClaimed,
    isLoading: isClaimedLoading,
    refetch,
  } = useReadContract({
    abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
    address: distributor ?? undefined,
    functionName: "cumulativeClaimed",
    args: [normalized as `0x${string}`],
    chainId: claim?.chainId,
    query: { enabled: active && Boolean(distributor) && Boolean(claim) },
  });

  const claimable = useMemo<bigint | undefined>(() => {
    if (!claim) return undefined;
    const cumulativeAmount = BigInt(claim.amount);
    // If there's no distributor yet, cumulativeClaimed is unreadable → treat the
    // full cumulativeAmount as claimable-pending (claim button still gated on
    // distributor presence by the caller).
    if (cumulativeClaimed === undefined) return undefined;
    const remaining = cumulativeAmount - cumulativeClaimed;
    return remaining > 0n ? remaining : 0n;
  }, [claim, cumulativeClaimed]);

  return {
    claim: claim ?? null,
    cumulativeClaimed,
    claimable,
    isLoading,
    isClaimedLoading,
    error: error as Error | null,
    refetchClaimed: () => {
      void refetch();
    },
  };
}
