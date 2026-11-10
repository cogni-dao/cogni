// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/observability/langfuse-reader.adapter`
 * Purpose: Reader/verifier regressions for native IO projection, privacy, resource bounds and node pinning.
 * Scope: Real reader and ownership verifier with synthetic native/receipt HTTP; no live Langfuse.
 * Invariants:
 *   - NODE_PIN_IS_FORCED: the request always carries `tags=<nodeId>`
 *   - KEY_NEVER_LOGGED: Basic auth header is sent; the key is not in the URL
 * Side-effects: none (fetch mocked)
 * Links: src/adapters/server/observability/langfuse-reader.adapter.ts
 * @internal
 */

import { scrubStringContent } from "@cogni/node-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpLangfuseReader } from "@/adapters/server/observability/langfuse-reader.adapter";

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
      operatorEnvironment: "production",
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
      operatorEnvironment: "production",
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
      operatorEnvironment: "production",
    });

    await expect(
      reader.listTraces({ nodeId: NODE_ID, limit: 5 })
    ).rejects.toThrow(/HTTP 401/);
  });
});

import { HttpLangfuseOwnershipVerifier } from "@/adapters/server/observability/langfuse-ownership.adapter";
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
    operatorEnvironment: "production",
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
      operatorEnvironment: "production",
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
        operatorEnvironment: "production",
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

describe("aggregate pre-scrub work budget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("bounds repeated short tokens across status, tags and allowlisted metadata before scrubbing", async () => {
    const repeated = `${"a".repeat(2048)} `.repeat(24);
    const rows = ["obs-a", "obs-b"].map((id) => ({
      ...observation(id),
      statusMessage: repeated,
      tags: [repeated],
      metadata: {
        nodeId: NODE_ID,
        graphName: repeated,
        user_api_key_auth: "private-only".repeat(1000),
      },
    }));
    vi.stubGlobal(
      "fetch",
      mockFetch({ data: rows, meta: { cursor: "upstream-next" } })
    );
    const result = await nativeReader().listObservations(
      nativeQuery("&limit=100")
    );
    expect(result.data.map((row) => row.id)).toEqual(["obs-a", "obs-b"]);
    for (const row of result.data) {
      expect(row).toMatchObject({
        statusMessage: null,
        tags: null,
        metadata: null,
      });
      expect(row.output).toContain("tool_calls");
    }
    expect(result.meta.cogni).toMatchObject({
      truncated: true,
      partial: true,
      attributionUnavailable: 0,
    });
    expect(result.meta.cursor).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(repeated);
  });

  it("returns an explicit bounded failure when required identity alone exceeds a row budget", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        data: [observation("x".repeat(12_000))],
        meta: { cursor: "next" },
      })
    );
    await expect(
      nativeReader().listObservations(nativeQuery("&limit=100"))
    ).rejects.toMatchObject({
      code: "observability_response_too_large",
      status: 502,
    });
  });
});

