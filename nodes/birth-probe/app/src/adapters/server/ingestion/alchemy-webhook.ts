// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ingestion/alchemy-webhook`
 * Purpose: Alchemy webhook normalizer — verifies HMAC signature and normalizes on-chain event payloads to ActivityEvent[].
 * Scope: Implements WebhookNormalizer from @cogni/ingestion-core; does not decode CogniAction events.
 *   Uses Node.js crypto for HMAC-SHA256 verification. Extracts transaction hashes from Alchemy ADDRESS_ACTIVITY webhooks.
 * Invariants:
 * - WEBHOOK_VERIFY_VIA_OSS: Signature verification via Node.js crypto (timingSafeEqual)
 * - WEBHOOK_VERIFY_BEFORE_NORMALIZE: verify() must be called before normalize() — enforced by feature service
 * - ACTIVITY_IDEMPOTENT: Deterministic event IDs from tx hash (same tx hash always produces same event ID)
 * Side-effects: none
 * Links: docs/spec/governance-signal-execution.md
 * @internal
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { ActivityEvent, WebhookNormalizer } from "@cogni/ingestion-core";
import { buildEventId, hashCanonicalPayload } from "@cogni/ingestion-core";

export const ALCHEMY_ADAPTER_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Alchemy webhook payload types (ADDRESS_ACTIVITY)
// ---------------------------------------------------------------------------

interface AlchemyLog {
  transaction?: {
    hash?: string;
  };
}

interface AlchemyWebhookBody {
  id?: string;
  type?: string;
  event?: {
    data?: {
      block?: {
        logs?: AlchemyLog[];
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Alchemy webhook normalizer.
 * Verifies HMAC-SHA256 signature and extracts transaction hashes from
 * ADDRESS_ACTIVITY webhook payloads as ActivityEvent[].
 *
 * The actual CogniAction event decoding happens in the signal handler service,
 * NOT here — this normalizer only records that a relevant tx occurred.
 */
export class AlchemyWebhookNormalizer implements WebhookNormalizer {
  readonly supportedEvents = [
    "ADDRESS_ACTIVITY",
  ] as const satisfies readonly string[];

  async verify(
    headers: Record<string, string>,
    body: Buffer,
    secret: string
  ): Promise<boolean> {
    const signature = headers["x-alchemy-signature"];
    if (!signature) return false;

    try {
      const mac = createHmac("sha256", secret).update(body).digest("hex");
      return timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(mac, "hex")
      );
    } catch {
      return false;
    }
  }

  async normalize(
    _headers: Record<string, string>,
    body: unknown
  ): Promise<ActivityEvent[]> {
    const payload = body as AlchemyWebhookBody;
    const logs = payload?.event?.data?.block?.logs ?? [];
    const events: ActivityEvent[] = [];

    // Deduplicate tx hashes within a single webhook delivery
    const seenHashes = new Set<string>();

    for (const log of logs) {
      const txHash = log.transaction?.hash;
      if (!txHash || seenHashes.has(txHash)) continue;
      seenHashes.add(txHash);

      const id = buildEventId("alchemy", "cogni_signal", txHash);
      const payloadHash = await hashCanonicalPayload({ txHash, id });

      events.push({
        id,
        source: "alchemy",
        eventType: "cogni_signal",
        // On-chain signals have no platform user — executor address is in metadata
        platformUserId: "",
        artifactUrl: "",
        metadata: {
          txHash,
          webhookId: payload.id ?? null,
          webhookType: payload.type ?? null,
        },
        payloadHash,
        eventTime: new Date(),
      });
    }

    return events;
  }
}
