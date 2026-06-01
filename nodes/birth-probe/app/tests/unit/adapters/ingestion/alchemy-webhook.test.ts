// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/ingestion/alchemy-webhook`
 * Purpose: Unit tests for Alchemy webhook normalizer — HMAC verification and tx hash extraction.
 * Scope: Tests verify() with real HMAC computation, normalize() with fixture payloads. Does not test network I/O.
 * Invariants: WEBHOOK_VERIFY_VIA_OSS, ACTIVITY_IDEMPOTENT
 * Side-effects: none
 * Links: src/adapters/server/ingestion/alchemy-webhook.ts
 * @public
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AlchemyWebhookNormalizer } from "@/adapters/server/ingestion/alchemy-webhook";

function sign(body: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("adapters/ingestion/alchemy-webhook", () => {
  const normalizer = new AlchemyWebhookNormalizer();
  const secret = "test-webhook-secret";

  describe("verify", () => {
    it("accepts valid HMAC signature", async () => {
      const body = Buffer.from('{"id":"test"}');
      const sig = sign(body, secret);
      const ok = await normalizer.verify(
        { "x-alchemy-signature": sig },
        body,
        secret
      );
      expect(ok).toBe(true);
    });

    it("rejects invalid signature", async () => {
      const body = Buffer.from('{"id":"test"}');
      const ok = await normalizer.verify(
        { "x-alchemy-signature": "deadbeef".repeat(8) },
        body,
        secret
      );
      expect(ok).toBe(false);
    });

    it("rejects missing signature header", async () => {
      const body = Buffer.from('{"id":"test"}');
      const ok = await normalizer.verify({}, body, secret);
      expect(ok).toBe(false);
    });
  });

  describe("normalize", () => {
    it("extracts tx hashes from ADDRESS_ACTIVITY payload", async () => {
      const payload = {
        id: "webhook-1",
        type: "ADDRESS_ACTIVITY",
        event: {
          data: {
            block: {
              logs: [
                { transaction: { hash: "0xaaa" } },
                { transaction: { hash: "0xbbb" } },
              ],
            },
          },
        },
      };

      const events = await normalizer.normalize({}, payload);
      expect(events).toHaveLength(2);
      expect(events[0].source).toBe("alchemy");
      expect(events[0].eventType).toBe("cogni_signal");
      expect(events[0].metadata).toMatchObject({ txHash: "0xaaa" });
      expect(events[1].metadata).toMatchObject({ txHash: "0xbbb" });
    });

    it("deduplicates tx hashes within delivery", async () => {
      const payload = {
        id: "webhook-2",
        type: "ADDRESS_ACTIVITY",
        event: {
          data: {
            block: {
              logs: [
                { transaction: { hash: "0xaaa" } },
                { transaction: { hash: "0xaaa" } },
              ],
            },
          },
        },
      };

      const events = await normalizer.normalize({}, payload);
      expect(events).toHaveLength(1);
    });

    it("returns empty array for payload with no logs", async () => {
      const events = await normalizer.normalize({}, {});
      expect(events).toHaveLength(0);
    });

    it("produces deterministic event IDs", async () => {
      const payload = {
        event: {
          data: {
            block: {
              logs: [{ transaction: { hash: "0xccc" } }],
            },
          },
        },
      };

      const events1 = await normalizer.normalize({}, payload);
      const events2 = await normalizer.normalize({}, payload);
      expect(events1[0].id).toBe(events2[0].id);
    });
  });
});
