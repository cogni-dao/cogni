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
});

import { LangfuseReadError } from "@/adapters/server/observability/langfuse-read-error";
import { LangfuseObservationPageSchema } from "@/contracts/nodes.langfuse.observations.v1.contract";
import { parseTraceQuery } from "@/features/nodes/observability-traces";

const FROM = "2026-10-23T00:00:00.000Z";
const TO = "2026-10-24T00:00:00.000Z";
const nativeQuery = (extra = "") =>
  parseTraceQuery(
    new URLSearchParams(`fromStartTime=${FROM}&toStartTime=${TO}${extra}`),
    NODE_ID
  );
const observation = (id = "obs-1") => ({
  id,
  traceId: "trace-1",
  startTime: "2026-10-23T03:00:00Z",
  endTime: "2026-10-23T03:00:01Z",
  projectId: "project",
  parentObservationId: null,
  type: "GENERATION",
  environment: "production",
  name: "generation",
  level: "ERROR",
  statusMessage: "failure",
  model: "model-1",
  modelId: null,
  inputPrice: null,
  outputPrice: null,
  totalPrice: null,
  input: JSON.stringify({
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          authorization: "super-secret",
          result: "read goal",
        }),
      },
    ],
    api_key: "sk-secret",
  }),
  output: JSON.stringify({
    choices: [
      {
        message: {
          content: "result",
          tool_calls: [{ function: { name: "goals", arguments: "{}" } }],
        },
      },
    ],
  }),
  metadata: {
    nodeId: NODE_ID,
    runId: "run-1",
    user_api_key_auth: "hidden",
    user_api_key_hash: "hidden",
    hidden_params: { email: "private@example.org" },
    requester_metadata: "hidden",
    billingAccountId: "hidden",
    arbitrary: "withheld",
  },
});
const nativeReader = () =>
  new HttpLangfuseReader({
    baseUrl: "https://lf.example.com",
    publicKey: "pk",
    secretKey: "sk-secret",
    ownership: { verifyObservation: vi.fn(async () => true) },
  });

describe("native Langfuse observation access", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("returns native data/meta, IO/tools/model/failures and recursively removes private metadata", async () => {
    const fetchSpy = mockFetch({
      data: [observation()],
      meta: { cursor: "upstream-next" },
    });
    vi.stubGlobal("fetch", fetchSpy);
    const result = LangfuseObservationPageSchema.parse(
      await nativeReader().listObservations(nativeQuery())
    );
    expect(result.data[0]).toMatchObject({
      id: "obs-1",
      model: "model-1",
      level: "ERROR",
      metadata: { nodeId: NODE_ID, runId: "run-1" },
    });
    expect(result.data[0]?.output).toContain("tool_calls");
    expect(JSON.stringify(result)).not.toMatch(
      /super-secret|sk-secret|private@example|user_api_key|hidden_params|billingAccountId|arbitrary/
    );
    expect(result.meta.cursor).not.toBe("upstream-next");
    const url = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as URL;
    expect(url.pathname).toBe("/api/public/v2/observations");
    expect(JSON.parse(url.searchParams.get("filter") ?? "[]")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "user_api_key_alias",
          value: `cogni:production:${NODE_ID}:app:v1`,
        }),
        expect.objectContaining({
          column: "startTime",
          operator: ">=",
          value: FROM,
        }),
      ])
    );
  });
  it("separates candidate-a logical scope from production storage and verifies every observation", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        data: [observation("owned"), observation("foreign")],
        meta: { cursor: "next" },
      })
    );
    const verify = vi.fn(
      async (_n: string, _e: string, row: Readonly<Record<string, unknown>>) =>
        row.id === "owned"
    );
    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk",
      ownership: { verifyObservation: verify },
    });
    const page = await reader.listObservations(
      nativeQuery("&environment=candidate-a")
    );
    expect(page.data.map((r) => r.id)).toEqual(["owned"]);
    expect(page.meta.cogni).toMatchObject({
      logicalEnvironment: "candidate-a",
      partial: true,
      attributionUnavailable: 1,
    });
    expect(page.meta.cursor).toBeTruthy();
    expect(verify).toHaveBeenCalledWith(
      NODE_ID,
      "candidate-a",
      expect.any(Object),
      expect.any(AbortSignal)
    );
  });
  it("binds cursor to tenant, filters, fields and limit and rejects signature forgery", async () => {
    const fetchSpy = mockFetch({ data: [], meta: { cursor: "next" } });
    vi.stubGlobal("fetch", fetchSpy);
    const reader = nativeReader();
    const query = nativeQuery();
    const cursor = (await reader.listObservations(query)).meta.cursor ?? "";
    for (const changed of [
      { ...query, nodeId: "foreign" },
      { ...query, environment: "preview" as const },
      { ...query, fields: "core" },
      { ...query, limit: 1 },
    ]) {
      await expect(
        reader.listObservations({ ...changed, cursor })
      ).rejects.toMatchObject({ code: "invalid_trace_cursor" });
    }
    await expect(
      reader.listObservations({ ...query, cursor: `${cursor}x` })
    ).rejects.toMatchObject({ code: "invalid_trace_cursor" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await reader.listObservations({ ...query, cursor });
    const url = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1]?.[0] as URL;
    expect(url.searchParams.get("cursor")).toBe("next");
  });
  it("rejects ownership override, duplicates, unknown parameters and unbounded windows", () => {
    for (const extra of [
      '&filter=[{"type":"string","column":"environment","operator":"=","value":"foreign"}]',
      "&nodeId=foreign",
      "&limit=101",
      "&projectId=other",
      "&fields=secret",
      "&limit=1&limit=2",
    ])
      expect(() => nativeQuery(extra)).toThrow();
    expect(() =>
      parseTraceQuery(
        new URLSearchParams(
          "fromStartTime=2026-10-01T00:00:00Z&toStartTime=2026-10-03T00:00:00Z"
        ),
        NODE_ID
      )
    ).toThrow();
    expect(nativeQuery().limit).toBe(50);
  });
  it("withholds oversized IO explicitly, stays within budget and forwards safe retry-after", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        data: [{ ...observation(), input: "a".repeat(100_000) }],
        meta: { cursor: null },
      })
    );
    const result = await nativeReader().listObservations(nativeQuery());
    expect(result.data[0]?.input).toBeNull();
    expect(result.meta.cogni.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("private auth upstream body", {
            status: 429,
            headers: { "retry-after": "5" },
          })
      )
    );
    await expect(
      nativeReader().listObservations(nativeQuery())
    ).rejects.toMatchObject({
      code: "observability_rate_limited",
      status: 429,
      retryAfter: "5",
    });
  });
});

