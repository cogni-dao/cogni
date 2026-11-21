// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { OpenFgaAuthorizationAdapter } from "@cogni/authorization-core";
import {
  admitLedgerBinding,
  buildWorkflowArgs,
  emptyLedgerDiagnostic,
  verifyCurrentLedgerOwnership,
} from "@cogni/scheduler-core";
import { Connection } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import { TemporalLedgerDiagnosticAdapter } from "@/adapters/server/temporal/ledger-diagnostic.adapter";
import {
  parseLedgerDiagnosticQuery,
  readLedgerDiagnostic,
} from "@/features/nodes/observability-temporal";

const nodeId = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const foreign = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const workflowId = "private-native-id-FOREIGN_SENTINEL";
const seconds = (value: string) => ({
  seconds: Math.floor(Date.parse(value) / 1000),
  nanos: 0,
});
const envelope = buildWorkflowArgs(
  {
    nodeId,
    scheduleId: "governance:ledger_ingest",
    dbScheduleId: "local-row",
    ownerUserId: "system",
    cron: "0 0 * * *",
    timezone: "UTC",
    graphId: "ledger:ingest",
    executionGrantId: "PRIVATE_GRANT_SENTINEL",
    input: { version: 1, scopeId: "PRIVATE_SCOPE_SENTINEL" },
  },
  "CollectEpochWorkflow"
);
const binding = admitLedgerBinding({
  nodeId,
  env: "production",
  appBuildSha: "b1e6074",
  capability: "operator_ledger",
  namespace: "cogni-production",
  scheduleId: "governance:ledger_ingest",
  currentQueue: `ledger-tasks-${nodeId}`,
  legacyQueue: "ledger-tasks",
  workflowType: "CollectEpochWorkflow",
  expectedEnvelope: envelope,
});
function schedule(horizon = 10) {
  return {
    conflictToken: Buffer.from("token"),
    schedule: {
      state: { paused: false },
      policies: { overlapPolicy: 1 },
      action: {
        startWorkflow: {
          workflowType: { name: "CollectEpochWorkflow" },
          taskQueue: { name: binding.currentQueue },
          input: {
            payloads: [
              {
                metadata: { encoding: Buffer.from("json/plain") },
                data: Buffer.from(JSON.stringify(envelope)),
              },
            ],
          },
        },
      },
    },
    info: {
      overlapSkipped: 84,
      actionCount: 1,
      missedCatchupWindow: 0,
      runningWorkflows: [{ workflowId, runId }],
      futureActionTimes: Array.from({ length: horizon }, (_, i) =>
        seconds(`2026-11-${String(21 + i).padStart(2, "0")}T00:00:00Z`)
      ),
      recentActions: [
        {
          scheduleTime: seconds("2026-11-20T00:00:00Z"),
          actualTime: seconds("2026-11-20T00:00:00Z"),
          startWorkflowResult: { workflowId: "new-Nov20", runId },
        },
      ],
    },
  };
}
function execution() {
  return {
    workflowExecutionInfo: {
      execution: { workflowId, runId },
      status: 1,
      startTime: seconds("2026-11-13T00:00:00Z"),
      memo: { fields: { foreign: { data: Buffer.from("MEMO_SENTINEL") } } },
      searchAttributes: {
        indexedFields: { secret: { data: Buffer.from("SEARCH_SENTINEL") } },
      },
    },
    executionConfig: {
      taskQueue: { name: "ledger-tasks" },
      defaultWorkflowTaskTimeout: { seconds: 10 },
    },
    pendingWorkflowTask: {
      state: 1,
      scheduledTime: seconds("2026-11-13T00:00:00Z"),
      originalScheduledTime: seconds("2026-11-13T00:00:00Z"),
      attempt: 1,
    },
    pendingActivities: [],
    pendingChildren: [],
  };
}
/** Every unapproved method, including native mutations/list/query/history, is a trap. */
function fixture(
  options: {
    first?: ReturnType<typeof schedule>;
    final?: ReturnType<typeof schedule>;
    describe?: (request: {
      execution: { workflowId: string; runId: string };
    }) => ReturnType<typeof execution> | Promise<ReturnType<typeof execution>>;
    pollers?: (name: string, kind: number) => object;
    onCreate?: () => void;
  } = {}
) {
  const calls: string[] = [];
  const scopes: number[] = [];
  const close = vi.fn(async () => {});
  const service = new Proxy(
    {},
    {
      get(_target, method: string) {
        if (method === "describeSchedule")
          return async () => {
            calls.push(method);
            return calls.filter((c) => c === method).length === 1
              ? (options.first ?? schedule())
              : (options.final ?? options.first ?? schedule());
          };
        if (method === "describeWorkflowExecution")
          return async (request: {
            execution: { workflowId: string; runId: string };
          }) => {
            calls.push(method);
            return options.describe ? options.describe(request) : execution();
          };
        if (method === "describeTaskQueue")
          return async (request: {
            taskQueue: { name: string };
            taskQueueType: number;
          }) => {
            calls.push(
              `${method}:${request.taskQueue.name}:${request.taskQueueType}`
            );
            return (
              options.pollers?.(
                request.taskQueue.name,
                request.taskQueueType
              ) ?? {
                pollers:
                  request.taskQueue.name === "ledger-tasks"
                    ? []
                    : [{ identity: "WORKER_SENTINEL", lastAccessTime: null }],
              }
            );
          };
        throw new Error(`Forbidden native method ${method}`);
      },
    }
  );
  const conn = {
    workflowService: service,
    close,
    withDeadline: async (
      deadline: number,
      callback: () => Promise<unknown>
    ) => {
      scopes.push(deadline);
      return callback();
    },
    withAbortSignal: async (
      _signal: AbortSignal,
      callback: () => Promise<unknown>
    ) => callback(),
  } as unknown as Connection;
  const make = vi.fn((config: Parameters<typeof Connection.lazy>[0]) => {
    expect(config).toMatchObject({
      plugins: [],
      interceptors: [],
      channelArgs: {
        "grpc.enable_retries": 0,
        "grpc.max_receive_message_length": 262144,
        "grpc.max_send_message_length": 16384,
      },
    });
    options.onCreate?.();
    return conn;
  });
  return {
    adapter: new TemporalLedgerDiagnosticAdapter("test:7233", make),
    calls,
    make,
    close,
    scopes,
  };
}
const readOptions = () => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 4500,
});

