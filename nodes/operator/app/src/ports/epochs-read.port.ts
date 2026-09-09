// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/epochs-read`
 * Purpose: Port for READING a FOREIGN owning node's ledger epochs over its internal HTTP API
 *   (operator gateway → node). The read twin of `ReceiptDelivery` (the write plane). Implemented by
 *   the HTTP epochs-read adapter.
 * Scope: Interface only. Does not contain implementations or perform I/O.
 * Invariants: Named exports only, no runtime coupling. Features depend on this port, never on the
 *   adapter. OPERATOR_AGGREGATES_ARE_DERIVED — the operator derives this aggregate via the node's
 *   internal HTTP API, never by querying a node DB.
 * Side-effects: none
 * Links: adapters/server/attribution/http-epochs-read.ts, /api/internal/attribution/epochs,
 *   packages/node-contracts/src/attribution.epochs.internal.v1.contract.ts, bug.5008
 * @public
 */

import type { InternalListEpochsOutput } from "@cogni/node-contracts";

export interface EpochsRead {
  /**
   * GET the given node's epochs from its `/api/internal/attribution/epochs`. Resolves with the
   * node's own epoch page on 2xx; throws (classified retryable-vs-permanent) otherwise, or if
   * the node's app is unreachable. The base URL is resolved from the node's DECLARED placement
   * via `NodeAddressPort`, mirroring the receipt-delivery write twin (bug.5106).
   */
  listEpochsForForeignNode(
    slug: string,
    page: { limit: number; offset: number }
  ): Promise<InternalListEpochsOutput>;
}

/**
 * Failure contract for {@link EpochsRead}. Lives on the PORT, not the adapter: a route must be
 * able to classify the failure (a node that does not expose the internal read is a known state,
 * not a fault — bug.5083), and `app/` may import ports but never `adapters/server/*`.
 *
 * `retryable` mirrors http-receipt-delivery's classification so a caller, or a future retry path,
 * can decide whether another attempt is worthwhile.
 */
export class EpochsReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "EpochsReadError";
  }
}
