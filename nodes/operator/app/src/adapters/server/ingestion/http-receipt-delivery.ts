// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/ingestion/http-receipt-delivery`
 * Purpose: HTTP delivery of normalized attribution receipts from the operator gateway to the
 *   OWNING node's own ledger (`POST {nodeUrl}/api/internal/attribution/receipts`). Mirrors the
 *   scheduler-worker's `run-http` adapter (nodeId → nodeUrl lookup, Bearer SCHEDULER_API_TOKEN,
 *   retryable-vs-permanent status classification, structured error logging).
 * Scope: One factory (`createHttpReceiptDelivery`) → a `deliverReceipts(nodeId, source, receipts)`
 *   client for FOREIGN (remote) owning nodes. Does not touch a DB — the operator's own-node write
 *   stays a local write in `receiveWebhook`; remote nodes persist receipts in their OWN ledger
 *   (NODE_WRITES_OWN_LEDGER). Receipt `Date` fields are serialized to ISO strings for the wire.
 * Invariants:
 *   - NO_DB_IN_DELIVERY: only fetch(); the owning node stamps its own node_id.
 *   - nodeId is resolved against COGNI_NODE_ENDPOINTS at call time; unknown → throw (fail fast).
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
import type { ReceiptDelivery } from "@/ports";
import type { Logger } from "@/shared/observability";

// ReceiptDelivery port lives in @/ports/receipt-delivery.port; this adapter implements it.

export interface HttpReceiptDeliveryDeps {
  /** nodeId → base URL, parsed from COGNI_NODE_ENDPOINTS. */
  readonly nodeEndpoints: ReadonlyMap<string, string>;
  /** Bearer token for the internal dispatch identity (SCHEDULER_API_TOKEN). */
  readonly schedulerApiToken: string;
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

function resolveNodeUrl(
  nodeEndpoints: ReadonlyMap<string, string>,
  nodeId: string
): string {
  const url = nodeEndpoints.get(nodeId);
  if (!url) {
    throw new ReceiptDeliveryError(
      `Unknown nodeId "${nodeId}" — not in COGNI_NODE_ENDPOINTS`,
      0,
      false
    );
  }
  return url.replace(/\/$/, "");
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
  const { nodeEndpoints, schedulerApiToken, logger } = deps;

  return {
    async deliverReceipts(nodeId, source, receipts): Promise<void> {
      if (receipts.length === 0) return;

      const base = resolveNodeUrl(nodeEndpoints, nodeId);
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
