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
    const otherNodeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const fetchSpy = mockFetch({
      data: [
        {
          id: "trace-1",
          timestamp: "2026-06-25T00:00:00Z",
          name: "graph-execution",
          tags: ["langgraph", "langgraph:poet", NODE_ID],
          metadata: { nodeId: NODE_ID, runId: "r1" },
        },
        {
          id: "trace-other-node",
          timestamp: "2026-06-25T00:01:00Z",
          name: "graph-execution",
          tags: ["langgraph", "langgraph:poet", otherNodeId],
          metadata: { nodeId: otherNodeId, runId: "r2" },
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

  it("gets trace detail by id with Basic auth (no key in URL)", async () => {
    const fetchSpy = mockFetch({
      id: "trace detail/1",
      timestamp: "2026-06-25T00:00:00Z",
      name: "graph-execution",
      tags: ["langgraph", NODE_ID],
      metadata: { nodeId: NODE_ID, runId: "r1" },
      input: { prompt: "hello" },
      output: { text: "world" },
      userId: "user-1",
      sessionId: "session-1",
      release: "sha-abc",
      version: "2026.06.25",
    });
    vi.stubGlobal("fetch", fetchSpy);

    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com/",
      publicKey: "pk-test",
      secretKey: "sk-secret",
    });
    const trace = await reader.getTrace({
      nodeId: NODE_ID,
      traceId: "trace detail/1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/public/traces/trace%20detail%2F1");
    expect(url.toString()).not.toContain("sk-secret");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${btoa("pk-test:sk-secret")}`);

    expect(trace).toEqual({
      id: "trace detail/1",
      name: "graph-execution",
      timestamp: "2026-06-25T00:00:00Z",
      tags: ["langgraph", NODE_ID],
      nodeId: NODE_ID,
      metadata: { nodeId: NODE_ID, runId: "r1" },
      input: { prompt: "hello" },
      output: { text: "world" },
      userId: "user-1",
      sessionId: "session-1",
      release: "sha-abc",
      version: "2026.06.25",
    });
  });

  it("accepts metadata.nodeId as trace detail node proof when tags are absent", async () => {
    const fetchSpy = mockFetch({
      id: "trace-1",
      timestamp: "2026-06-25T00:00:00Z",
      name: null,
      metadata: { nodeId: NODE_ID },
      input: "prompt",
      output: "answer",
    });
    vi.stubGlobal("fetch", fetchSpy);

    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk",
    });
    const trace = await reader.getTrace({
      nodeId: NODE_ID,
      traceId: "trace-1",
    });

    expect(trace?.nodeId).toBe(NODE_ID);
    expect(trace?.tags).toEqual([]);
    expect(trace?.input).toBe("prompt");
    expect(trace?.output).toBe("answer");
  });

  it("returns null for trace detail node-boundary mismatch or missing attribution", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "trace-conflicting-node",
            timestamp: "2026-06-25T00:00:00Z",
            tags: ["langgraph", NODE_ID],
            metadata: { nodeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
            input: { secret: "must not be returned" },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "trace-other-node",
            timestamp: "2026-06-25T00:00:00Z",
            tags: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
            metadata: { nodeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
            input: { secret: "must not be returned" },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "trace-unattributed",
            timestamp: "2026-06-25T00:00:00Z",
            input: { secret: "must not be returned" },
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchSpy);

    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk",
    });

    await expect(
      reader.getTrace({ nodeId: NODE_ID, traceId: "trace-conflicting-node" })
    ).resolves.toBeNull();
    await expect(
      reader.getTrace({ nodeId: NODE_ID, traceId: "trace-other-node" })
    ).resolves.toBeNull();
    await expect(
      reader.getTrace({ nodeId: NODE_ID, traceId: "trace-unattributed" })
    ).resolves.toBeNull();
  });

  it("returns null for upstream trace detail 404", async () => {
    const fetchSpy = mockFetch({ message: "not found" }, false, 404);
    vi.stubGlobal("fetch", fetchSpy);

    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk",
    });

    await expect(
      reader.getTrace({ nodeId: NODE_ID, traceId: "missing" })
    ).resolves.toBeNull();
  });
});