describe("finite native epoch diagnosis", () => {
  it("admits native ten-time horizon and selects old Nov13 RUNNING rather than recent Nov20", async () => {
    const f = fixture();
    const before = Date.now();
    const result = await f.adapter.read(binding, readOptions());
    expect(result.state).toBe("observed");
    expect(result.budgets.complete).toBe(true);
    expect(result.selection).toBe("oldest_running");
    expect(result.blocker).toMatchObject({
      ownership: "unproven",
      startedAt: "2026-11-13T00:00:00.000Z",
      pendingWorkflowTask: { state: "scheduled", startedAt: null, attempt: 1 },
      executionTimeoutMs: null,
      runTimeoutMs: null,
      taskTimeoutMs: 10000,
      runningQueueRole: "legacy",
    });
    expect(result.schedule).toMatchObject({
      nextActionAt: "2026-11-21T00:00:00.000Z",
      overlap: "SKIP",
      overlapSkipped: 84,
    });
    expect(result.reasonCodes).toContain("stranded_on_unpolled_legacy_queue");
    expect(result.reasonCodes).toContain("unbounded_blocker");
    expect(result.queues).toMatchObject([
      {
        role: "current",
        workflow: { pollerCount: 1, lastAccessAt: null, freshness: "unknown" },
      },
      {
        role: "legacy",
        workflow: { pollerCount: 0 },
        activity: { pollerCount: 0 },
      },
    ]);
    expect(result.budgets.calls).toBe(7);
    expect(f.calls).toHaveLength(7);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.scopes.every((d) => d <= before + 1050)).toBe(true);
    const text = JSON.stringify(result);
    for (const secret of [
      workflowId,
      runId,
      "PRIVATE_GRANT",
      "PRIVATE_SCOPE",
      "MEMO_SENTINEL",
      "SEARCH_SENTINEL",
      "WORKER_SENTINEL",
      "futureActionTimes",
      "ledger-tasks",
    ])
      expect(text).not.toContain(secret);
  });
  it.each([
    11, 17,
  ])("refuses horizon %i without truncating into complete", async (horizon) => {
    const f = fixture({ first: schedule(horizon) });
    const result = await f.adapter.read(binding, readOptions());
    expect(result.state).toBe("unknown");
    expect(result.reasonCodes).toContain("bounds_exceeded");
    expect(result.schedule).toBeNull();
    expect(f.calls).toEqual(["describeSchedule"]);
  });
  it("supports an arbitrary central node with the operator-default dispatch queue", async () => {
    const expected = buildWorkflowArgs(
      {
        scheduleId: `governance:${foreign}:ledger_ingest`,
        nodeId: foreign,
        ownerUserId: "system",
        cron: "0 * * * *",
        timezone: "UTC",
        graphId: "task:/api/internal/attribution/collect",
        executionGrantId: "PRIVATE_GRANT",
        input: {
          route: "/api/internal/attribution/collect",
          payload: { nodeId: foreign },
        },
      },
      "NodeTaskWorkflow"
    );
    const central = admitLedgerBinding({
      ...binding,
      nodeId: foreign,
      capability: "central_dispatch",
      scheduleId: `governance:${foreign}:ledger_ingest`,
      currentQueue: `scheduler-tasks-${nodeId}`,
      legacyQueue: "scheduler-tasks",
      workflowType: "NodeTaskWorkflow",
      expectedEnvelope: expected,
    });
    const first = schedule();
    first.schedule.action.startWorkflow.workflowType.name = "NodeTaskWorkflow";
    first.schedule.action.startWorkflow.taskQueue.name = central.currentQueue;
    first.schedule.action.startWorkflow.input.payloads[0]!.data = Buffer.from(
      JSON.stringify(expected)
    );
    const f = fixture({
      first,
      describe: () => {
        const reply = execution();
        reply.executionConfig.taskQueue.name = central.legacyQueue;
        return reply;
      },
    });
    const result = await f.adapter.read(central, readOptions());
    expect(result.capability).toBe("central_dispatch");
    expect(result.nodeId).toBe(foreign);
    expect(result.budgets.complete).toBe(true);
    expect(
      f.calls.filter((c) => c.includes("describeTaskQueue:scheduler-tasks-"))
    ).toHaveLength(2);
    expect(f.calls.some((c) => c.includes(`scheduler-tasks-${foreign}`))).toBe(
      false
    );
  });
  it("rejects malformed and unordered future timestamps", async () => {
    for (const invalid of [
      { seconds: -1, nanos: 0 },
      seconds("2026-01-01T00:00:00Z"),
    ]) {
      const first = schedule();
      first.info.futureActionTimes[1] = invalid;
      const f = fixture({ first });
      const result = await f.adapter.read(binding, readOptions());
      expect(result.state).toBe("unknown");
      expect(result.reasonCodes).toContain("invalid_native_shape");
      expect(result.budgets.complete).toBe(false);
    }
  });
  it("foreign current envelope releases no linked counters, executions or pollers", async () => {
    const first = schedule();
    first.schedule.action.startWorkflow.input.payloads[0]!.data = Buffer.from(
      JSON.stringify({ ...envelope, nodeId: foreign })
    );
    const f = fixture({ first });
    const result = await f.adapter.read(binding, readOptions());
    expect(result.schedule).toBeNull();
    expect(result.blocker).toBeNull();
    expect(result.queues).toEqual([]);
    expect(result.reasonCodes).toEqual(["scope_conflict"]);
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(foreign);
  });
  it("foreign old queue remains anonymous and is never probed", async () => {
    const f = fixture({
      describe: () => {
        const reply = execution();
        reply.executionConfig.taskQueue.name = "FOREIGN_QUEUE_SENTINEL";
        return reply;
      },
    });
    const result = await f.adapter.read(binding, readOptions());
    expect(result.blocker).toMatchObject({
      ownership: "scope_conflict",
      runningQueueRole: "other",
      queueChanged: null,
    });
    expect(result.queues.map((q) => q.role)).toEqual(["current"]);
    expect(JSON.stringify(result)).not.toContain("FOREIGN_QUEUE_SENTINEL");
  });
  it("selects oldest only after all exact RUNNING describes succeed", async () => {
    const first = schedule();
    first.info.runningWorkflows.push({ workflowId: "newer", runId });
    const f = fixture({
      first,
      describe: (request) => {
        const reply = execution();
        if (request.execution.workflowId === "newer") {
          reply.workflowExecutionInfo.execution.workflowId = "newer";
          reply.workflowExecutionInfo.startTime = seconds(
            "2026-11-20T00:00:00Z"
          );
        }
        return reply;
      },
    });
    const result = await f.adapter.read(binding, readOptions());
    expect(result.blocker?.startedAt).toContain("2026-11-13");
    expect(result.blockingRunningCount).toBe(2);
    expect(result.budgets.complete).toBe(true);
    const broken = fixture({
      first,
      describe: (request) => {
        if (request.execution.workflowId === "newer")
          throw new Error("PRIVATE_ERROR_SENTINEL");
        return execution();
      },
    });
    const partial = await broken.adapter.read(binding, readOptions());
    expect(partial.selection).toBe("incomplete");
    expect(partial.blocker).toBeNull();
    expect(partial.budgets.complete).toBe(false);
    expect(JSON.stringify(partial)).not.toContain("PRIVATE_ERROR_SENTINEL");
  });
  it("changed token, lost reference and ended execution do not form a current verdict", async () => {
    for (const change of ["token", "reference", "ended"]) {
      const final = schedule();
      if (change === "token") final.conflictToken = Buffer.from("changed");
      if (change === "reference") final.info.runningWorkflows = [];
      const f = fixture({
        final,
        describe: () => {
          const reply = execution();
          if (change === "ended") reply.workflowExecutionInfo.status = 2;
          return reply;
        },
      });
      const result = await f.adapter.read(binding, readOptions());
      expect(result.budgets.complete).toBe(false);
      expect(result.reasonCodes).toContain(
        change === "ended" ? "blocker_changed" : "evidence_changed"
      );
      expect(result.reasonCodes).not.toContain(
        "stranded_on_unpolled_legacy_queue"
      );
    }
  });
  it("separates workflow and activity pollers and refuses unknown/excess shapes", async () => {
    const f = fixture({
      pollers: (_name, kind) =>
        kind === 1
          ? { pollers: [] }
          : {
              pollers: [
                {
                  lastAccessTime: seconds("2026-11-20T00:00:00Z"),
                  identity: "SECRET_IDENTITY",
                },
              ],
            },
    });
    const result = await f.adapter.read(binding, readOptions());
    expect(result.queues[0]?.workflow?.pollerCount).toBe(0);
    expect(result.queues[0]?.activity?.pollerCount).toBe(1);
    expect(result.queues[0]?.activity?.freshness).toBe("observed");
    for (const pollers of [
      {},
      { pollers: Array.from({ length: 65 }, () => ({})) },
    ]) {
      const f = fixture({ pollers: () => pollers });
      const result = await f.adapter.read(binding, readOptions());
      expect(result.state).toBe("partial");
      expect(result.budgets.complete).toBe(false);
    }
  });
  it("pre-abort and abort immediately after lazy construction start zero native calls", async () => {
    for (const preabort of [true, false]) {
      const controller = new AbortController();
      if (preabort) controller.abort();
      const f = fixture({ onCreate: () => controller.abort() });
      await expect(
        f.adapter.read(binding, {
          signal: controller.signal,
          deadline: Date.now() + 3500,
        })
      ).rejects.toThrow("deadline_exceeded");
      expect(f.calls).toHaveLength(0);
      expect(f.make).toHaveBeenCalledTimes(preabort ? 0 : 1);
      expect(f.close).toHaveBeenCalledTimes(preabort ? 0 : 1);
    }
  });
  it("an active abort closes only this channel and starts no later read", async () => {
    const controller = new AbortController();
    let release: () => void = () => {};
    const f = fixture({
      describe: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return execution();
      },
    });
    const pending = f.adapter.read(binding, {
      signal: controller.signal,
      deadline: Date.now() + 3500,
    });
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    controller.abort();
    expect(f.close).toHaveBeenCalledTimes(1);
    release();
    await expect(pending).rejects.toThrow("deadline_exceeded");
    expect(f.calls).toHaveLength(2);
  });
  it("real SDK stalls in channel establishment only until the native deadline; no hidden handshake", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const start = Date.now();
    const spy = vi.spyOn(Connection.prototype, "ensureConnected");
    try {
      const adapter = new TemporalLedgerDiagnosticAdapter(
        `127.0.0.1:${address.port}`
      );
      await expect(
        adapter.read(binding, {
          signal: new AbortController().signal,
          deadline: start + 150,
        })
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(900);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("actual native receive bound", () => {
  it("an in-flight real RPC abort closes its HTTP/2 channel and starts no later call", async () => {
    const server = createHttp2Server();
    const sessions = new Set<import("node:http2").ServerHttp2Session>();
    const calls: string[] = [];
    let observed: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    server.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    server.on("stream", (stream, headers) => {
      calls.push(String(headers[":path"]));
      stream.on("error", () => {});
      observed();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const controller = new AbortController();
    try {
      const adapter = new TemporalLedgerDiagnosticAdapter(
        `127.0.0.1:${address.port}`
      );
      const pending = adapter.read(binding, {
        signal: controller.signal,
        deadline: Date.now() + 3500,
      });
      const refusal = expect(pending).rejects.toThrow("deadline_exceeded");
      await started;
      controller.abort();
      await refusal;
      await vi.waitFor(() => expect(sessions.size).toBe(0), { timeout: 900 });
      expect(calls).toEqual([
        "/temporal.api.workflowservice.v1.WorkflowService/DescribeSchedule",
      ]);
    } finally {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a protobuf reply over 256 KiB on the transport without serializing it", async () => {
    const require = createRequire(import.meta.url);
    const sdkRequire = createRequire(require.resolve("@temporalio/client"));
    const proto = sdkRequire("@temporalio/proto") as {
      temporal: {
        api: {
          workflowservice: {
            v1: {
              DescribeScheduleResponse: {
                encode(value: unknown): { finish(): Uint8Array };
              };
            };
          };
        };
      };
    };
    const calls: string[] = [];
    const reply = schedule();
    reply.conflictToken = Buffer.alloc(262145, 65);
    const bytes =
      proto.temporal.api.workflowservice.v1.DescribeScheduleResponse.encode(
        reply
      ).finish();
    const server = createHttp2Server();
    const sessions = new Set<import("node:http2").ServerHttp2Session>();
    server.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    server.on("stream", (stream, headers) => {
      calls.push(String(headers[":path"]));
      stream.on("error", () => {});
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true }
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": "0" })
      );
      const frame = Buffer.alloc(5);
      frame.writeUInt32BE(bytes.length, 1);
      stream.end(Buffer.concat([frame, bytes]));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    try {
      const adapter = new TemporalLedgerDiagnosticAdapter(
        `127.0.0.1:${address.port}`
      );
      const result = await adapter.read(binding, readOptions());
      expect(result.reasonCodes).toContain("bounds_exceeded");
      expect(result.budgets.complete).toBe(false);
      expect(result.schedule).toBeNull();
      expect(calls).toEqual([
        "/temporal.api.workflowservice.v1.WorkflowService/DescribeSchedule",
      ]);
      expect(JSON.stringify(result).length).toBeLessThan(16384);
    } finally {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("public preparation and authority seams", () => {
  it("accepts only one env parameter", () => {
    expect(
      parseLedgerDiagnosticQuery(new URLSearchParams("env=production"))
    ).toBe("production");
    for (const query of [
      "env=production&env=preview",
      "env=production&runId=sentinel",
      "env=foreign",
      "",
    ])
      expect(() =>
        parseLedgerDiagnosticQuery(new URLSearchParams(query))
      ).toThrow();
  });
  it.each([
    "authz_denied",
    "authz_unavailable",
    "environment_mismatch",
  ])("%s performs zero native reads", async (code) => {
    const reader = { read: vi.fn() };
    const deps = {
      check() {},
      lookup: vi.fn(async () => ({
        nodeId,
        slug: "operator",
        status: "active",
        deployEnvs: ["production"],
        activityEnv: "production",
      })),
      authorize: vi.fn(async () => {
        if (code !== "environment_mismatch") throw new Error(code);
      }),
      bind: vi.fn(async () => {
        throw new Error(code);
      }),
      finish() {},
      reader,
    };
    await expect(
      readLedgerDiagnostic(
        {
          ref: "operator",
          actorId: "agent",
          env: "production",
          ...readOptions(),
        },
        deps
      )
    ).rejects.toThrow(code);
    expect(reader.read).not.toHaveBeenCalled();
  });
  it.each([
    "lookup",
    "authorize",
    "bind",
    "finish",
  ])("abort during %s cannot launch native I/O", async (seam) => {
    const controller = new AbortController();
    const reader = { read: vi.fn() };
    const node = {
      nodeId,
      slug: "operator",
      status: "active",
      deployEnvs: ["production"],
      activityEnv: "production",
    };
    const deps = {
      check() {
        controller.signal.throwIfAborted();
      },
      async lookup() {
        await Promise.resolve();
        if (seam === "lookup") controller.abort();
        return node;
      },
      async authorize() {
        await Promise.resolve();
        if (seam === "authorize") controller.abort();
      },
      async bind() {
        await Promise.resolve();
        if (seam === "bind") controller.abort();
        return binding;
      },
      finish() {
        if (seam === "finish") controller.abort();
      },
      reader,
    };
    await expect(
      readLedgerDiagnostic(
        {
          ref: "operator",
          actorId: "agent",
          env: "production",
          signal: controller.signal,
          deadline: Date.now() + 3500,
        },
        deps
      )
    ).rejects.toThrow();
    expect(reader.read).not.toHaveBeenCalled();
  });
  it("admits only the exact current system row, live scoped grant and full declared input", () => {
    const expectedInput = {
      route: "/api/internal/attribution/collect",
      payload: { nodeId },
    };
    const valid = {
      expectedInput,
      expectedGraphId: "task:/api/internal/attribution/collect",
      systemUserId: "system",
      requiredScope: "task:dispatch:exact",
      nowMs: 100,
      schedule: {
        ownerUserId: "system",
        graphId: "task:/api/internal/attribution/collect",
        executionGrantId: "current-grant",
        input: expectedInput,
      },
      grant: {
        id: "current-grant",
        userId: "system",
        scopes: ["task:dispatch:exact"],
        revoked: false,
        expiresAtMs: 200,
      },
    };
    expect(verifyCurrentLedgerOwnership(valid)).toBeNull();
    expect(verifyCurrentLedgerOwnership({ ...valid, grant: null })).toBe(
      "ownership_unproven"
    );
    for (const change of [
      { id: "retired" },
      { userId: "foreign" },
      { scopes: ["foreign-scope"] },
      { revoked: true },
      { expiresAtMs: 100 },
      { expiresAtMs: NaN },
    ])
      expect(
        verifyCurrentLedgerOwnership({
          ...valid,
          grant: { ...valid.grant, ...change },
        })
      ).toBe("ownership_unproven");
    expect(
      verifyCurrentLedgerOwnership({
        ...valid,
        schedule: {
          ...valid.schedule,
          input: { ...expectedInput, payload: { nodeId: foreign } },
        },
      })
    ).toBe("scope_conflict");
    expect(
      verifyCurrentLedgerOwnership({
        ...valid,
        schedule: {
          ...valid.schedule,
          input: { ...expectedInput, extra: "PAYLOAD_SENTINEL" },
        },
      })
    ).toBe("scope_conflict");
  });
  it("uses actual bounded OpenFGA HTTP cancellation and preserves outage versus denial", async () => {
    let requests = 0;
    const server = createHttpServer(() => {
      requests += 1;
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const signal = AbortSignal.timeout(100);
    const start = Date.now();
    try {
      const auth = new OpenFgaAuthorizationAdapter({
        apiUrl: `http://127.0.0.1:${address.port}`,
        storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        timeoutMs: 300,
        readTransport: { signal, timeoutMs: 100 },
      });
      const decision = await auth.check({
        actorId: "user:agent",
        action: "node.flight",
        resource: `node:${nodeId}`,
        context: { tenantId: nodeId, nodeId },
      });
      expect(decision.code).toBe("authz_unavailable");
      expect(requests).toBe(1);
      expect(Date.now() - start).toBeLessThan(900);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("not-applicable is explicit unknown, never empty healthy", async () => {
    const dto = emptyLedgerDiagnostic(
      { ...binding, capability: "not_applicable" },
      "activity_elsewhere"
    );
    expect(dto.state).toBe("unknown");
    expect(dto.budgets.complete).toBe(false);
    expect(dto.reasonCodes).toEqual(["activity_elsewhere"]);
  });
});
