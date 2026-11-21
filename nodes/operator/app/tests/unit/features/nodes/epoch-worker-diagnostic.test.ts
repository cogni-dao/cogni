// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { once } from "node:events";
import { createServer } from "node:http";
import {
  buildEpochWorkerDiagnostic,
  diagnosticTarget,
  projectEpochWorkerDiagnostic,
} from "@cogni/scheduler-core";
import { describe, expect, it, vi } from "vitest";
import { HttpLokiReader } from "@/adapters/server/observability/loki-reader.adapter";
import { scopeNodeLogQL } from "@/features/nodes/observability-logs";
import { logEpochDiagnostic } from "../../../../../../../services/scheduler-worker/src/observability/epoch-diagnostic";
import type { Logger } from "../../../../../../../services/scheduler-worker/src/observability/logger";

const nodeId = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const neighbor = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const target = { targetNodeId: nodeId, targetEnv: "candidate-a" as const };
const time = "2026-11-20T00:00:00.000Z";
const source = {
  physicalEnv: "production" as const,
  namespace: "cogni-production",
  container: "scheduler-worker" as const,
};
const scoped = (query?: string) =>
  scopeNodeLogQL({
    env: "candidate-a",
    nodeId,
    service: "epoch-worker",
    epochSource: source,
    query,
  });

describe("strict target-bound worker event writer and reader", () => {
  it("derives targetEnv from the exact declared native namespace", () => {
    expect(diagnosticTarget(nodeId, "cogni-candidate-a")).toEqual(target);
    for (const namespace of [
      "production",
      "cogni-production-tenant",
      "",
      "cogni-foreign",
    ])
      expect(diagnosticTarget(nodeId, namespace)).toBeNull();
    expect(diagnosticTarget("operator", "cogni-production")).toBeNull();
  });
  it("all three events carry only the finite proven claim", () => {
    const events = [
      buildEpochWorkerDiagnostic(
        target,
        { event: "epoch.worker_started" },
        time
      ),
      buildEpochWorkerDiagnostic(
        target,
        {
          event: "epoch.ledger_activity_complete",
          outcome: "error",
          durationMs: 20,
          attempt: 2,
        },
        time
      ),
      buildEpochWorkerDiagnostic(
        target,
        { event: "epoch.dispatch_authorized", attempt: 3 },
        time
      ),
    ];
    for (const event of events) {
      expect(projectEpochWorkerDiagnostic(event, target)).toEqual(event);
      expect(event.targetNodeId).toBe(nodeId);
      expect(event.node_id).toBe(nodeId);
    }
    expect(events[1]).toMatchObject({
      reasonCode: "internal_error",
      outcome: "error",
    });
    expect(events[2]).toMatchObject({
      phase: "grant_validated",
      outcome: "success",
      writerKind: "central_dispatch",
    });
    for (const claim of [
      "payload",
      "scheduleId",
      "schemaValidated",
      "completed",
      "dispatchCompleted",
    ])
      expect(events[2]).not.toHaveProperty(claim);
  });
  it("reserved collisions and foreign sentinel input never override the trusted writer", () => {
    const attacker = {
      event: "epoch.dispatch_authorized" as const,
      attempt: 1,
      schemaVersion: 9,
      targetNodeId: neighbor,
      targetEnv: "production",
      node_id: neighbor,
      writerKind: "ledger",
      payload: "PAYLOAD_SENTINEL",
      error: "RAW_ERROR_SENTINEL",
      headers: "HEADER_SENTINEL",
    };
    const written = buildEpochWorkerDiagnostic(target, attacker, time);
    expect(written.targetNodeId).toBe(nodeId);
    expect(written.targetEnv).toBe("candidate-a");
    expect(written.writerKind).toBe("central_dispatch");
    expect(written.schemaVersion).toBe(1);
    const info = vi.fn();
    const logger = { info } as unknown as Logger;
    logEpochDiagnostic(logger, target, attacker);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain(neighbor);
    for (const value of [
      "PAYLOAD_SENTINEL",
      "RAW_ERROR_SENTINEL",
      "HEADER_SENTINEL",
    ])
      expect(JSON.stringify(written)).not.toContain(value);
  });
  it("projects anew; forged emitter identity, missing/mixed node and wrong env yield no neighbor data", () => {
    const event = buildEpochWorkerDiagnostic(
      target,
      { event: "epoch.worker_started" },
      time
    );
    const parsed = projectEpochWorkerDiagnostic(
      {
        ...event,
        node: neighbor,
        app: "fake",
        msg: "ERROR_SENTINEL",
        err: { payload: "FOREIGN_SENTINEL" },
        identity: "WORKER_SENTINEL",
      },
      target
    );
    expect(parsed).toEqual(event);
    expect(JSON.stringify(parsed)).not.toContain("SENTINEL");
    for (const line of [
      null,
      {},
      "{not json",
      { ...event, targetNodeId: neighbor },
      { ...event, node_id: neighbor },
      { ...event, targetEnv: "production" },
      { ...event, schemaVersion: 2 },
      { ...event, writerKind: "central_dispatch" },
      { ...event, event: "arbitrary" },
      { ...event, time: "invalid" },
    ])
      expect(projectEpochWorkerDiagnostic(line, target)).toBeNull();
  });
  it("invalid targets or logger failures do not replace activity semantics", () => {
    const logger = {
      info: vi.fn(() => {
        throw new Error("logger failed");
      }),
    } as unknown as Logger;
    expect(() =>
      logEpochDiagnostic(logger, null, { event: "epoch.worker_started" })
    ).not.toThrow();
    expect(() =>
      logEpochDiagnostic(logger, target, { event: "epoch.worker_started" })
    ).not.toThrow();
  });
});

