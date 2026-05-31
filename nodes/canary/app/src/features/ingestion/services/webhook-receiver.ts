// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ingestion/services/webhook-receiver`
 * Purpose: Feature service for receiving and processing webhook payloads from external platforms.
 * Scope: Orchestrates verify → normalize → insert receipt pipeline. Uses ports only (AttributionStore, DataSourceRegistration). Does not perform HTTP I/O or hold mutable state.
 * Invariants:
 * - WEBHOOK_VERIFY_BEFORE_NORMALIZE: verify() is always called before normalize()
 * - RECEIPT_IDEMPOTENT: Events use deterministic IDs, inserted with ON CONFLICT DO NOTHING
 * - WEBHOOK_RECEIPT_APPEND_EXEMPT: Receipt insertion bypasses WRITES_VIA_TEMPORAL (safe per RECEIPT_IDEMPOTENT + RECEIPT_APPEND_ONLY)
 * Side-effects: IO (insertIngestionReceipts)
 * Links: docs/spec/attribution-ledger.md
 * @public
 */

import type { AttributionStore, DataSourceRegistration } from "@/ports";

/**
 * Dependencies for the webhook receiver service.
 * Injected at bootstrap — the service holds no mutable state.
 */
export interface WebhookReceiverDeps {
  readonly attributionStore: AttributionStore;
  readonly sourceRegistrations: ReadonlyMap<string, DataSourceRegistration>;
  readonly nodeId: string;
}

/**
 * Result from processing a webhook.
 */
export interface WebhookReceiveResult {
  readonly eventCount: number;
  readonly source: string;
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
  const { attributionStore, sourceRegistrations, nodeId } = deps;
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
  const events = await registration.webhook.normalize(headers, parsed);

  if (events.length === 0) {
    return { eventCount: 0, source };
  }

  // 4. Insert receipts (RECEIPT_IDEMPOTENT via ON CONFLICT DO NOTHING)
  await attributionStore.insertIngestionReceipts(
    events.map((e) => ({
      receiptId: e.id,
      nodeId,
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
      retrievedAt: new Date(),
    }))
  );

  return { eventCount: events.length, source };
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
