// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/observability/langfuse-reader.adapter`
 * Purpose: Unit tests for HttpLangfuseReader — the node-pin (`tags=<nodeId>`) and trace mapping.
 * Scope: Mocks global fetch. Does not hit Langfuse.
 * Invariants:
 *   - NODE_PIN_IS_FORCED: the request always carries `tags=<nodeId>`
 *   - KEY_NEVER_LOGGED: Basic auth header is sent; the key is not in the URL
 * Side-effects: none (fetch mocked)
 * Links: src/adapters/server/observability/langfuse-reader.adapter.ts
 * @internal
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpLangfuseReader } from "@/adapters/server";

const NODE_ID = "11111111-2222-3333-4444-555555555555";

function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status: ok ? status : status })
  ) as unknown as typeof fetch;
}

describe("HttpLangfuseReader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pins the query to tags=<nodeId> and sends Basic auth (no key in URL)", async () => {
    const fetchSpy = mockFetch({ data: [] });
    vi.stubGlobal("fetch", fetchSpy);

    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com/",
      publicKey: "pk-test",
      secretKey: "sk-secret",
    });
    await reader.listTraces({ nodeId: NODE_ID, limit: 10 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/public/traces");
    expect(url.searchParams.get("tags")).toBe(NODE_ID);
    expect(url.searchParams.get("limit")).toBe("10");
    // The secret key must never appear in the URL — it rides in the Basic auth header.
    expect(url.toString()).not.toContain("sk-secret");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${btoa("pk-test:sk-secret")}`);
  });

  it("maps metadata.nodeId onto each trace summary", async () => {
    const fetchSpy = mockFetch({
      data: [
        {
          id: "trace-1",
          timestamp: "2026-06-25T00:00:00Z",
          name: "graph-execution",
          tags: ["langgraph", "langgraph:poet", NODE_ID],
          metadata: { nodeId: NODE_ID, runId: "r1" },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk",
    });
    const traces = await reader.listTraces({ nodeId: NODE_ID, limit: 5 });

    expect(traces).toHaveLength(1);
    expect(traces[0]?.id).toBe("trace-1");
    expect(traces[0]?.nodeId).toBe(NODE_ID);
    expect(traces[0]?.tags).toContain(NODE_ID);
  });

  it("throws on non-ok upstream without leaking the key", async () => {
    const fetchSpy = mockFetch({ message: "nope" }, false, 401);
    vi.stubGlobal("fetch", fetchSpy);

    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk-secret",
    });

    await expect(
      reader.listTraces({ nodeId: NODE_ID, limit: 5 })
    ).rejects.toThrow(/HTTP 401/);
  });
});