describe("existing scoped log proxy extension", () => {
  it("pins physical custody separately and rechecks logical target before and after filters", () => {
    const query = scoped('| outcome="error"');
    for (const pin of [
      'app="cogni-template"',
      'env="production"',
      'source="k8s"',
      'service="scheduler-worker"',
      'container="scheduler-worker"',
      'namespace="cogni-production"',
    ])
      expect(query).toContain(pin);
    expect(query.split(`targetNodeId="${nodeId}"`)).toHaveLength(3);
    expect(query.split('targetEnv="candidate-a"')).toHaveLength(3);
    expect(query.indexOf(`targetNodeId="${nodeId}"`)).toBeLessThan(
      query.indexOf('| outcome="error"')
    );
    expect(query.lastIndexOf(`targetNodeId="${nodeId}"`)).toBeGreaterThan(
      query.indexOf('| outcome="error"')
    );
  });
  it.each([
    '|= "error"',
    '!= "ignore"',
    '|~ "epoch"',
    "| durationMs>=3",
    '{pod="scheduler-worker-abc"} | outcome="success"',
  ])("allows narrowing filter %s", (query) => {
    expect(() => scoped(query)).not.toThrow();
  });
  it.each([
    '| line_format "{{.payload}}"',
    "| unpack",
    '| pattern "<payload>"',
    "| json",
    '| label_format targetNodeId="spoof"',
    '| label_format node_id="spoof"',
    "| drop targetEnv",
    "| keep targetNodeId",
    '| outcome="error" or targetNodeId=~".+"',
    '{env="candidate-a"}',
    '{source="lease"}',
    '{service="app"}',
    '| payload="secret"',
  ])("refuses rewrite or expansion %s", (query) => {
    expect(() => scoped(query)).toThrow();
  });
  it("ordinary services retain lease source and existing full LogQL", () => {
    expect(
      scopeNodeLogQL({
        env: "production",
        nodeId,
        service: "scheduler-worker",
        query: '{} | json | line_format "{{.msg}}"',
      })
    ).toContain('source="lease"');
    expect(() =>
      scopeNodeLogQL({ env: "candidate-a", nodeId, service: "epoch-worker" })
    ).toThrow();
    expect(() =>
      scopeNodeLogQL({
        env: "candidate-a",
        nodeId,
        service: "epoch-worker",
        epochSource: source,
        workload: "canary",
      })
    ).toThrow();
    expect(() => scoped("x".repeat(2049))).toThrow();
  });
});

describe("real bounded Loki HTTP transport", () => {
  it("caps streamed bytes before parsing and refuses oversized lines without echoing bodies", async () => {
    let mode = "bytes";
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (mode === "bytes") {
        response.write(" ".repeat(131073));
        response.end();
      } else {
        response.end(
          JSON.stringify({
            data: {
              result: [
                { values: [["123", "PRIVATE_BODY_SENTINEL".repeat(200)]] },
              ],
            },
          })
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const reader = new HttpLokiReader({
      grafanaUrl: `http://127.0.0.1:${address.port}`,
      token: "PRIVATE_TOKEN_SENTINEL",
    });
    try {
      for (mode of ["bytes", "line"])
        await expect(
          reader.queryRange({
            query: scoped(),
            startNs: "1",
            endNs: "2",
            limit: 100,
            bounds: { timeoutMs: 1000, maxBytes: 131072, maxLineBytes: 2048 },
          })
        ).rejects.toThrow("loki_response_bounds");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("actual HTTP abort stops a stalled response body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data":');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    try {
      const reader = new HttpLokiReader({
        grafanaUrl: `http://127.0.0.1:${address.port}`,
        token: "secret",
      });
      const start = Date.now();
      await expect(
        reader.queryRange({
          query: scoped(),
          startNs: "1",
          endNs: "2",
          limit: 100,
          bounds: { timeoutMs: 100, maxBytes: 131072, maxLineBytes: 2048 },
        })
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(900);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
