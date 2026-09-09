// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ingestion/http-epochs-read`
 * Purpose: Pin that the foreign-node epochs proxy dials the address the node's PLACEMENT resolves
 *   to — the public host for an off-cluster node, in-cluster Service DNS for a k3s one (bug.5106).
 * Scope: HTTP adapter with mocked fetch + a fake NodeAddressPort; no network or database access.
 * Invariants: NO_DB_IN_READ, PLACEMENT_DECIDES_THE_ADDRESS, OPERATOR_AGGREGATES_ARE_DERIVED.
 * Side-effects: replaces global fetch for each test.
 * Links: src/adapters/server/ingestion/http-epochs-read.ts, bug.5008, bug.5106
 * @internal
 */

import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpEpochsRead } from "@/adapters/server/ingestion/http-epochs-read";
import type { EpochsReadError, NodeAddressPort } from "@/ports";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const EMPTY_PAGE = { epochs: [], total: 0 };

function addressPort(baseUrl: string): NodeAddressPort {
  return { resolveNodeAppBaseUrl: async () => baseUrl };
}

function read(baseUrl: string) {
  return createHttpEpochsRead({
    schedulerApiToken: "scheduler-token",
    nodeAddress: addressPort(baseUrl),
    logger: silentLogger,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createHttpEpochsRead", () => {
  it("reads a k3s-placed node over in-cluster Service DNS", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(EMPTY_PAGE), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await read("http://blue-node-app:3000").listEpochsForForeignNode("blue", {
      limit: 20,
      offset: 0,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://blue-node-app:3000/api/internal/attribution/epochs?slug=blue&limit=20&offset=0"
    );
  });

  it("reads an akash-placed node at its EXTERNAL public address", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(EMPTY_PAGE), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await read("https://toks4-test.cognidao.org").listEpochsForForeignNode(
      "toks4",
      { limit: 20, offset: 0 }
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://toks4-test.cognidao.org/api/internal/attribution/epochs?slug=toks4&limit=20&offset=0"
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer scheduler-token",
    });
  });

  it("classifies an upstream failure as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rolling", { status: 503 }))
    );

    await expect(
      read("https://toks4-test.cognidao.org").listEpochsForForeignNode(
        "toks4",
        {
          limit: 20,
          offset: 0,
        }
      )
    ).rejects.toMatchObject<Partial<EpochsReadError>>({
      name: "EpochsReadError",
      status: 503,
      retryable: true,
    });
  });
});
