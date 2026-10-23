// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/observability/langfuse-ownership.adapter`
 * Purpose: Exercise independent callback/receipt joins, collision denial and secret-safe bounds.
 * Scope: HTTP contract tests with fetch stubs; no live service or database.
 * Invariants: Names and caller metadata do not grant trace ownership.
 * Side-effects: none
 * Links: src/adapters/server/observability/langfuse-ownership.adapter.ts
 * @internal
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpLangfuseOwnershipVerifier } from "@/adapters/server/observability/langfuse-ownership.adapter";

const NODE = "11111111-2222-3333-4444-555555555555";
const HASH = "a".repeat(64);
const ALIAS = `cogni:candidate-a:${NODE}:app:v1`;
const START = "2026-10-23T03:48:04.633Z";
const END = "2026-10-23T03:48:14.633Z";
const signal = () => AbortSignal.timeout(1000);

function observation(): Record<string, unknown> {
  return {
    id: "time-03-48-04-633288_gen-provider-id",
    traceId: "trace-1",
    type: "GENERATION",
    level: "DEFAULT",
    startTime: START,
    metadata: {
      user_api_key_alias: ALIAS,
      user_api_key_hash: HASH,
      user_api_key: HASH,
      user_api_key_auth: { api_key: HASH, key_alias: ALIAS },
    },
    output: JSON.stringify({ id: "gen-provider-id", choices: [] }),
  };
}

function receipt() {
  return {
    request_id: "gen-provider-id",
    api_key: HASH,
    startTime: "2026-10-23T03:48:04.633288Z",
    metadata: { user_api_key_alias: ALIAS },
  };
}

function failedObservation(): Record<string, unknown> {
  const row = observation();
  row.id = "8adaceeb-2643-4341-a928-64eed2a2f94d";
  row.level = "ERROR";
  row.output = null;
  row.endTime = END;
  (row.metadata as Record<string, unknown>).requester_metadata = JSON.stringify(
    {
      request_id: "run-1",
      existing_trace_id: "trace-1",
      spend_logs_metadata: { run_id: "run-1", node_id: NODE },
    }
  );
  return row;
}

function failedReceipt(runId = "run-1") {
  return {
    ...receipt(),
    request_id: `backend-error-${runId}`,
    startTime: END,
    metadata: {
      user_api_key_alias: ALIAS,
      status: "failure",
      spend_logs_metadata: { run_id: runId, node_id: NODE },
    },
  };
}

function setup(data: unknown[] = [receipt()], total = data.length) {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ data, total }))
  );
  vi.stubGlobal("fetch", fetcher);
  const verifier = new HttpLangfuseOwnershipVerifier({
    baseUrl: "http://litellm.internal:4000/",
    apiKey: "private-backend-token",
  });
  return { fetcher, verifier };
}