describe("native field-group and failure conformance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("keeps sessionId in basic and tags in trace_context regardless of filter field selection", async () => {
    const row = {
      ...observation(),
      sessionId: "session-1",
      tags: ["node-tag"],
      release: "sha-1",
      traceName: "trace",
      bookmarked: true,
      public: false,
      userId: "withheld-user",
      modelId: "priced-model",
      inputPrice: "0.001",
    };
    vi.stubGlobal("fetch", mockFetch({ data: [row], meta: { cursor: null } }));
    const core = await nativeReader().listObservations(
      nativeQuery("&fields=core&sessionId=session-1")
    );
    expect(core.data).toHaveLength(1);
    expect(core.data[0]).not.toHaveProperty("sessionId");
    expect(core.data[0]).toMatchObject({ modelId: null, inputPrice: null });
    const basic = await nativeReader().listObservations(
      nativeQuery("&fields=basic")
    );
    expect(basic.data[0]).toMatchObject({
      sessionId: "session-1",
      bookmarked: true,
      public: false,
    });
    expect(basic.data[0]).not.toHaveProperty("tags");
    expect(basic.data[0]).not.toHaveProperty("userId");
    const context = await nativeReader().listObservations(
      nativeQuery("&fields=trace_context")
    );
    expect(context.data[0]).toMatchObject({
      tags: ["node-tag"],
      release: "sha-1",
      traceName: "trace",
    });
    expect(context.data[0]).not.toHaveProperty("sessionId");
  });

  it.each([
    "key",
    "bearer",
    "private_key",
    "private-key",
    "privateKey",
    "a_p_i-k_e_y",
  ])("redacts %s recursively inside native string IO", async (key) => {
    const row = {
      ...observation(),
      input: JSON.stringify({
        messages: [
          {
            content: JSON.stringify({
              nested: [{ [key]: "opaquecredentialvalue", safe: "useful" }],
            }),
          },
        ],
      }),
    };
    vi.stubGlobal("fetch", mockFetch({ data: [row], meta: { cursor: null } }));
    const result = await nativeReader().listObservations(nativeQuery());
    expect(typeof result.data[0]?.input).toBe("string");
    expect(result.data[0]?.input).not.toContain("opaquecredentialvalue");
    expect(result.data[0]?.input).toContain("useful");
  });

  it("propagates a receipt429 and timeout instead of successful attribution gaps", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ data: [observation()], meta: { cursor: null } })
    );
    for (const failure of [
      new LangfuseReadError("observability_rate_limited", 429, "5"),
      new LangfuseReadError("observability_upstream_timeout", 504),
    ]) {
      const reader = new HttpLangfuseReader({
        baseUrl: "https://lf.example.com",
        publicKey: "pk",
        secretKey: "sk",
        ownership: {
          verifyObservation: async () => {
            throw failure;
          },
        },
      });
      await expect(reader.listObservations(nativeQuery())).rejects.toBe(
        failure
      );
    }
  });

  it("enforces the native exclusive toStartTime boundary", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        data: [{ ...observation(), startTime: TO }],
        meta: { cursor: null },
      })
    );
    const result = await nativeReader().listObservations(nativeQuery());
    expect(result.data).toHaveLength(0);
    expect(result.meta.cogni.attributionUnavailable).toBe(1);
  });
});

describe("bounded regex input", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("withholds oversized unbroken tokens before scrubbing, preserving ordinary long transcripts", async () => {
    const token = "a".repeat(8192);
    const prose = "Ordinary transcript words stay readable. ".repeat(600);
    const row = {
      ...observation(),
      input: JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: JSON.stringify({
              before: "useful prefix",
              token,
              after: "useful suffix",
            }),
          },
        ],
      }),
      output: JSON.stringify({ content: prose }),
      statusMessage: `before ${token} after`,
    };
    vi.stubGlobal("fetch", mockFetch({ data: [row], meta: { cursor: null } }));
    const result = await nativeReader().listObservations(
      nativeQuery("&limit=1")
    );
    const readable = JSON.stringify(result.data[0]);
    expect(readable).not.toContain(token);
    expect(readable).toContain("[WITHHELD: oversized token]");
    expect(readable).toContain("useful prefix");
    expect(readable).toContain("useful suffix");
    expect(result.data[0]?.output).toBe(JSON.stringify({ content: prose }));
    expect(result.meta.cogni).toMatchObject({
      truncated: true,
      partial: true,
      attributionUnavailable: 0,
    });
  });
});
