// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/ingestion/http-receipt-delivery`
 * Purpose: HTTP delivery of normalized attribution receipts from the operator gateway to the
 *   OWNING node's own ledger (`POST {nodeUrl}/api/internal/attribution/receipts`). Mirrors the
 *   scheduler-worker's `run-http` adapter (nodeId → nodeUrl lookup, Bearer SCHEDULER_API_TOKEN,
 *   retryable-vs-permanent status classification, structured error logging).
 * Scope: HTTP delivery client for FOREIGN (remote) owning nodes; does not touch a DB. The
 *   operator's own-node write stays a local write in `receiveWebhook`; remote nodes persist
 *   receipts in their OWN ledger (NODE_WRITES_OWN_LEDGER). Receipt `Date` fields are serialized
 *   to ISO strings for the wire.
 * Invariants:
 *   - NO_DB_IN_DELIVERY: only fetch(); the owning node stamps its own node_id.
 *   - The authoritative catalog/profile routing decision supplies nodeId + slug together — this
 *     adapter never re-resolves node IDENTITY through a second, potentially stale seam.
 *   - PLACEMENT_DECIDES_THE_ADDRESS (bug.5106): the base URL comes from the injected
 *     `NodeAddressPort`, which reads the node's DECLARED placement. Deriving
 *     `http://<slug>-node-app:3000` here assumed every node is a cluster neighbour, so a node
 *     placed on decentralized compute silently lost every receipt to `ENOTFOUND`. Placement, not
 *     the caller, decides the address — and no node name ever appears in this file.
 *   - Bearer SCHEDULER_API_TOKEN attached to every request (MVP dispatch identity, same as graph
 *     dispatch; the per-node principal is the hardening — task.5033).
 *   - Idempotency-Key: `${nodeId}/${firstReceiptId}` — repeat delivery is a no-op on the node
 *     (RECEIPT_IDEMPOTENT: ON CONFLICT DO NOTHING keyed by (node_id, receipt_id)).
 *   - 4xx (except transient 404/408/409/429) → permanent; 5xx/network → retryable. Throws on non-2xx.
 * Side-effects: IO (HTTP)
 * Links: packages/node-contracts/src/attribution.receipts.internal.v1.contract.ts,
 *   services/scheduler-worker/src/adapters/run-http.ts,
 *   nodes/operator/app/src/features/ingestion/services/webhook-receiver.ts,
 *   docs/design/attribution-operator-gateway.md, story.5023
 * @internal
 */

import type { InsertReceiptParams } from "@cogni/attribution-ledger";
import {
  type InternalDeliverReceiptsInput,
  type InternalReceipt,
  internalDeliverReceiptsOperation,
} from "@cogni/node-contracts";
import type { NodeAddressPort, ReceiptDelivery } from "@/ports";
import type { Logger } from "@/shared/observability";

// ReceiptDelivery port lives in @/ports/receipt-delivery.port; this adapter implements it.

export interface HttpReceiptDeliveryDeps {
  /** Bearer token for the internal dispatch identity (SCHEDULER_API_TOKEN). */
  readonly schedulerApiToken: string;
  /** Placement-aware address resolution — in-cluster for k3s nodes, public host for external ones. */
  readonly nodeAddress: NodeAddressPort;
  readonly logger: Logger;
}

/**
 * Error raised by the receipt-delivery client. `retryable` mirrors run-http's classification so a
 * caller (or a future Temporal-backed delivery path) can decide whether a retry is worthwhile.
 */
export class ReceiptDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ReceiptDeliveryError";
  }
}

/**
 * HTTP status codes that are retryable — the request may succeed on a later attempt. Mirrors
 * run-http.ts: transient 404 (deploy-time race before the node-app has the receipts route),
 * 408/429 (transient by definition), 409 (idempotency-in-progress). Everything else in the 4xx
 * range (400/401/403/422) is a structural failure and stays non-retryable. 5xx/network → retryable.
 */
const RETRYABLE_TRANSIENT_4XX = new Set([404, 408, 409, 429]);
function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return RETRYABLE_TRANSIENT_4XX.has(status);
}

function authHeaders(token: string, idempotencyKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": idempotencyKey,
  };
}

async function readErrorText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable>";
  }
}

/**
 * Convert a store-shaped receipt (`InsertReceiptParams`, `Date` fields, carries `nodeId`) to the
 * wire shape (`InternalReceipt` — ISO-8601 strings, WITHOUT `nodeId`; the receiving node stamps its
 * own per NODE_WRITES_OWN_LEDGER).
 */
function toWireReceipt(r: InsertReceiptParams): InternalReceipt {
  return {
    receiptId: r.receiptId,
    source: r.source,
    eventType: r.eventType,
    platformUserId: r.platformUserId,
    platformLogin: r.platformLogin ?? null,
    artifactUrl: r.artifactUrl ?? null,
    metadata: r.metadata ?? null,
    payloadHash: r.payloadHash,
    producer: r.producer,
    producerVersion: r.producerVersion,
    eventTime: r.eventTime.toISOString(),
    retrievedAt: r.retrievedAt.toISOString(),
  };
}

export function createHttpReceiptDelivery(
  deps: HttpReceiptDeliveryDeps
): ReceiptDelivery {
  const { schedulerApiToken, nodeAddress, logger } = deps;

  return {
    async deliverReceipts(target, source, receipts): Promise<void> {
      if (receipts.length === 0) return;

      const { nodeId, slug } = target;
      const base = await nodeAddress.resolveNodeAppBaseUrl(slug);
      const url = `${base}/api/internal/attribution/receipts`;

      const body: InternalDeliverReceiptsInput = {
        nodeId,
        source,
        receipts: receipts.map(toWireReceipt),
      };
      // Validate against the frozen contract before we hit the wire — a shape drift should
      // surface here (permanent) rather than as an opaque 400 from the receiving node.
      internalDeliverReceiptsOperation.input.parse(body);

      const idempotencyKey = `${nodeId}/${receipts[0]?.receiptId ?? ""}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: authHeaders(schedulerApiToken, idempotencyKey),
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network / DNS failure — retryable (the node-app may just be mid-roll).
        logger.error(
          {
            event: "attribution.receipt_delivery_failed",
            nodeId,
            url,
            source,
            count: receipts.length,
            err: String(err),
            retryable: true,
          },
          "attribution receipt delivery failed (network)"
        );
        throw new ReceiptDeliveryError(
          `POST ${url} network error: ${String(err)}`,
          0,
          true
        );
      }

      if (!response.ok) {
        const errorText = await readErrorText(response);
        const retryable = isRetryableStatus(response.status);
        logger.error(
          {
            event: "attribution.receipt_delivery_failed",
            nodeId,
            url,
            source,
            count: receipts.length,
            status: response.status,
            errorText,
            retryable,
          },
          "attribution receipt delivery failed"
        );
        throw new ReceiptDeliveryError(
          `POST ${url} -> ${response.status}: ${errorText}`,
          response.status,
          retryable
        );
      }
    },
  };
}