describe("HttpLangfuseOwnershipVerifier", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("joins the exact historical callback to an independent scoped receipt", async () => {
    const { verifier, fetcher } = setup();
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        observation(),
        signal()
      )
    ).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("http://litellm.internal:4000");
    expect(url.pathname).toBe("/spend/logs/v2");
    expect(url.searchParams.get("request_id")).toBe("gen-provider-id");
    expect(url.searchParams.get("page_size")).toBe("2");
    expect(url.searchParams.get("start_date")).toBe("2026-10-23 03:48:02");
    expect(url.searchParams.get("end_date")).toBe("2026-10-23 03:48:07");
    expect(url.toString()).not.toContain("private-backend-token");
    expect(init.redirect).toBe("error");
    // No live-key lookup is required: deleted/rotated registrations retain their receipt.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "name-only",
    "caller-nested",
    "foreign-lane",
    "foreign-auth",
    "non-generation",
  ])("rejects %s candidates before making any receipt request", async (mode) => {
    const { verifier, fetcher } = setup();
    const row = observation();
    const metadata = row.metadata as Record<string, unknown>;
    if (mode === "name-only") row.metadata = { name: `litellm:${ALIAS}` };
    if (mode === "caller-nested")
      row.metadata = { requester_metadata: metadata };
    if (mode === "foreign-lane")
      metadata.user_api_key_alias = ALIAS.replace("candidate-a", "production");
    if (mode === "foreign-auth")
      metadata.user_api_key_auth = {
        api_key: "b".repeat(64),
        key_alias: ALIAS,
      };
    if (mode === "non-generation") row.type = "SPAN";
    expect(
      await verifier.verifyObservation(NODE, "candidate-a", row, signal())
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "foreign-key",
    "foreign-alias",
    "wrong-id",
    "wrong-time",
    "collision",
    "missing",
  ])("denies an independent receipt with %s", async (mode) => {
    const record = receipt();
    if (mode === "foreign-key") record.api_key = "b".repeat(64);
    if (mode === "foreign-alias")
      record.metadata.user_api_key_alias = `cogni:production:${NODE}:app:v1`;
    if (mode === "wrong-id") record.request_id = "foreign-call";
    if (mode === "wrong-time") record.startTime = "2026-10-23T03:48:09.633Z";
    const rows =
      mode === "missing"
        ? []
        : mode === "collision"
          ? [record, record]
          : [record];
    const { verifier } = setup(rows);
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        observation(),
        signal()
      )
    ).toBe(false);
  });

  it("rejects conflicting generation and provider IDs", async () => {
    const { verifier, fetcher } = setup();
    const row = {
      ...observation(),
      output: JSON.stringify({ id: "foreign-provider-id" }),
    };
    expect(
      await verifier.verifyObservation(NODE, "candidate-a", row, signal())
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("authorizes an error only through one key-scoped receipt with matching run correlation", async () => {
    const record = {
      ...receipt(),
      request_id: "backend-error-call",
      metadata: {
        user_api_key_alias: ALIAS,
        status: "failure",
        spend_logs_metadata: { run_id: "run-1", node_id: NODE },
      },
    };
    const { verifier, fetcher } = setup([record]);
    const row = observation();
    row.id = "random-error-observation";
    row.endTime = START;
    row.level = "ERROR";
    row.output = null;
    (row.metadata as Record<string, unknown>).requester_metadata =
      JSON.stringify({
        request_id: "run-1",
        existing_trace_id: "trace-1",
        spend_logs_metadata: { run_id: "run-1", node_id: NODE },
      });
    expect(
      await verifier.verifyObservation(NODE, "candidate-a", row, signal())
    ).toBe(true);
    const [url] = fetcher.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("api_key")).toBe(HASH);
    expect(url.searchParams.get("status_filter")).toBe("failure");
    record.metadata.spend_logs_metadata.run_id = "foreign-run";
    expect(
      await verifier.verifyObservation(NODE, "candidate-a", row, signal())
    ).toBe(false);
  });

  it("joins a ten-second failure at its terminal receipt time, not its call start", async () => {
    const { verifier, fetcher } = setup([failedReceipt()]);
    const parentSignal = signal();
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        failedObservation(),
        parentSignal
      )
    ).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("start_date")).toBe("2026-10-23 03:48:12");
    expect(url.searchParams.get("end_date")).toBe("2026-10-23 03:48:17");
    expect(url.searchParams.get("status_filter")).toBe("failure");
    expect(url.searchParams.get("api_key")).toBe(HASH);
    expect(url.searchParams.has("request_id")).toBe(false);
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("page_size")).toBe("2");
    expect(init.signal).toBe(parentSignal);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    null,
    "",
    "malformed",
    "2026-10-23T03:48:03.633Z",
    1792727294633,
  ])("denies invalid failure endTime %s before requesting any receipt", async (endTime) => {
    const { verifier, fetcher } = setup([failedReceipt()]);
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        { ...failedObservation(), endTime },
        signal()
      )
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "own-first",
    "own-last",
  ])("accepts the unique matching failure in a complete two-run bucket: %s", async (order) => {
    const own = failedReceipt();
    const other = failedReceipt("other-run");
    const { verifier } = setup(
      order === "own-first" ? [own, other] : [other, own]
    );
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        failedObservation(),
        signal()
      )
    ).toBe(true);
  });

  it.each([
    "key",
    "alias",
    "node",
    "run",
    "status",
    "start-time",
    "delayed-time",
    "invalid-time",
  ])("does not match a failure receipt with wrong %s", async (mode) => {
    const record = failedReceipt();
    if (mode === "key") record.api_key = "b".repeat(64);
    if (mode === "alias")
      record.metadata.user_api_key_alias = ALIAS.replace(
        "candidate-a",
        "production"
      );
    if (mode === "node")
      record.metadata.spend_logs_metadata.node_id = "foreign-node";
    if (mode === "run")
      record.metadata.spend_logs_metadata.run_id = "foreign-run";
    if (mode === "status") record.metadata.status = "success";
    if (mode === "start-time") record.startTime = START;
    if (mode === "delayed-time") record.startTime = "2026-10-23T03:48:17.633Z";
    if (mode === "invalid-time") record.startTime = "malformed";
    const { verifier } = setup([record]);
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        failedObservation(),
        signal()
      )
    ).toBe(false);
  });

  it.each([
    {
      name: "duplicate own matches",
      rows: [failedReceipt(), failedReceipt()],
      total: 2,
    },
    { name: "partial page", rows: [failedReceipt()], total: 2 },
    {
      name: "over-cap bucket",
      rows: [failedReceipt(), failedReceipt("other-run")],
      total: 3,
    },
    { name: "count smaller than page", rows: [failedReceipt()], total: 0 },
    { name: "missing page", rows: [], total: 1 },
    { name: "complete empty bucket", rows: [], total: 0 },
  ])("denies $name without widening the bounded query", async ({
    rows,
    total,
  }) => {
    const { verifier, fetcher } = setup(rows, total);
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        failedObservation(),
        signal()
      )
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "DEFAULT",
    "ERROR",
  ])("keeps provider-ID %s joins singular and anchored to start without requiring endTime", async (level) => {
    const { verifier, fetcher } = setup();
    expect(
      await verifier.verifyObservation(
        NODE,
        "candidate-a",
        { ...observation(), level, endTime: "malformed" },
        signal()
      )
    ).toBe(true);
    const [url] = fetcher.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("start_date")).toBe("2026-10-23 03:48:02");
    expect(url.searchParams.get("request_id")).toBe("gen-provider-id");
    expect(url.searchParams.has("status_filter")).toBe(false);
  });

  it("fails closed on oversized or malformed receipt bodies", async () => {
    const { verifier } = setup();
    vi.stubGlobal(
      "fetch",
      async () => new Response("x".repeat(256 * 1024 + 1))
    );
    await expect(
      verifier.verifyObservation(NODE, "candidate-a", observation(), signal())
    ).rejects.toMatchObject({
      code: "observability_response_too_large",
      status: 502,
    });
    vi.stubGlobal("fetch", async () => new Response("not json"));
    await expect(
      verifier.verifyObservation(NODE, "candidate-a", observation(), signal())
    ).rejects.toMatchObject({
      code: "observability_invalid_response",
      status: 502,
    });
  });

  it.each([
    429, 500, 401,
  ])("preserves dependency HTTP %s separately from a valid non-match", async (status) => {
    const { verifier } = setup();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("private-upstream-auth-body", {
          status,
          headers: { "retry-after": "5" },
        })
    );
    await expect(
      verifier.verifyObservation(NODE, "candidate-a", observation(), signal())
    ).rejects.toMatchObject({
      code:
        status === 429
          ? "observability_rate_limited"
          : "observability_upstream_error",
      status: status === 429 ? 429 : 502,
      retryAfter: "5",
    });
  });

  it("reports receipt timeout and transport failure without private messages", async () => {
    const { verifier } = setup();
    const aborted = AbortSignal.abort(
      new DOMException("private-url", "TimeoutError")
    );
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("private-upstream-url", "TimeoutError");
    });
    await expect(
      verifier.verifyObservation(NODE, "candidate-a", observation(), aborted)
    ).rejects.toMatchObject({
      code: "observability_upstream_timeout",
      status: 504,
    });
    vi.stubGlobal("fetch", async () => {
      throw new Error("private-upstream-url");
    });
    await expect(
      verifier.verifyObservation(NODE, "candidate-a", observation(), signal())
    ).rejects.toMatchObject({
      message: "observability_upstream_error",
      status: 502,
    });
  });

  it("pins operator master receipts to their configured logical environment", async () => {
    const record = { ...receipt(), metadata: { user_api_key_alias: null } };
    setup([record]);
    const verifier = new HttpLangfuseOwnershipVerifier({
      baseUrl: "http://litellm.internal:4000",
      apiKey: "private-backend-token",
      operatorNodeId: NODE,
      operatorMasterKeyHash: HASH,
      operatorEnvironment: "candidate-a",
    });
    const row = observation();
    row.metadata = {
      nodeId: NODE,
      user_api_key_hash: HASH,
      user_api_key: HASH,
      user_api_key_alias: null,
      user_api_key_auth: { api_key: HASH, key_alias: null },
    };
    expect(
      await verifier.verifyObservation(NODE, "candidate-a", row, signal())
    ).toBe(true);
    expect(
      await verifier.verifyObservation(NODE, "production", row, signal())
    ).toBe(false);
  });
});
