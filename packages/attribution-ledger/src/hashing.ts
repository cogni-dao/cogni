// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/hashing`
 * Purpose: Deterministic SHA-256 hashing for allocation sets and epoch evaluations.
 * Scope: Pure functions. Does not perform network I/O or hold secrets.
 * Invariants:
 * - STATEMENT_DETERMINISTIC: Same inputs → byte-for-byte identical hash output.
 * - CANONICAL_JSON: canonicalJsonStringify sorts keys at every depth, no whitespace, BigInt as string.
 * - Allocations are canonically sorted before hashing.
 * Side-effects: none (uses Web Crypto API)
 * Links: docs/spec/attribution-ledger.md
 * @public
 */

import type { FrozenActorContributionAllocation } from "./actor-contribution-allocation";
import { type AttributionClaimant, claimantKey } from "./claimant-shares";

/**
 * Compute SHA-256 hash of a UTF-8 string.
 * Returns lowercase hex string.
 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deterministic JSON serialization — CANONICAL_JSON invariant.
 * Sorted keys at every depth, no whitespace, BigInt serialized as string.
 * Used for all artifact payload hashing and inputs_hash computation.
 *
 * @param value - Any JSON-compatible value (supports BigInt)
 * @returns Canonical JSON string
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return val.toString();
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = val[k];
      }
      return sorted;
    }
    return val;
  });
}

/**
 * Compute SHA-256 hash of a canonical JSON value.
 * Convenience wrapper: canonicalJsonStringify → sha256Hex.
 */
export async function sha256OfCanonicalJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJsonStringify(value));
}

/**
 * Compute artifacts_hash for an epoch from locked evaluation records.
 * SHA-256 of sorted (evaluation_ref, algo_ref, inputs_hash, payload_hash) tuples.
 * Only locked evaluations contribute. Deterministic for same inputs.
 *
 * @param evaluations - Array of locked evaluation records
 * @returns SHA-256 hex string
 */
export async function computeArtifactsHash(
  evaluations: ReadonlyArray<{
    readonly evaluationRef: string;
    readonly algoRef: string;
    readonly inputsHash: string;
    readonly payloadHash: string;
  }>
): Promise<string> {
  const sorted = [...evaluations].sort((a, b) =>
    a.evaluationRef.localeCompare(b.evaluationRef)
  );
  const canonical = canonicalJsonStringify(
    sorted.map((a) => [a.evaluationRef, a.algoRef, a.inputsHash, a.payloadHash])
  );
  return sha256Hex(canonical);
}

/**
 * Compute a deterministic SHA-256 hash of a weight config object.
 * Canonical JSON: keys sorted, values as-is. Deterministic for same config.
 *
 * @param config - Weight config (key → milli-unit value)
 * @returns SHA-256 hex string
 */
export async function computeWeightConfigHash(
  config: Record<string, number>
): Promise<string> {
  const sortedKeys = Object.keys(config).sort();
  const canonical: Record<string, number> = {};
  for (const key of sortedKeys) {
    canonical[key] = config[key] as number;
  }
  return sha256Hex(JSON.stringify(canonical));
}

/**
 * Compute a deterministic hash of a set of allocations for epoch close.
 *
 * Canonical format: sort allocations by userId, then serialize as
 * `userId:valuationUnits` lines joined by newline. This ensures
 * identical allocation sets always produce the same hash.
 *
 * @param allocations - Array of { userId, valuationUnits } to hash
 * @returns SHA-256 hex string
 */
export async function computeAllocationSetHash(
  allocations: ReadonlyArray<{
    readonly userId: string;
    readonly valuationUnits: bigint;
  }>
): Promise<string> {
  const sorted = [...allocations].sort((a, b) =>
    a.userId.localeCompare(b.userId)
  );
  const canonical = sorted
    .map((a) => `${a.userId}:${a.valuationUnits.toString()}`)
    .join("\n");
  return sha256Hex(canonical);
}

/**
 * Compute a deterministic hash of a claimant-based allocation set.
 *
 * User claimants retain their bare userId as the canonical key for backward
 * compatibility with legacy allocation hashes. Non-user claimants use their
 * full claimant key (for example `identity:github:12345`).
 */
export async function computeFinalClaimantAllocationSetHash(
  allocations: ReadonlyArray<{
    readonly claimant: AttributionClaimant;
    readonly finalUnits: bigint;
  }>
): Promise<string> {
  const sorted = [...allocations].sort((a, b) => {
    const keyA =
      a.claimant.kind === "user" ? a.claimant.userId : claimantKey(a.claimant);
    const keyB =
      b.claimant.kind === "user" ? b.claimant.userId : claimantKey(b.claimant);
    return keyA.localeCompare(keyB);
  });
  const canonical = sorted
    .map((allocation) => {
      const key =
        allocation.claimant.kind === "user"
          ? allocation.claimant.userId
          : claimantKey(allocation.claimant);
      return `${key}:${allocation.finalUnits.toString()}`;
    })
    .join("\n");
  return sha256Hex(canonical);
}

/**
 * Compute the commitment signed when an epoch contains actor-owned receipts.
 *
 * Actor allocation refs are content-addressed, but the signed payload commits
 * the immutable facts explicitly so an auditor does not have to trust an
 * indirect lookup. Epochs without actor allocations retain the legacy hash.
 */
export async function computeSignedAllocationSetHash(
  claimantAllocations: ReadonlyArray<{
    readonly claimant: AttributionClaimant;
    readonly finalUnits: bigint;
  }>,
  actorAllocations: readonly FrozenActorContributionAllocation[]
): Promise<string> {
  const claimantAllocationSetHash =
    await computeFinalClaimantAllocationSetHash(claimantAllocations);
  if (actorAllocations.length === 0) return claimantAllocationSetHash;

  const actorAllocationFacts = [...actorAllocations]
    .sort((a, b) => a.allocationRef.localeCompare(b.allocationRef))
    .map((allocation) => ({
      allocationRef: allocation.allocationRef,
      contractVersion: allocation.contractVersion,
      nodeId: allocation.nodeId,
      scopeId: allocation.scopeId,
      epochId: allocation.epochId,
      receiptId: allocation.receiptId,
      earnedByActorId: allocation.earnedByActorId,
      beneficiaryActorId: allocation.beneficiaryActorId,
      beneficiaryPolicyId: allocation.beneficiaryPolicyId,
      beneficiaryPolicyVersion: allocation.beneficiaryPolicyVersion,
      contributionCutoff: allocation.contributionCutoff,
      sourceEvidenceHash: allocation.sourceEvidenceHash,
    }));

  return sha256OfCanonicalJson({
    contractVersion: "attribution.signed-allocation-set.v1",
    claimantAllocationSetHash,
    actorAllocationFacts,
  });
}
