// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/scripts/temporal-loki-evidence`
 * Purpose: Prove exact, bounded, credential-safe Loki evidence reads.
 * Scope: Mocked fetch only; no live Grafana or Loki access.
 * Invariants: Worker/env pinning, triple-ID correlation, bounded range, fail closed.
 * Side-effects: none
 * Links: scripts/lib/temporal-loki-evidence.mjs, task.5239
 * @public
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildTemporalEvidenceQuery,
  createTemporalLokiEvidenceReader,
} from "../../../scripts/lib/temporal-loki-evidence.mjs";

const SECRET = "glsa_secret_never_expose";
const SCHEDULE_ID = "schedule-exact";
const GRAPH_RUN_ID = "run-exact";
const NOW_MS = Date.parse("2026-10-11T12:40:00.000Z");
const INPUT = {
  target: {
    name: "poly",
    nodeId: "8913a24a-92f6-41e0-ab3b-ef8101298364",
    environment: "candidate-a",
  },
  scheduleId: SCHEDULE_ID,
  graphRunId: GRAPH_RUN_ID,
  scheduledAt: "2026-10-11T12:35:00.000Z",
};

function lokiResponse(
  values: Array<[string, string]>,
  labels = {
    env: "candidate-a",
    service: "scheduler-worker",
    node: "f97f68f2-physical-k8s-host",
  }
) {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "streams",
        result: [{ stream: labels, values }],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function reader(fetchImpl: ReturnType<typeof vi.fn>, overrides = {}) {
  return createTemporalLokiEvidenceReader({
    grafanaUrl: "https://example.grafana.net/",
    token: SECRET,
    fetchImpl,
    now: () => NOW_MS,
    ...overrides,
  });
}

describe("buildTemporalEvidenceQuery", () => {
  it("pins the worker stream and line-filters all three correlation IDs", () => {
    expect(
      buildTemporalEvidenceQuery({
        ...INPUT.target,
        scheduleId: SCHEDULE_ID,
        graphRunId: GRAPH_RUN_ID,
      })
    ).toBe(
      `{env="candidate-a",service="scheduler-worker"} |= "8913a24a-92f6-41e0-ab3b-ef8101298364" |= "schedule-exact" |= "run-exact"`
    );
  });

  it("escapes LogQL values instead of interpolating syntax", () => {
    expect(
      buildTemporalEvidenceQuery({
        environment: 'candidate-a"}',
        nodeId: "node",
        scheduleId: 'schedule" |~ ".*',
        graphRunId: "run",
      })
    ).toContain('env="candidate-a\\"}"');
  });
});

describe("createTemporalLokiEvidenceReader", () => {
  it("runs a bounded query_range and returns normalized exact evidence", async () => {
    const line = JSON.stringify({
      event: "worker.activity.run_created",
      nodeId: INPUT.target.nodeId,
      dbScheduleId: SCHEDULE_ID,
      runId: GRAPH_RUN_ID,
    });
    const fetchImpl = vi.fn(async () =>
      lokiResponse([["1791722280000000000", line]])
    );

    const result = await reader(fetchImpl)(INPUT);

    expect(result.entries).toEqual([
      {
        timestampNs: "1791722280000000000",
        line,
        labels: {
          env: "candidate-a",
          service: "scheduler-worker",
          node: "f97f68f2-physical-k8s-host",
        },
        parsed: JSON.parse(line),
      },
    ]);
    expect(result.sourceUrl).toContain("/explore?");
    expect(result.sourceUrl).not.toContain(SECRET);
    expect(result.range).toEqual({
      start: "2026-10-11T12:34:00.000Z",
      end: "2026-10-11T12:40:00.000Z",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.pathname).toBe(
      "/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/query_range"
    );
    expect(url.searchParams.get("query")).toBe(
      `{env="candidate-a",service="scheduler-worker"} |= "${INPUT.target.nodeId}" |= "schedule-exact" |= "run-exact"`
    );
    expect(url.searchParams.get("start")).toBe("1791722040000000000");
    expect(url.searchParams.get("end")).toBe("1791722400000000000");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("direction")).toBe("backward");
    expect(init.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect(url.toString()).not.toContain(SECRET);
  });

  it("caps a stale schedule query to the configured maximum range", async () => {
    const line = JSON.stringify({
      nodeId: INPUT.target.nodeId,
      dbScheduleId: SCHEDULE_ID,
      runId: GRAPH_RUN_ID,
    });
    const fetchImpl = vi.fn(async () =>
      lokiResponse([["1791722399000000000", line]])
    );
    const read = reader(fetchImpl, { maxRangeMs: 120_000 });

    await read({ ...INPUT, scheduledAt: "2026-10-11T11:00:00.000Z" });

    const [url] = fetchImpl.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("start")).toBe("1791722280000000000");
    expect(url.searchParams.get("end")).toBe("1791722400000000000");
  });

  it("fails closed before fetch when either canonical credential is missing", () => {
    const fetchImpl = vi.fn();
    expect(() =>
      createTemporalLokiEvidenceReader({
        grafanaUrl: "",
        token: SECRET,
        fetchImpl,
      })
    ).toThrow("GRAFANA_URL is required");
    expect(() =>
      createTemporalLokiEvidenceReader({
        grafanaUrl: "https://example.grafana.net",
        token: "",
        fetchImpl,
      })
    ).toThrow("GRAFANA_SERVICE_ACCOUNT_TOKEN is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects caller overrides that would make the Loki read unbounded", () => {
    expect(() => reader(vi.fn(), { maxRangeMs: 30 * 60_000 + 1 })).toThrow(
      "maxRangeMs must not exceed 1800000"
    );
    expect(() => reader(vi.fn(), { limit: 1_001 })).toThrow(
      "limit must not exceed 1000"
    );
  });

  it("fails closed on malformed Loki responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "success", data: {} }), {
          status: 200,
        })
    );

    await expect(reader(fetchImpl)(INPUT)).rejects.toMatchObject({
      phase: "loki_response",
      message: "Loki query_range returned a malformed response",
    });
  });

  it("fails closed when Loki has no exact triple-ID hit", async () => {
    const fetchImpl = vi.fn(async () =>
      lokiResponse([
        [
          "1791722290000000000",
          JSON.stringify({
            nodeId: "wrong-node",
            dbScheduleId: SCHEDULE_ID,
            runId: GRAPH_RUN_ID,
          }),
        ],
        [
          "1791722280000000000",
          JSON.stringify({
            nodeId: INPUT.target.nodeId,
            dbScheduleId: SCHEDULE_ID,
            runId: "wrong-run",
          }),
        ],
        [
          "1791722270000000000",
          JSON.stringify({
            nodeId: INPUT.target.nodeId,
            dbScheduleId: "wrong-schedule",
            runId: GRAPH_RUN_ID,
          }),
        ],
      ])
    );

    await expect(reader(fetchImpl)(INPUT)).rejects.toMatchObject({
      phase: "loki_no_hit",
      message:
        "Loki returned no entry correlated by nodeId, scheduleId, and graphRunId",
    });
  });

  it("never exposes the Grafana token in transport failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`upstream echoed ${SECRET}`);
    });

    let thrown: unknown;
    try {
      await reader(fetchImpl)(INPUT);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain(SECRET);
    expect(thrown).toMatchObject({
      phase: "loki_request",
      message: "Loki query_range request failed",
    });
  });
});
