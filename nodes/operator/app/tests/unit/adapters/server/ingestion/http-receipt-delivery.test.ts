// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ingestion/http-receipt-delivery`
 * Purpose: Pin direct catalog-target delivery, its deterministic idempotency key, and that the
 *   delivery URL comes from the node's PLACEMENT rather than a hardcoded in-cluster convention.
 * Scope: HTTP adapter with mocked fetch + a fake NodeAddressPort; no network or database access.
 * Invariants: NODE_WRITES_OWN_LEDGER, RECEIPT_IDEMPOTENT, CATALOG_TARGET_IS_ROUTING_AUTHORITY,
 *   PLACEMENT_DECIDES_THE_ADDRESS.
 * Side-effects: replaces global fetch for each test.
 * Links: src/adapters/server/ingestion/http-receipt-delivery.ts, bug.5052, bug.5106
 * @public
 */

import type { InsertReceiptParams } from "@cogni/attribution-ledger";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHttpReceiptDelivery,
  type ReceiptDeliveryError,
} from "@/adapters/server/ingestion/http-receipt-delivery";
import { NodeAddressError, type NodeAddressPort } from "@/ports";

const receipt: InsertReceiptParams = {
  receiptId: "github:pr:cogni-test-org/fresh-node:42:merged",
  nodeId: "00000000-0000-4000-8000-000000000001",
  source: "github",
  eventType: "pr_merged",
  platformUserId: "123",
  platformLogin: "contributor",
  artifactUrl: "https://github.com/cogni-test-org/fresh-node/pull/42",
  metadata: { repo: "cogni-test-org/fresh-node" },
  payloadHash: "a".repeat(64),
  producer: "github:webhook",
  producerVersion: "test.v1",
  eventTime: new Date("2026-08-18T00:00:00.000Z"),
  retrievedAt: new Date("2026-08-18T00:00:01.000Z"),
};

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

/** Stand-in for the placement-aware resolver the container injects. */
function addressPort(baseUrlBySlug: Record<string, string>): NodeAddressPort {
  return {
    resolveNodeAppBaseUrl: async (slug) => {
      const base = baseUrlBySlug[slug];
      if (!base) throw new NodeAddressError(`no address for ${slug}`, slug);
      return base;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createHttpReceiptDelivery", () => {
  it("derives the child service URL from the routed slug and reuses one idempotency key", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const delivery = createHttpReceiptDelivery({
      schedulerApiToken: "scheduler-token",
      nodeAddress: addressPort({
        "fresh-node": "http://fresh-node-node-app:3000",
      }),
      logger: silentLogger,
    });
    const target = {
      nodeId: "00000000-0000-4000-8000-000000000001",
      slug: "fresh-node",
    };

    await delivery.deliverReceipts(target, "github", [receipt]);
    await delivery.deliverReceipts(target, "github", [receipt]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(
        "http://fresh-node-node-app:3000/api/internal/attribution/receipts"
      );
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer scheduler-token",
        "Idempotency-Key":
          "00000000-0000-4000-8000-000000000001/github:pr:cogni-test-org/fresh-node:42:merged",
      });
    }
  });

  it("delivers to the EXTERNAL address when placement puts the node off-cluster (bug.5106)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const delivery = createHttpReceiptDelivery({
      schedulerApiToken: "scheduler-token",
      // An akash-placed node has no `<slug>-node-app` Service; the resolver hands back the
      // public host its workload publishes, and the adapter must dial exactly that.
      nodeAddress: addressPort({ toks4: "https://toks4-test.cognidao.org" }),
      logger: silentLogger,
    });

    await delivery.deliverReceipts(
      { nodeId: "00000000-0000-4000-8000-000000000002", slug: "toks4" },
      "github",
      [receipt]
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://toks4-test.cognidao.org/api/internal/attribution/receipts"
    );
  });

  it("fails loud with retryability when the child rejects delivery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rolling", { status: 503 }))
    );
    const delivery = createHttpReceiptDelivery({
      schedulerApiToken: "scheduler-token",
      nodeAddress: addressPort({
        "fresh-node": "http://fresh-node-node-app:3000",
      }),
      logger: silentLogger,
    });

    const attempt = delivery.deliverReceipts(
      {
        nodeId: "00000000-0000-4000-8000-000000000001",
        slug: "fresh-node",
      },
      "github",
      [receipt]
    );

    await expect(attempt).rejects.toMatchObject<Partial<ReceiptDeliveryError>>({
      name: "ReceiptDeliveryError",
      status: 503,
      retryable: true,
    });
  });
});