it("retains private literal redaction context after allowlisting and raw budgeting", async () => {
  const fingerprint = "fingerprint-literal-from-original-private-metadata";
  const row = {
    ...observation(),
    input: JSON.stringify({
      content: `Useful text ${fingerprint} remains useful`,
    }),
    metadata: {
      nodeId: NODE_ID,
      user_api_key_hash: fingerprint,
      user_api_key_auth: "private-context-only".repeat(1000),
    },
  };
  vi.stubGlobal("fetch", mockFetch({ data: [row], meta: { cursor: null } }));
  try {
    const result = await nativeReader().listObservations(nativeQuery());
    expect(JSON.stringify(result)).not.toContain(fingerprint);
    expect(JSON.stringify(result)).not.toContain("user_api_key");
    expect(result.data[0]?.input).toBe("[REDACTED]");
    expect(result.meta.cogni).toMatchObject({ truncated: true, partial: true });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("preserves a normal nested tool schema without false truncation", async () => {
  let schema: unknown = { type: "string", description: "todo status" };
  for (let i = 0; i < 11; i++) schema = { properties: schema };
  const input = JSON.stringify({ tools: schema });
  vi.stubGlobal(
    "fetch",
    mockFetch({ data: [{ ...observation(), input }], meta: { cursor: null } })
  );
  try {
    const result = await nativeReader().listObservations(nativeQuery());
    expect(result.data[0]?.input).toBe(input);
    expect(result.meta.cogni.truncated).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("bounded upstream subpages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const oversized = () =>
    new Response("body must not be parsed", {
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
    });

  it("retries the same cursor on byte overflow and resumes from the successful page without duplicates", async () => {
    const seen: Array<{
      limit: string | null;
      cursor: string | null;
      signal: AbortSignal | null | undefined;
    }> = [];
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      const limit = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor");
      seen.push({ limit, cursor, signal: init.signal });
      if (limit === "10") return oversized();
      const ids = cursor === "after-two" ? ["three", "four"] : ["one", "two"];
      return new Response(
        JSON.stringify({
          data: ids.map(observation),
          meta: { cursor: cursor === "after-two" ? null : "after-two" },
        })
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const reader = nativeReader();
    const query = nativeQuery();
    const first = await reader.listObservations(query);
    const second = await reader.listObservations({
      ...query,
      cursor: first.meta.cursor ?? "",
    });
    expect([...first.data, ...second.data].map((row) => row.id)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    expect(seen.map(({ limit, cursor }) => ({ limit, cursor }))).toEqual([
      { limit: "10", cursor: null },
      { limit: "2", cursor: null },
      { limit: "10", cursor: "after-two" },
      { limit: "2", cursor: "after-two" },
    ]);
    expect(seen[0]?.signal).toBe(seen[1]?.signal);
    expect(seen[2]?.signal).toBe(seen[3]?.signal);
    expect(first.meta.cogni).toMatchObject({
      upstreamPageSize: 2,
      upstreamByteLimited: true,
      partial: true,
    });
    expect(second.meta.cursor).toBeNull();
  });

  it.each([
    1, 50,
  ])("fails explicitly for an oversized single observation with requested limit %s", async (limit) => {
    const fetcher = vi.fn(async () => oversized());
    vi.stubGlobal("fetch", fetcher);
    await expect(
      nativeReader().listObservations(nativeQuery(`&limit=${limit}`))
    ).rejects.toMatchObject({
      code: "observability_response_too_large",
      status: 502,
    });
    expect(fetcher).toHaveBeenCalledTimes(limit === 1 ? 1 : 3);
  });

  it("does not retry a backend429 as a smaller page", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("private upstream error", {
          status: 429,
          headers: { "retry-after": "5" },
        })
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      nativeReader().listObservations(nativeQuery())
    ).rejects.toMatchObject({
      code: "observability_rate_limited",
      status: 429,
      retryAfter: "5",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("configured operator lane binding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  function localReader(operatorEnvironment?: string, operatorNodeId = NODE_ID) {
    return new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk-secret",
      operatorNodeId,
      ...(operatorEnvironment ? { operatorEnvironment } : {}),
      ownership: { verifyObservation: vi.fn(async () => true) },
    });
  }

  it("reads a real candidate-partition generation and rejects a returned production record", async () => {
    const row = {
      ...observation("candidate-owned"),
      environment: "candidate-a",
    };
    const fetcher = mockFetch({
      data: [row, observation("wrong-partition")],
      meta: { cursor: "next" },
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await localReader("candidate-a").listObservations(
      nativeQuery("&environment=candidate-a")
    );
    expect(result.data.map((row) => row.id)).toEqual(["candidate-owned"]);
    expect(result.data[0]?.environment).toBe("candidate-a");
    expect(result.meta.cogni).toMatchObject({
      logicalEnvironment: "candidate-a",
      attributionUnavailable: 1,
      partial: true,
    });
    const url = (fetcher as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as URL;
    expect(JSON.parse(url.searchParams.get("filter") ?? "[]")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: "metadata",
          key: "nodeId",
          value: NODE_ID,
        }),
        expect.objectContaining({
          column: "environment",
          value: "candidate-a",
        }),
      ])
    );
  });

  it.each([
    undefined,
    "production",
    "preview",
  ])("rejects unsupported candidate custody from configured lane %s before IO", async (lane) => {
    const fetcher = mockFetch({ data: [], meta: { cursor: null } });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      localReader(lane).listObservations(
        nativeQuery("&environment=candidate-a")
      )
    ).rejects.toMatchObject({ code: "attribution_unavailable", status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains production operator reads and production storage for sovereign candidate aliases", async () => {
    const fetcher = mockFetch({
      data: [observation()],
      meta: { cursor: null },
    });
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await localReader("production").listObservations(nativeQuery())).data
    ).toHaveLength(1);
    const sovereign = await localReader(
      "production",
      "another-operator"
    ).listObservations(nativeQuery("&environment=candidate-a"));
    expect(sovereign.data).toHaveLength(1);
    const url = (fetcher as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1]?.[0] as URL;
    expect(JSON.parse(url.searchParams.get("filter") ?? "[]")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "user_api_key_alias",
          value: `cogni:candidate-a:${NODE_ID}:app:v1`,
        }),
        expect.objectContaining({ column: "environment", value: "production" }),
      ])
    );
  });

  it("binds continuation to the configured operator identity and partition", async () => {
    const fetcher = mockFetch({
      data: [{ ...observation(), environment: "candidate-a" }],
      meta: { cursor: "next" },
    });
    vi.stubGlobal("fetch", fetcher);
    const query = nativeQuery("&environment=candidate-a");
    const first = await localReader("candidate-a").listObservations(query);
    await expect(
      localReader("production", "different-operator").listObservations({
        ...query,
        cursor: first.meta.cursor ?? "",
      })
    ).rejects.toMatchObject({ code: "invalid_trace_cursor", status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it.each([
  undefined,
  "candidate-a",
  "preview",
])("rejects sovereign reads without production receipt custody: %s", async (operatorEnvironment) => {
  const fetcher = mockFetch({ data: [observation()], meta: { cursor: null } });
  vi.stubGlobal("fetch", fetcher);
  try {
    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk-secret",
      operatorNodeId: "serving-operator",
      ...(operatorEnvironment ? { operatorEnvironment } : {}),
      ownership: { verifyObservation: vi.fn(async () => true) },
    });
    await expect(
      reader.listObservations(nativeQuery("&environment=candidate-a"))
    ).rejects.toMatchObject({ code: "attribution_unavailable", status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("exact application root query plan", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const trace = "9e7e282c9b1408162caad4538f544871";
  const root = () => ({
    ...observation(`t-${trace}`),
    traceId: trace,
    type: "SPAN",
    environment: "default",
    name: "graph-execution",
    parentObservationId: null,
    isRootObservation: true,
    output: JSON.stringify({
      status: "success",
      assistantResponse: "Application result",
    }),
  });
  const query = () =>
    nativeQuery(`&environment=candidate-a&type=SPAN&traceId=${trace}`);
  function reader(rootAllowed = true) {
    return new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk-secret",
      operatorNodeId: NODE_ID,
      operatorEnvironment: "candidate-a",
      ownership: { verifyObservation: async () => false },
      rootOwnership: { verifyObservation: vi.fn(async () => rootAllowed) },
    });
  }
  it("returns only the independently attested exact virtual root and application terminal status", async () => {
    const fetcher = mockFetch({ data: [root()], meta: {} });
    vi.stubGlobal("fetch", fetcher);
    const result = await reader().listObservations(query());
    expect(result.data.map((row) => row.id)).toEqual([`t-${trace}`]);
    expect(result.data[0]?.output).toContain('"status":"success"');
    expect(result.meta.cursor).toBeNull();
    const url = (fetcher as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as URL;
    expect(JSON.parse(url.searchParams.get("filter") ?? "[]")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "id", value: `t-${trace}` }),
        expect.objectContaining({ column: "environment", value: "default" }),
        expect.objectContaining({ column: "type", value: "SPAN" }),
      ])
    );
  });
  it("canonicalizes equivalent AND selectors and rejects broad/conflicting root selectors before IO", () => {
    const filter = JSON.stringify([
      { type: "string", column: "type", operator: "=", value: "SPAN" },
      { type: "string", column: "traceId", operator: "=", value: trace },
    ]);
    expect(
      nativeQuery(`&filter=${encodeURIComponent(filter)}`).rootTraceId
    ).toBe(trace);
    for (const extra of [
      "&type=SPAN",
      "&type=SPAN&traceId=invalid",
      `&type=GENERATION&filter=${encodeURIComponent(filter)}`,
      `&type=SPAN&traceId=${"a".repeat(32)}&filter=${encodeURIComponent(filter)}`,
      `&type=SPAN&traceId=${trace}&filter=${encodeURIComponent(JSON.stringify([{ type: "string", column: "id", operator: "=", value: "child" }]))}`,
    ])
      expect(() => nativeQuery(extra)).toThrow();
  });
  it("does not inherit root authority to foreign children, duplicates, or unproven roots", async () => {
    for (const rows of [[{ ...root(), id: "child" }], [root(), root()]]) {
      vi.stubGlobal("fetch", mockFetch({ data: rows, meta: {} }));
      const result = await reader().listObservations(query());
      expect(result.data).toHaveLength(0);
      expect(result.meta.cogni.partial).toBe(true);
    }
    vi.stubGlobal("fetch", mockFetch({ data: [root()], meta: {} }));
    const result = await reader(false).listObservations(query());
    expect(result.meta.cogni).toMatchObject({
      partial: true,
      attributionUnavailable: 1,
    });
  });
  it("fails explicitly without root wiring and binds generation cursors to their own plan", async () => {
    const missing = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk-secret",
      operatorNodeId: NODE_ID,
      operatorEnvironment: "candidate-a",
      ownership: { verifyObservation: async () => true },
    });
    await expect(missing.listObservations(query())).rejects.toMatchObject({
      code: "attribution_unavailable",
      status: 503,
    });
    vi.stubGlobal(
      "fetch",
      mockFetch({
        data: [{ ...observation(), environment: "candidate-a" }],
        meta: { cursor: "next" },
      })
    );
    const gen = await missing.listObservations(
      nativeQuery("&environment=candidate-a")
    );
    await expect(
      reader().listObservations({ ...query(), cursor: gen.meta.cursor ?? "" })
    ).rejects.toMatchObject({ code: "invalid_trace_cursor", status: 400 });
  });
});

it("selects a sovereign SDK root by nodeId without requiring a generation key alias or granting authority from the hint", async () => {
  const sovereignId = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
  const traceId = "9e7e282c9b1408162caad4538f544871";
  const root = {
    ...observation(`t-${traceId}`),
    traceId,
    type: "SPAN",
    environment: "default",
    name: "graph-execution",
    parentObservationId: null,
    isRootObservation: true,
    metadata: {
      nodeId: sovereignId,
      runId: "f05e32d0-ef33-4592-a36f-b47cc8fd795c",
      reqId: "f05e32d0-ef33-4592-a36f-b47cc8fd795c",
      graphId: "langgraph:poet",
      providerId: "langgraph",
    },
    output: JSON.stringify({
      status: "success",
      assistantResponse: "Sovereign application result",
    }),
  };
  // Honor upstream metadata equality: SDK root metadata has no user_api_key_alias.
  const fetcher = vi.fn(async (url: URL) => {
    const filters = JSON.parse(
      url.searchParams.get("filter") ?? "[]"
    ) as Array<{ type: string; key?: string; value: string }>;
    const matchesMetadata = filters
      .filter((f) => f.type === "stringObject")
      .every(
        (f) =>
          f.key !== undefined &&
          (root.metadata as Record<string, unknown>)[f.key] === f.value
      );
    return new Response(
      JSON.stringify({ data: matchesMetadata ? [root] : [], meta: {} })
    );
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const rootVerifier = vi.fn(async () => true),
      generationVerifier = vi.fn(async () => true);
    const reader = new HttpLangfuseReader({
      baseUrl: "https://lf.example.com",
      publicKey: "pk",
      secretKey: "sk-secret",
      operatorNodeId: NODE_ID,
      operatorEnvironment: "production",
      ownership: { verifyObservation: generationVerifier },
      rootOwnership: { verifyObservation: rootVerifier },
    });
    const query = parseTraceQuery(
      new URLSearchParams(
        `fromStartTime=${FROM}&toStartTime=${TO}&environment=production&type=SPAN&traceId=${traceId}`
      ),
      sovereignId
    );
    const result = await reader.listObservations(query);
    expect(result.data.map((row) => row.id)).toEqual([`t-${traceId}`]);
    expect(rootVerifier).toHaveBeenCalledWith(
      sovereignId,
      "production",
      expect.objectContaining({ metadata: root.metadata }),
      expect.any(AbortSignal)
    );
    expect(generationVerifier).not.toHaveBeenCalled();
    const url = fetcher.mock.calls[0]?.[0];
    const compiled = JSON.parse(url?.searchParams.get("filter") ?? "[]");
    expect(compiled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: "metadata",
          key: "nodeId",
          value: sovereignId,
        }),
      ])
    );
    expect(JSON.stringify(compiled)).not.toContain("user_api_key_alias");
    rootVerifier.mockResolvedValueOnce(false);
    const denied = await reader.listObservations(query);
    expect(denied.data).toHaveLength(0);
    expect(denied.meta.cogni).toMatchObject({
      partial: true,
      attributionUnavailable: 1,
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("approved native projection privacy and resource contract", () => {
  const R = "[REDACTED]";
  const hash = "a".repeat(64);
  const alias = `cogni:production:${NODE_ID}:app:v1`;
  const provider = "gen-projection-fixture";
  const slots = [
    "user_api_key_end_user_id",
    "billingAccountId",
    "user_api_key_user_email",
  ];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function project(
    value: unknown,
    secrets: string[] = [],
    field = "input",
    limit = 1,
    receiptMatches = true,
    secretKeys = slots,
    nativeInputJson?: string
  ) {
    const metadata: Record<string, unknown> = {
      nodeId: NODE_ID,
      user_api_key_hash: hash,
      user_api_key: hash,
      user_api_key_auth: { api_key: hash, key_alias: alias },
      user_api_key_alias: alias,
    };
    for (const [i, secret] of secrets.entries())
      metadata[secretKeys[i] ?? "user_api_key_end_user_id"] = secret;
    const row: Record<string, unknown> = {
      ...observation(`time-03-00-00-000000_${provider}`),
      metadata,
      input: null,
      output: null,
    };
    if (field === "metadata") metadata.graphName = value;
    else row[field] = value;
    const fetcher = vi.fn(
      async (url: URL) =>
        new Response(
          String(url).includes("/spend/logs/v2") ||
            nativeInputJson === undefined
            ? JSON.stringify(
                String(url).includes("/spend/logs/v2")
                  ? {
                      data: [
                        {
                          request_id: provider,
                          api_key: hash,
                          startTime: row.startTime,
                          metadata: {
                            user_api_key_alias: receiptMatches
                              ? alias
                              : "foreign",
                          },
                        },
                      ],
                      total: 1,
                    }
                  : { data: [row], meta: { cursor: null } }
              )
            : JSON.stringify({ data: [row], meta: { cursor: null } }).replace(
                '"input":null',
                `"input":${nativeInputJson}`
              )
        )
    );
    vi.stubGlobal("fetch", fetcher);
    const reader = new HttpLangfuseReader({
      baseUrl: "https://native.invalid",
      publicKey: "fixture",
      secretKey: "fixture",
      operatorEnvironment: "production",
      ownership: new HttpLangfuseOwnershipVerifier({
        baseUrl: "https://receipts.invalid",
        apiKey: "fixture",
      }),
    });
    const page = await reader.listObservations(
      nativeQuery(
        `&limit=${limit}&fields=core,basic,io,model,trace_context,metadata`
      )
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    if (receiptMatches) expect(page.meta.cogni.attributionUnavailable).toBe(0);
    return page;
  }
  const selected = (
    page: Awaited<ReturnType<typeof project>>,
    field = "input"
  ) =>
    field === "metadata"
      ? (page.data[0]?.metadata as Record<string, unknown>)?.graphName
      : page.data[0]?.[field];
  const nested = (value: unknown, count: number): unknown => {
    for (let i = 0; i < count; i++) value = { child: value };
    return value;
  };
  function decodedStrings(value: unknown): string[] {
    if (typeof value === "string") {
      try {
        return [value, ...decodedStrings(JSON.parse(value))];
      } catch {
        return [value];
      }
    }
    if (Array.isArray(value)) return value.flatMap(decodedStrings);
    if (value && typeof value === "object")
      return Object.entries(value).flatMap(([key, item]) => [
        key,
        ...decodedStrings(item),
      ]);
    return [];
  }

  it.each([
    "input",
    "output",
    "modelParameters",
    "statusMessage",
    "tags",
    "metadata",
  ])("uses the same literal context for %s and nested quoted/native representations", async (field) => {
    const secret = 'private"value\\with-tail';
    for (const value of [
      `safe ${secret} suffix`,
      JSON.stringify(secret),
      JSON.stringify(JSON.stringify(secret)),
      JSON.stringify({ payload: secret }),
      ...(field === "metadata"
        ? []
        : [{ payload: secret }, [secret], nested({ payload: secret }, 11)]),
    ]) {
      const page = await project(value, [secret], field);
      expect(
        decodedStrings(page.data).some((text) => text.includes(secret))
      ).toBe(false);
      expect(JSON.stringify(page.data)).not.toContain(secret);
      expect(page.meta.cogni.privacyProjected).toBe(true);
    }
  });

  it.each([
    "input",
    "output",
    "modelParameters",
    "statusMessage",
    "tags",
    "metadata",
  ])("withholds raw structural serialization matches in %s before escaped matching", async (field) => {
    for (const structure of [
      { code: "protected-value" },
      ["protected-value", 42],
    ]) {
      const secret = JSON.stringify(structure);
      const values =
        field === "metadata"
          ? [secret]
          : [structure, { child: structure }, secret];
      for (const value of values) {
        const page = await project(value, [secret], field);
        expect(selected(page, field)).toBe(R);
        expect(page.meta.cogni).toMatchObject({
          truncated: true,
          partial: true,
        });
      }
    }
  });

  it("checks original private names, preserves __proto__ entries, and withholds sanitation collisions", async () => {
    const secret = "credential-name";
    const page = await project(
      {
        [secret]: "must disappear",
        normal: "retained",
        ...JSON.parse('{"__proto__":"own value"}'),
      },
      [secret]
    );
    expect(selected(page)).toEqual({
      [R]: R,
      normal: "retained",
      ...JSON.parse('{"__proto__":"own value"}'),
    });
    expect(Object.prototype).not.toHaveProperty("polluted");
    for (const value of [
      { [secret]: "x", [R]: "y" },
      JSON.stringify({ [secret]: "x", [R]: "y" }),
      '{"\\u0063redential-name":"x","[REDACTED]":"y"}',
    ]) {
      const collision = await project(value, [secret]);
      expect(selected(collision)).toBe(
        typeof value === "string" && value.startsWith('{"\\u')
          ? JSON.stringify(R)
          : R
      );
      expect(collision.meta.cogni.truncated).toBe(true);
    }
  });

  it("unions overlapping original matches independent of order, including surrogate pair boundaries", async () => {
    const cases: Array<[string, string[], string]> = [
      [
        "prefix abcdefghijkl suffix",
        ["abcdefgh", "efghijkl"],
        `prefix ${R} suffix`,
      ],
      ["aaaaaaaaaaaa", ["aaaaaaaa", "aaaaaaaaa"], R],
      ["safe 😀abcdefg tail", ["\ude00abcdefg"], `safe ${R} tail`],
      ["safe abcdefg😀 tail", ["abcdefg\ud83d"], `safe ${R} tail`],
      [
        "unpaired \ud800 and safe 😀",
        ["absent-literal"],
        "unpaired \ud800 and safe 😀",
      ],
    ];
    for (const [value, secrets, expected] of cases)
      for (const order of [secrets, [...secrets].reverse()]) {
        const page = await project(value, order);
        expect(selected(page)).toBe(expected);
        expect(page.meta.cogni.truncated).toBe(false);
      }
  });

  it("visits depth16 and withholds depth17 for native containers and every quoted parse", async () => {
    for (const depth of [16, 17]) {
      const page = await project(nested("safe leaf", depth));
      expect(page.meta.cogni.truncated).toBe(depth === 17);
      expect(decodedStrings(selected(page))).toContain(
        depth === 17 ? R : "safe leaf"
      );
      let quoted = "safe leaf";
      // A single JSON string wrapper counts one parse, just like a container descent.
      for (let i = 0; i < depth; i++) quoted = JSON.stringify(quoted);
      const wrappers = await project(quoted);
      expect(wrappers.meta.cogni.truncated).toBe(depth === 17);
      if (depth === 16) expect(selected(wrappers)).toBe(quoted);
    }
  });

  it("preserves malformed compatibility while reporting raw-hit encoded withholding", async () => {
    for (const value of ["{broken", "[broken"]) {
      const page = await project(value);
      expect(selected(page)).toBe(R);
      expect(page.meta.cogni.truncated).toBe(false);
    }
    for (const value of [
      '"harmless prose',
      JSON.stringify("quoted safe prose"),
      "false ordinary prose",
    ]) {
      const page = await project(value);
      expect(selected(page)).toBe(value);
      expect(page.meta.cogni.truncated).toBe(false);
    }
    for (const value of ['{"private-literal": broken', '"private-literal']) {
      const page = await project(value, ["private-literal"]);
      expect(selected(page)).toBe(R);
      expect(page.meta.cogni.truncated).toBe(true);
    }
  });

  it.each([
    R,
    R.slice(0, 8),
    JSON.stringify(R),
  ])("rejects unsafe raw/serialized fallback %s with a generic typed502", async (secret) => {
    await expect(
      project(JSON.stringify({ safe: "value" }), [secret])
    ).rejects.toMatchObject({
      code: "observability_invalid_response",
      status: 502,
      message: "observability_invalid_response",
    });
  });
  it("keeps seven-unit fallback prefixes ineligible and handles an escaped fallback form", async () => {
    const seven = R.slice(0, 7);
    expect(selected(await project(`prefix ${seven}`, [seven]))).toBe(
      `prefix ${seven}`
    );
    const escaped = JSON.stringify(JSON.stringify(R));
    const page = await project("safe prose", [escaped]);
    expect(selected(page)).toBe("safe prose");
  });

  it("keeps actual row-sized matching allocations lazy and reuses their backing buffers", async () => {
    const Native = Int32Array,
      allocations: Int32Array[] = [];
    vi.stubGlobal(
      "Int32Array",
      class extends Native {
        constructor(length: number) {
          super(length);
          allocations.push(this);
        }
      }
    );
    const secret = 'private"fixture';
    const page = await project(
      { first: `safe ${secret} end`, second: `safe ${secret} end` },
      [secret],
      "input",
      50
    );
    expect(page.meta.cogni.truncated).toBe(false);
    const budget = Math.floor((1024 * 1024 - 32768) / 50);
    expect(allocations.filter((a) => a.length === budget + 1)).toHaveLength(1);
    // raw and escaped phases share each pattern's backing; hash occurs in neither output.
    expect(allocations.length).toBeLessThanOrEqual(3);
    expect(allocations.every((a) => a.length <= budget + 1)).toBe(true);
    expect(
      allocations.reduce((sum, a) => sum + a.byteLength, 0)
    ).toBeLessThanOrEqual((5 * budget + budget + 1) * 4);
    allocations.length = 0;
    await project("safe", ["p".repeat(budget + 1)], "input", 50);
    // The two fixed hash patterns are also too long for these short fields.
    expect(allocations).toHaveLength(0);
    await project("safe ".repeat(3000), ["😀".repeat(7000)], "input", 50);
    expect(allocations.every((a) => a.length <= hash.length)).toBe(true);
  });

  it("propagates allocation failures outside the malformed JSON catch and releases read concurrency", async () => {
    const Native = Int32Array;
    vi.stubGlobal(
      "Int32Array",
      class extends Native {
        constructor() {
          super(0);
          throw new RangeError("private allocator detail");
        }
      }
    );
    await expect(
      project(JSON.stringify({ payload: "private-literal" }), [
        "private-literal",
      ])
    ).rejects.toMatchObject({
      code: "observability_invalid_response",
      status: 502,
    });
    vi.stubGlobal("Int32Array", Native);
    expect(selected(await project("recovered"))).toBe("recovered");
  });

  it("preflights escaped fallback before an escaped withhold, after all raw selected-value checks", async () => {
    const stringify = JSON.stringify,
      seen: unknown[] = [];
    vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
      seen.push(value);
      // Inject only the escaped representation to exercise this otherwise unreachable defense.
      if (value === "escape-phase-fixture") return '"[REDACTED]"';
      return stringify(value, ...args);
    });
    await expect(
      project("raw phase safe", ["escape-phase-fixture"], "metadata")
    ).rejects.toMatchObject({
      code: "observability_invalid_response",
      status: 502,
    });
    expect(seen.indexOf("raw phase safe")).toBeLessThan(
      seen.indexOf("escape-phase-fixture")
    );
  });

  it("fails safely when rebuilding the shared prefix in the escaped phase", async () => {
    const stringify = JSON.stringify,
      fill = Int32Array.prototype.fill;
    let escaped = false;
    vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
      if (value === "escaped-phase-allocation") escaped = true;
      return stringify(value, ...args);
    });
    vi.spyOn(Int32Array.prototype, "fill").mockImplementation(function (
      this: Int32Array,
      value,
      start,
      end
    ) {
      if (escaped) throw new RangeError("private allocator detail");
      return fill.call(this, value, start, end);
    });
    await expect(
      project("safe ordinary prose ".repeat(4), ["escaped-phase-allocation"])
    ).rejects.toMatchObject({
      code: "observability_invalid_response",
      status: 502,
    });
    expect(escaped).toBe(true);
  });

  it("reviewed resource blockers: preflights short-email expansion before replacement allocation", async () => {
    const replace = String.prototype.replace,
      budget = Math.floor((1024 * 1024 - 32768) / 50);
    let largestDefenseAllocation = 0;
    vi.spyOn(String.prototype, "replace").mockImplementation(function (
      this: string,
      pattern,
      replacement
    ) {
      const result = Reflect.apply(replace, this, [
        pattern,
        replacement,
      ]) as string;
      if (String(replacement).includes("REDACTED"))
        largestDefenseAllocation = Math.max(
          largestDefenseAllocation,
          Buffer.byteLength(result)
        );
      return result;
    });
    for (const text of [
      "a@b.co ".repeat(2500),
      "xoxb-a ".repeat(2500),
      "KEY=a ".repeat(2900),
    ]) {
      const page = await project(text, [], "input", 50);
      expect(selected(page)).toBe(R);
      expect(page.meta.cogni).toMatchObject({ partial: true, truncated: true });
    }
    expect(largestDefenseAllocation).toBeLessThanOrEqual(budget);
    const prose = "ordinary harmless prose ".repeat(700);
    expect(selected(await project(prose, [], "input", 50))).toBe(prose);
  });

  it("preserves every content defense and its default callers under an optional byte ceiling", async () => {
    const cases: Array<[string, string]> = [
      [`sk-${"a".repeat(20)}`, "[REDACTED_SK_KEY]"],
      [`pk-${"a".repeat(20)}`, "[REDACTED_PK_KEY]"],
      [`sk-proj-${"a".repeat(20)}`, "[REDACTED_OPENAI_KEY]"],
      ["xoxb-a", "[REDACTED_SLACK_TOKEN]"],
      [`ghp_${"a".repeat(36)}`, "[REDACTED_GITHUB_TOKEN]"],
      [`gho_${"a".repeat(36)}`, "[REDACTED_GITHUB_TOKEN]"],
      [`Bearer ${"a".repeat(20)}`, "Bearer [REDACTED]"],
      ["a@b.co", "[REDACTED_EMAIL]"],
      ["1234 5678 9012 3456", "[REDACTED_CARD]"],
      ["password: abcde", "password: [REDACTED]"],
      ["SOME_KEY=a", "SOME_KEY=[REDACTED]"],
      [`AKIA${"A".repeat(16)}`, "[REDACTED_AWS_KEY]"],
      ["eyJa.eyJb.signature", "[REDACTED_JWT]"],
    ];
    for (const [text, expected] of cases) {
      expect(scrubStringContent(text)).toBe(expected);
      // Use a ceiling large enough to admit the source as well as its replacement.
      const ceiling = Math.max(
        Buffer.byteLength(text),
        Buffer.byteLength(expected)
      );
      expect(scrubStringContent(text, ceiling)).toBe(expected);
      expect(selected(await project(text))).toBe(expected);
      if (Buffer.byteLength(expected) > Buffer.byteLength(text))
        expect(
          scrubStringContent(text, Buffer.byteLength(expected) - 1)
        ).toBeNull();
    }
    expect(scrubStringContent("API_KEY=é", 64)).toBe("API_KEY=[REDACTED]");
  });

  it("reviewed resource blockers: bounds deep optional admission before walking its full state", async () => {
    const parse = JSON.parse;
    let visited = 0;
    vi.spyOn(JSON, "parse").mockImplementation((text, ...args) => {
      const decoded: unknown = parse(text, ...args);
      // Instrument a bounded prefix of the actual native parse result, never replace its parser.
      if (decoded && typeof decoded === "object" && "data" in decoded) {
        let current = (decoded as { data: Array<{ input: unknown }> }).data[0]
          ?.input;
        for (
          let i = 0;
          i < 256 && current && typeof current === "object" && "x" in current;
          i++
        ) {
          const child: unknown = current.x;
          Object.defineProperty(current, "x", {
            enumerable: true,
            get: () => {
              visited++;
              return child;
            },
          });
          current = child;
        }
      }
      return decoded;
    });
    const nativeInput = `${'{"x":'.repeat(40_000)}0${"}".repeat(40_000)}`;
    const page = await project(null, [], "input", 50, true, slots, nativeInput);
    expect(selected(page)).toBeNull();
    expect(page.meta.cogni).toMatchObject({ partial: true, truncated: true });
    expect(visited).toBeLessThanOrEqual(64);
  });

  it("preserves complete declared todos tool content/status schemas", async () => {
    const declaration = {
      type: "function",
      function: {
        name: "todos",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string", description: "todo content" },
                  status: {
                    type: "string",
                    description: "todo status",
                    enum: ["pending", "done"],
                  },
                },
              },
            },
          },
        },
      },
    };
    const input = JSON.stringify({
      tools: Array.from({ length: 15 }, () => declaration),
    });
    const page = await project(input);
    expect(selected(page)).toBe(input);
    expect(page.meta.cogni).toMatchObject({ truncated: false, partial: false });
  });

  it("matches an independent original-character coverage oracle for dense overlaps", async () => {
    let state = 5562;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let trial = 0; trial < 80; trial++) {
      const source = Array.from(
        { length: 36 },
        () => "ab"[(random() >>> 16) % 2]
      ).join("");
      const literals = [
        source.slice(2, 10),
        source.slice(5, 14),
        source.slice(9, 17),
      ];
      const covered = Array.from({ length: source.length }, (_, i) =>
        literals.some((literal) => {
          for (let start = 0; start <= i; start++)
            if (source.startsWith(literal, start) && i < start + literal.length)
              return true;
          return false;
        })
      );
      let expected = "";
      for (let i = 0; i < source.length; i++)
        expected += covered[i] ? (covered[i - 1] ? "" : R) : source[i];
      for (const order of [literals, [...literals].reverse()])
        expect(selected(await project(source, order))).toBe(expected);
    }
  });

  it("checks exact aggregate JSON UTF8 boundaries, including escaped lone surrogates", async () => {
    const limit = 50,
      budget = Math.floor((1024 * 1024 - 32768) / limit);
    const baseline = await project("", [], "input", limit);
    const room = budget - Buffer.byteLength(JSON.stringify(baseline.data[0]));
    for (const unit of ["é ", "😀 ", "\ud800 ", '\\ ", ']) {
      const unitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2;
      const text =
        unit.repeat(Math.floor(room / unitBytes)) +
        " ".repeat(room % unitBytes);
      const exact = await project(text, [], "input", limit);
      expect(selected(exact)).toBe(text);
      expect(exact.meta.cogni.truncated).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(exact.data[0]))).toBe(budget);
      const over = await project(`${text} `, [], "input", limit);
      expect(selected(over)).toBeNull();
      expect(over.meta.cogni.truncated).toBe(true);
    }
  });

  it("retains private keys and all five metadata literal sources beyond the old cap", async () => {
    for (const key of [
      "user_api_key_hash",
      "user_api_key",
      "billingAccountId",
      "user_api_key_end_user_id",
      "user_api_key_user_email",
    ]) {
      const secret =
        key === "user_api_key_hash" || key === "user_api_key"
          ? hash
          : "private-fixture";
      const page = await project(
        nested(
          { password: "hidden-value", content: `safe ${secret} tail` },
          11
        ),
        [secret],
        "input",
        1,
        true,
        [key]
      );
      expect(decodedStrings(selected(page))).not.toContain("hidden-value");
      expect(
        decodedStrings(selected(page)).some((text) => text.includes(secret))
      ).toBe(false);
      expect(page.meta.cogni.truncated).toBe(false);
    }
  });

  it("bounds marker expansion and UTF8 output across the aggregate row and rejects foreign receipts", async () => {
    const secret = "abcdefgh";
    const text = `${secret} `.repeat(1900);
    const page = await project(text, [secret], "input", 50);
    expect(selected(page)).toBe(R);
    expect(page.meta.cogni).toMatchObject({ partial: true, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024 * 1024);
    const foreign = await project(
      nested("private-literal", 11),
      ["private-literal"],
      "input",
      1,
      false
    );
    expect(foreign.data).toEqual([]);
    expect(foreign.meta.cogni).toMatchObject({
      partial: true,
      attributionUnavailable: 1,
    });
  });
});
