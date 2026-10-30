// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/observability/langfuse-root-ownership`
 * Purpose: Exact root authority, independent collector receipts and bounded dependency failures.
 * Scope: Fetch stubs only, no live logs or model calls.
 * Invariants: No child inheritance or mutable nodeId fallback.
 * Side-effects: none
 * Links: task.5319
 * @internal
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpLangfuseRootOwnershipVerifier } from "@/adapters/server/observability/langfuse-root-ownership.adapter";

const NODE = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
  TRACE = "9e7e282c9b1408162caad4538f544871",
  REQ = "f05e32d0-ef33-4592-a36f-b47cc8fd795c";
const START = Date.parse("2026-10-23T10:49:05.554Z"),
  END = START + 59_103;
function root() {
  return {
    id: `t-${TRACE}`,
    traceId: TRACE,
    type: "SPAN",
    environment: "default",
    name: "graph-execution",
    parentObservationId: null,
    isRootObservation: true,
    startTime: new Date(START).toISOString(),
    endTime: null,
    metadata: {
      nodeId: NODE,
      reqId: REQ,
      runId: REQ,
      graphId: "langgraph:poet",
      providerId: "langgraph",
    },
    output: JSON.stringify({
      status: "success",
      assistantResponse: "qualified app result",
    }),
  };
}
function receipts() {
  return [
    {
      stream: { env: "candidate-a", service: "app", node: NODE },
      values: [
        [
          String(BigInt(START + 3) * 1_000_000n),
          JSON.stringify({
            event: "langfuse.trace_created",
            svcNode: NODE,
            reqId: REQ,
            traceId: TRACE,
            langfuseTraceId: TRACE,
            graphId: "langgraph:poet",
          }),
        ],
        [
          String(BigInt(END) * 1_000_000n),
          JSON.stringify({
            event: "langfuse.trace_completed",
            svcNode: NODE,
            reqId: REQ,
            traceId: TRACE,
            langfuseTraceId: TRACE,
            outcome: "success",
          }),
        ],
      ],
    },
  ];
}
function setup(streams = receipts()) {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "streams", result: streams },
        })
      )
  );
  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    verifier: new HttpLangfuseRootOwnershipVerifier({
      grafanaUrl: "https://grafana.example",
      token: "private-root-token",
      now: () => END + 1000,
    }),
  };
}
const signal = () => AbortSignal.timeout(15_000);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("exact app root receipts", () => {
  it("attests exact root including terminal after the caller root-start window", async () => {
    const { verifier, fetcher } = setup();
    const parentSignal = signal();
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        root(),
        parentSignal
      )
    ).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe(
      "/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/query_range"
    );
    expect(url.searchParams.get("query")).toContain(
      `{env="candidate-a",service="app",node="${NODE}"}`
    );
    expect(url.searchParams.get("query")).toContain(`traceId="${TRACE}"`);
    expect(BigInt(url.searchParams.get("end") ?? "0")).toBeGreaterThan(
      BigInt(END) * 1_000_000n
    );
    expect(init.signal).toBe(parentSignal);
    expect(init.redirect).toBe("error");
    expect(url.toString()).not.toContain("private-root-token");
  });
  it.each([
    "stream-node",
    "stream-env",
    "stream-service",
    "emitter",
    "langfuse-created",
    "langfuse-terminal",
    "request",
    "graph",
    "outcome",
    "time",
    "duplicate",
    "saturated",
    "missing",
  ])("rejects %s receipt ambiguity or mismatch", async (mode) => {
    const streams = receipts(),
      stream = streams[0];
    if (!stream) throw new Error();
    const a = JSON.parse(stream.values[0]?.[1] ?? "{}"),
      b = JSON.parse(stream.values[1]?.[1] ?? "{}");
    if (mode === "stream-node") stream.stream.node = "foreign";
    if (mode === "stream-env") stream.stream.env = "production";
    if (mode === "stream-service") stream.stream.service = "other";
    if (mode === "emitter") {
      delete a.svcNode;
      a.nodeId = NODE;
    }
    if (mode === "langfuse-created") delete a.langfuseTraceId;
    if (mode === "langfuse-terminal") delete b.langfuseTraceId;
    if (mode === "request") b.reqId = "foreign";
    if (mode === "graph") a.graphId = "langgraph:foreign";
    if (mode === "outcome") b.outcome = "error";
    stream.values[0] = [
      String(BigInt(START + (mode === "time" ? 3000 : 3)) * 1_000_000n),
      JSON.stringify(a),
    ];
    stream.values[1] = [String(BigInt(END) * 1_000_000n), JSON.stringify(b)];
    if (mode === "duplicate") stream.values.push(stream.values[0] ?? []);
    if (mode === "saturated") stream.values.push(...stream.values.slice());
    if (mode === "missing") stream.values.pop();
    const { verifier } = setup(streams);
    expect(
      await verifier.verifyObservation(NODE, "candidate-a", root(), signal())
    ).toBe(false);
  });
  it.each([
    "child",
    "partition",
    "request",
    "provider",
    "shape",
    "status",
  ])("rejects native %s without using its metadata as authority", async (mode) => {
    const row = root();
    if (mode === "child") row.id = "child";
    if (mode === "partition") row.environment = "candidate-a";
    if (mode === "request") row.metadata.runId = "foreign";
    if (mode === "provider") row.metadata.providerId = "foreign";
    if (mode === "shape") row.isRootObservation = false;
    if (mode === "status") row.output = JSON.stringify({ status: "unknown" });
    const { verifier, fetcher } = setup();
    expect(
      await verifier.verifyObservation(NODE, "candidate-a", row, signal())
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves429/timeout and rejects malformed/oversize response bodies", async () => {
    const { verifier } = setup();
    for (const [response, code, status] of [
      [
        new Response("private", {
          status: 429,
          headers: { "retry-after": "5" },
        }),
        "observability_rate_limited",
        429,
      ],
      [new Response("not JSON"), "observability_upstream_error", 502],
      [
        new Response("unused", {
          headers: { "content-length": String(512 * 1024 + 1) },
        }),
        "observability_response_too_large",
        502,
      ],
    ] as const) {
      vi.stubGlobal("fetch", async () => response);
      await expect(
        verifier.verifyObservation(NODE, "candidate-a", root(), signal())
      ).rejects.toMatchObject({ code, status });
    }
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("private URL", "TimeoutError");
    });
    await expect(
      verifier.verifyObservation(NODE, "candidate-a", root(), signal())
    ).rejects.toMatchObject({
      code: "observability_upstream_timeout",
      status: 504,
    });
  });
});
