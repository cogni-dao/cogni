// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/enricher-inputs`
 * Purpose: Shared inputsHash computation for enrichers. Base shape is frozen; enrichers extend via `extensions`.
 * Scope: Pure function. Does not perform I/O.
 * Invariants:
 * - INPUTS_HASH_DETERMINISTIC: Same inputs → same hash, regardless of receipt order.
 * - INPUTS_HASH_EXTENSIBLE: Extensions are additive, sorted by canonicalJsonStringify.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import { sha256OfCanonicalJson } from "./hashing";

/**
 * Compute a deterministic inputsHash for an enricher run.
 *
 * Base shape: epochId + sorted (receiptId, receiptPayloadHash) pairs.
 * Extensions: enricher-specific additions (e.g. frontmatter hashes for work-item-linker).
 * canonicalJsonStringify sorts keys, so extensions are stable.
 *
 * @param params.epochId - The epoch being enriched
 * @param params.receipts - Receipts with their ingestion-time payload hashes
 * @param params.extensions - Optional enricher-specific data to include in hash
 * @returns SHA-256 hex string
 */
export async function computeEnricherInputsHash(params: {
  epochId: bigint;
  receipts: ReadonlyArray<{
    receiptId: string;
    receiptPayloadHash: string;
  }>;
  extensions?: Record<string, unknown>;
}): Promise<string> {
  const sorted = [...params.receipts].sort((a, b) =>
    a.receiptId.localeCompare(b.receiptId)
  );
  const base: Record<string, unknown> = {
    epochId: params.epochId.toString(),
    receipts: sorted.map((e) => [e.receiptId, e.receiptPayloadHash]),
  };
  if (params.extensions) {
    base.ext = params.extensions;
  }
  return sha256OfCanonicalJson(base);
}
