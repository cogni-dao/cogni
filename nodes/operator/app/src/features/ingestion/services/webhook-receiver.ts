// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ingestion/services/webhook-receiver`
 * Purpose: Feature service for receiving and processing webhook payloads from external platforms.
 * Scope: Orchestrates verify → normalize → deliver/insert receipt pipeline. Uses ports only
 *   (AttributionStore, DataSourceRegistration, ReceiptDelivery). Does not perform HTTP I/O directly
 *   (delegates to the injected ReceiptDelivery) or hold mutable state.
 * Invariants:
 * - WEBHOOK_VERIFY_BEFORE_ROUTE: verify() completes before payload parsing, routing, normalization,
 *   persistence, or downstream dispatch
 * - RECEIPT_IDEMPOTENT: Events use deterministic IDs, inserted with ON CONFLICT DO NOTHING
 * - WEBHOOK_RECEIPT_APPEND_EXEMPT: Receipt insertion bypasses WRITES_VIA_TEMPORAL (safe per RECEIPT_IDEMPOTENT + RECEIPT_APPEND_ONLY)
 * - NODE_WRITES_OWN_LEDGER: only the operator's OWN repos write to the operator's local store;
 *   receipts for a FOREIGN owning node are DELIVERED over HTTP so that node persists them in its
 *   own ledger. The own-node path is byte-for-byte behavior-preserving (regression guard).
 * - UNROUTABLE_NEVER_WRITES: a verified webhook with no unique attribution target may still drive
 *   non-attribution webhook hooks, but it writes no receipt to any ledger.
 * Side-effects: IO (insertIngestionReceipts for own node; HTTP delivery for foreign nodes)
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger,
 *   nodes/operator/app/src/adapters/server/ingestion/http-receipt-delivery.ts
 * @public
 */

import type { InsertReceiptParams } from "@cogni/attribution-ledger";
import type {
  AttributionStore,
  DataSourceRegistration,
  ReceiptDelivery,
  ReceiptDeliveryTarget,
} from "@/ports";
import type { Logger } from "@/shared/observability";

/**
 * Dependencies for the webhook receiver service.
 * Injected at bootstrap — the service holds no mutable state.
 */
export interface WebhookReceiverDeps {
  readonly attributionStore: AttributionStore;
  readonly sourceRegistrations: ReadonlyMap<string, DataSourceRegistration>;
  /** Unique owning node for these receipts, or null when attribution routing failed closed. */
  readonly target: ReceiptDeliveryTarget | null;
  /** The operator's OWN node_id. When `nodeId === operatorNodeId` → local store write (no regression). */
  readonly operatorNodeId: string;
  /** HTTP delivery client for foreign owning nodes (NODE_WRITES_OWN_LEDGER). */
  readonly receiptDelivery: ReceiptDelivery;
  /** Structured logger — used to emit the `attribution.receipt_delivered` event on remote delivery. */
  readonly logger: Logger;
}

export interface VerifiedWebhook {
  readonly source: string;
  readonly headers: Record<string, string>;
  readonly payload: Record<string, unknown>;
  readonly registration: DataSourceRegistration;
}

/**
 * Result from processing a webhook.
 *
 * `receipts` summarizes the normalized ActivityEvents persisted on this call
 * (idempotent via ON CONFLICT DO NOTHING). Surfaced so the route can emit
 * ingestion telemetry — without it, attribution ingestion was unobservable
 * (the route only logged the raw normalized count, never which contributors /
 * event types actually reached the ledger).
 */
export interface WebhookReceiveResult {
  readonly eventCount: number;
  readonly source: string;
  readonly persisted: boolean;
  readonly receipts: ReadonlyArray<{
    readonly receiptId: string;
    readonly eventType: string;
    readonly platformLogin: string | null;
  }>;
}

/**
 * Receive and process a webhook payload.
 *
 * Pipeline: lookup registration → verify signature → normalize payload → insert receipts.
 * Returns the number of events inserted. Throws on verification failure.
 */
export async function receiveWebhook(
  deps: WebhookReceiverDeps,
  params: {
    readonly source: string;
    readonly headers: Record<string, string>;
    readonly body: Buffer;
    readonly secret: string;
  }
): Promise<WebhookReceiveResult> {
  const { sourceRegistrations } = deps;
  const verified = await verifyWebhook(sourceRegistrations, params);
  return receiveVerifiedWebhook(deps, verified);
}

