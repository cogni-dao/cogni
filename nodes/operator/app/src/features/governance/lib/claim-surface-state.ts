// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/claim-surface-state`
 * Purpose: Pure derivation of the Ownership page's claim-surface state machine — turns GROUND
 *   TRUTH inputs (repo-spec activation status, the on-chain distributor `merkleRoot()` +
 *   `cumulativeClaimed`, and the viewer's latest-manifest leaf) into ONE first-class state, so the
 *   UI never renders a silent "no tokens" when a more specific truth is readable (story.5003).
 * Scope: Pure function + discriminated union. No IO, no hooks, no chain reads — callers supply
 *   every input (see useClaimSurface). Does not perform DB access.
 * Invariants:
 *   - HONEST_EMPTY: an "empty" rendering is only ever the MOST specific state the readable
 *     sources prove — not-activated ≠ not-published ≠ no-allocation ≠ fully-claimed.
 *   - LEAF_BEATS_STALE_SPEC: a real claim leaf outranks a stale/lagging repo-spec activation
 *     record — never hide a claimable allocation behind `distributions.status`.
 *   - ROOT_GATED_CTA: the claim CTA only renders when the leaf's root equals the live on-chain
 *     `merkleRoot()` — a mismatched claim would revert `MerkleRootWasUpdated` (1inch cumulative).
 *   - ALL_MATH_BIGINT: amounts stay bigint; claimable = cumulativeAmount − cumulativeClaimed,
 *     clamped ≥ 0 (double-claim reverts `NothingToClaim` on-chain — SINGLE_CLAIM_COVERS_ALL).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/distribution-lifecycle, nodes/operator/app/src/features/governance/hooks/useClaimSurface.ts
 * @public
 */

import type { LatestDistributionClaimDto } from "@cogni/node-contracts";

/** An unset CumulativeMerkleDrop root — nothing has ever been published on-chain. */
export const ZERO_MERKLE_ROOT = `0x${"0".repeat(64)}`;

function isZeroRoot(root: string): boolean {
  return root.toLowerCase() === ZERO_MERKLE_ROOT;
}

function rootsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * First-class claim-surface states. Exactly one renders at a time; each is proven by a
 * verifiable source (repo-spec via the public tokenomics route, the public latest-distribution
 * route, or a direct chain read) — never by optimistic local state.
 */
export type ClaimSurfaceState =
  /** Some required source is still resolving. */
  | { readonly kind: "loading" }
  /** The off-chain claim fetch failed. */
  | { readonly kind: "error"; readonly error: Error }
  /** The on-chain root/claimed read failed — we cannot honestly assert any emptier state. */
  | { readonly kind: "chain_unavailable" }
  /** repo-spec `distributions.status` is not `active` (activation record may still be an open PR). */
  | { readonly kind: "not_activated" }
  /** Distributions are activated and a published distribution may apply — connect to find out. */
  | { readonly kind: "wallet_disconnected" }
  /**
   * Activated, but no distribution is live on-chain (no distributor recorded, or its
   * `merkleRoot()` is still zero). `pendingAllocation` carries the viewer's folded-but-unpublished
   * leaf amount when one exists (null when no leaf / wallet not connected).
   */
  | {
      readonly kind: "not_published";
      readonly pendingAllocation: bigint | null;
    }
  /** A distribution is live on-chain but the latest manifest has no leaf for this wallet. */
  | { readonly kind: "no_allocation" }
  /**
   * The viewer's latest leaf targets a root that is NOT the live on-chain root (new fold awaiting
   * publish). Claiming now would revert `MerkleRootWasUpdated` — no CTA.
   */
  | {
      readonly kind: "root_pending";
      readonly cumulativeAmount: bigint;
      readonly cumulativeClaimed: bigint | null;
    }
  /** Leaf + live root match and there is a positive remainder to claim. */
  | {
      readonly kind: "claimable";
      readonly claim: LatestDistributionClaimDto;
      readonly cumulativeAmount: bigint;
      readonly cumulativeClaimed: bigint;
      readonly claimable: bigint;
    }
  /** On-chain `cumulativeClaimed` covers the full leaf — everything earned is already held. */
  | {
      readonly kind: "fully_claimed";
      readonly cumulativeAmount: bigint;
      readonly cumulativeClaimed: bigint;
    };

export interface ClaimSurfaceInput {
  /** Whether a wallet account is connected (gates the leaf + claimed reads). */
  readonly walletConnected: boolean;
  /** Public tokenomics (repo-spec) config still loading. */
  readonly configLoading: boolean;
  /** repo-spec `distributions.status === "active"`; undefined until config resolves. */
  readonly distributionsActive: boolean | undefined;
  /** repo-spec `distributions.distributor_address`; null until recorded. */
  readonly configDistributor: string | null;
  /** Viewer's leaf from the latest manifest; null = no manifest OR no leaf for this wallet. */
  readonly claim: LatestDistributionClaimDto | null;
  readonly claimLoading: boolean;
  readonly claimError: Error | null;
  /**
   * Live distributor `merkleRoot()`: undefined = still reading, null = read failed
   * (chain unavailable), string = the on-chain root.
   */
  readonly onChainRoot: string | null | undefined;
  /** On-chain `cumulativeClaimed(account)`; undefined until read. */
  readonly cumulativeClaimed: bigint | undefined;
  readonly claimedLoading: boolean;
}

/**
 * Derive the single honest claim-surface state from ground-truth inputs.
 * Precedence: a real leaf first (LEAF_BEATS_STALE_SPEC), then repo-spec activation,
 * then the on-chain root, then wallet connection.
 */
export function deriveClaimSurfaceState(
  input: ClaimSurfaceInput
): ClaimSurfaceState {
  if (input.claimError) return { kind: "error", error: input.claimError };

  // A leaf in hand is the strongest truth — resolve claim-bearing states first,
  // regardless of what the (possibly lagging) repo-spec activation record says.
  if (input.claim) {
    const cumulativeAmount = BigInt(input.claim.amount);
    const distributor = input.claim.distributor ?? input.configDistributor;

    if (!distributor) {
      if (input.configLoading) return { kind: "loading" };
      // Folded allocation exists but no distributor is recorded → nothing on-chain yet.
      return { kind: "not_published", pendingAllocation: cumulativeAmount };
    }
    if (input.onChainRoot === undefined) return { kind: "loading" };
    if (input.onChainRoot === null) return { kind: "chain_unavailable" };
    if (isZeroRoot(input.onChainRoot)) {
      return { kind: "not_published", pendingAllocation: cumulativeAmount };
    }
    if (!rootsEqual(input.onChainRoot, input.claim.root)) {
      // ROOT_GATED_CTA: claiming against a superseded/unpublished root reverts.
      return {
        kind: "root_pending",
        cumulativeAmount,
        cumulativeClaimed: input.cumulativeClaimed ?? null,
      };
    }
    if (input.claimedLoading || input.cumulativeClaimed === undefined) {
      return { kind: "loading" };
    }
    const remaining = cumulativeAmount - input.cumulativeClaimed;
    const claimable = remaining > 0n ? remaining : 0n;
    if (claimable === 0n) {
      return {
        kind: "fully_claimed",
        cumulativeAmount,
        cumulativeClaimed: input.cumulativeClaimed,
      };
    }
    return {
      kind: "claimable",
      claim: input.claim,
      cumulativeAmount,
      cumulativeClaimed: input.cumulativeClaimed,
      claimable,
    };
  }

  // No leaf. Distinguish WHY — repo-spec activation, then the on-chain root.
  if (input.configLoading || input.distributionsActive === undefined) {
    return { kind: "loading" };
  }
  if (!input.distributionsActive) return { kind: "not_activated" };
  if (!input.configDistributor) {
    return { kind: "not_published", pendingAllocation: null };
  }
  if (input.onChainRoot === undefined) {
    // Root still reading: a disconnected wallet can already see its honest next step.
    return input.walletConnected
      ? { kind: "loading" }
      : { kind: "wallet_disconnected" };
  }
  if (input.onChainRoot === null) return { kind: "chain_unavailable" };
  if (isZeroRoot(input.onChainRoot)) {
    return { kind: "not_published", pendingAllocation: null };
  }
  if (!input.walletConnected) return { kind: "wallet_disconnected" };
  if (input.claimLoading) return { kind: "loading" };
  // Published distribution + connected wallet + no leaf → honestly no allocation.
  return { kind: "no_allocation" };
}
