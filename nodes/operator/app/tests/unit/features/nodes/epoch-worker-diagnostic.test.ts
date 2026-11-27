// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  buildEpochWorkerDiagnostic,
  diagnosticTarget,
  projectEpochWorkerDiagnostic,
} from "@cogni/scheduler-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEpochWorkerSource } from "@/bootstrap/ledger-diagnostic";
import { scopeNodeLogQL } from "@/features/nodes/observability-logs";
import { logEpochDiagnostic } from "../../../../../../../services/scheduler-worker/src/observability/epoch-diagnostic";
import type { Logger } from "../../../../../../../services/scheduler-worker/src/observability/logger";

vi.mock("@/adapters/server", () => ({}));
vi.mock("@/bootstrap/container", () => ({}));
vi.mock("@/bootstrap/jobs/resolveRoutableNodeGovernanceConfigs", () => ({}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
  it("binds Akash central dispatch to the environment's operator worker", () => {
    const binding = resolveEpochWorkerSource(
      { "candidate-a": "akash" },
      "candidate-a"
    );
    expect(binding).toEqual({
      physicalEnv: "candidate-a",
      namespace: "cogni-candidate-a",
      container: "scheduler-worker",
    });
    const query = scopeNodeLogQL({
      env: "candidate-a",
      nodeId,
      service: "epoch-worker",
      epochSource: binding,
    });
    expect(query).toContain('env="candidate-a"');
    expect(query).toContain('namespace="cogni-candidate-a"');
    expect(query).toContain(`targetNodeId="${nodeId}"`);
    expect(() => resolveEpochWorkerSource(null, "candidate-a")).toThrow();
    expect(() =>
      resolveEpochWorkerSource({ "candidate-a": "invalid" }, "candidate-a")
    ).toThrow();
  });
  it("emits a LogQL-compatible forced event regex", () => {
    const query = scoped();
    expect(query).toContain(
      'event=~"epoch[.](worker_started|ledger_activity_complete|dispatch_authorized)"'
    );
    expect(query).not.toContain("epoch\\.");
  });
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
