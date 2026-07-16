// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/receipt-delivery`
 * Purpose: Port for delivering normalized attribution receipts to the OWNING node's own ledger
 *   over its internal HTTP API (operator gateway → node). Implemented by the HTTP delivery adapter.
 * Scope: Interface only. Does not contain implementations or perform I/O.
 * Invariants: Named exports only, no runtime coupling. Features depend on this port, never on the adapter.
 * Side-effects: none
 * Links: adapters/server/ingestion/http-receipt-delivery.ts, /api/internal/attribution/receipts,
 *   docs/design/attribution-operator-gateway.md, task.0280
 * @public
 */

import type { InsertReceiptParams } from "@cogni/attribution-ledger";

export interface ReceiptDelivery {
  /**
   * POST the given receipts to the owning node's `/api/internal/attribution/receipts`.
   * Resolves on 2xx; throws (classified retryable-vs-permanent) otherwise, or if `nodeId` is
   * not present in COGNI_NODE_ENDPOINTS. Receipts carry `Date` `eventTime`/`retrievedAt`; the
   * wire format converts them to ISO-8601 strings.
   */
  deliverReceipts(
    nodeId: string,
    source: string,
    receipts: readonly InsertReceiptParams[]
  ): Promise<void>;
}