/** Verify and parse exactly once before any routing lookup or downstream side effect. */
export async function verifyWebhook(
  sourceRegistrations: ReadonlyMap<string, DataSourceRegistration>,
  params: {
    readonly source: string;
    readonly headers: Record<string, string>;
    readonly body: Buffer;
    readonly secret: string;
  }
): Promise<VerifiedWebhook> {
  const { source, headers, body, secret } = params;

  // 1. Lookup registration
  const registration = sourceRegistrations.get(source);
  if (!registration?.webhook) {
    throw new WebhookSourceNotFoundError(source);
  }

  // 2. Verify signature (WEBHOOK_VERIFY_BEFORE_NORMALIZE)
  const valid = await registration.webhook.verify(headers, body, secret);
  if (!valid) {
    throw new WebhookVerificationError(source);
  }

  // 3. Normalize payload to ActivityEvent[]
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    throw new WebhookPayloadParseError(source);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WebhookPayloadParseError(source);
  }
  return {
    source,
    headers,
    payload: parsed as Record<string, unknown>,
    registration,
  };
}

/** Normalize and persist a payload that has crossed the positive verification boundary. */
export async function receiveVerifiedWebhook(
  deps: Omit<WebhookReceiverDeps, "sourceRegistrations">,
  verified: VerifiedWebhook
): Promise<WebhookReceiveResult> {
  const { attributionStore, target, operatorNodeId, receiptDelivery, logger } =
    deps;
  const { source, headers, payload, registration } = verified;
  if (!registration.webhook) {
    // verifyWebhook guarantees this; keep the processing boundary total for direct callers.
    throw new WebhookSourceNotFoundError(source);
  }
  const events = await registration.webhook.normalize(headers, payload);

  if (events.length === 0) {
    return { eventCount: 0, source, persisted: false, receipts: [] };
  }

  const receiptSummaries = events.map((e) => ({
    receiptId: e.id,
    eventType: e.eventType,
    platformLogin: e.platformLogin ?? null,
  }));

  // A verified, normalized event may still be unrelated to any declared attribution profile.
  // Keep its summaries for diagnostics and downstream webhook hooks, but never invent an owner.
  if (target === null) {
    return {
      eventCount: events.length,
      source,
      persisted: false,
      receipts: receiptSummaries,
    };
  }

  // 4. Build receipts once (RECEIPT_IDEMPOTENT via deterministic e.id).
  const retrievedAt = new Date();
  const receipts: InsertReceiptParams[] = events.map((e) => ({
    receiptId: e.id,
    nodeId: target.nodeId,
    source: e.source,
    eventType: e.eventType,
    platformUserId: e.platformUserId,
    platformLogin: e.platformLogin ?? null,
    artifactUrl: e.artifactUrl ?? null,
    metadata: e.metadata ?? null,
    payloadHash: e.payloadHash,
    producer: `${e.source}:webhook`,
    producerVersion: registration.version,
    eventTime: e.eventTime,
    retrievedAt,
  }));

  // 5. Route receipts to the owning node's ledger.
  //   - OWN node (operator repos): local store write, UNCHANGED (no-regression path).
  //   - FOREIGN node (#1924 source_refs owner): deliver over HTTP so the node writes its OWN ledger
  //     (NODE_WRITES_OWN_LEDGER). ON CONFLICT DO NOTHING keyed on (node_id, receipt_id) both ways.
  if (target.nodeId === operatorNodeId) {
    await attributionStore.insertIngestionReceipts(receipts);
  } else {
    await receiptDelivery.deliverReceipts(target, source, receipts);
    logger.info(
      {
        event: "attribution.receipt_delivered",
        nodeId: target.nodeId,
        slug: target.slug,
        source,
        count: receipts.length,
      },
      "attribution receipts delivered to owning node"
    );
  }

  return {
    eventCount: events.length,
    source,
    persisted: true,
    receipts: receiptSummaries,
  };
}

/**
 * Error thrown when no webhook normalizer is registered for the given source.
 */
export class WebhookSourceNotFoundError extends Error {
  constructor(source: string) {
    super(`No webhook normalizer registered for source: ${source}`);
    this.name = "WebhookSourceNotFoundError";
  }
}

/**
 * Error thrown when webhook signature verification fails.
 */
export class WebhookVerificationError extends Error {
  constructor(source: string) {
    super(`Webhook signature verification failed for source: ${source}`);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Error thrown when webhook body cannot be parsed as JSON.
 */
export class WebhookPayloadParseError extends Error {
  constructor(source: string) {
    super(`Malformed webhook payload for source: ${source}`);
    this.name = "WebhookPayloadParseError";
  }
}
