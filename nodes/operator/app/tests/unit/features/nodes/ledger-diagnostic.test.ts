// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  admitLedgerBinding,
  buildWorkflowArgs,
  emptyLedgerDiagnostic,
  verifyCurrentLedgerOwnership,
} from "@cogni/scheduler-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLedgerDiagnosticQuery,
  readLedgerDiagnostic,
} from "@/features/nodes/observability-temporal";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const nodeId = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const foreign = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
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
const readOptions = () => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 4500,
});

describe("public preparation and authority seams", () => {
  it("retains resolved identity even when authorization rejects", async () => {
    const onNodeResolved = vi.fn();
    await expect(
      readLedgerDiagnostic(
        {
          ref: "operator",
          actorId: "agent",
          env: "production",
          ...readOptions(),
          onNodeResolved,
        },
        {
          check() {},
          lookup: async () => ({
            nodeId,
            slug: "operator",
            status: "active",
            deployEnvs: ["production"],
            activityEnv: "production",
          }),
          authorize: async () => {
            throw new Error("authz_denied");
          },
          bind: async () => binding,
          finish() {},
          reader: { read: vi.fn() },
        }
      )
    ).rejects.toThrow("authz_denied");
    expect(onNodeResolved).toHaveBeenCalledWith(nodeId);
  });
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

describe("terminal event boundary", () => {
  it("emits validated identity, reasons and attempted calls for success and failure", async () => {
    const info = vi.fn();
    const controller = new AbortController();
    const createPreparation = vi.fn(() => prep);
    const prep = {
      credentialStore: {},
      check() {},
      finish() {},
      dispose() {},
      lookup: async () => ({
        nodeId,
        slug: "operator",
        status: "active",
        deployEnvs: ["production"],
        activityEnv: "production",
      }),
      authorize: async () => {},
      bind: async () => binding,
      reader: { read: vi.fn() },
    };
    vi.doMock("@/app/_lib/auth/request-identity", () => ({
      resolveRequestIdentity: vi.fn(),
    }));
    vi.doMock("@/app/_lib/auth/route-identity", () => ({
      resolveRouteIdentity: async () => ({ ok: true, user: { id: "agent" } }),
    }));
    vi.doMock("@/bootstrap/ledger-diagnostic", () => ({
      LedgerRequestError: class extends Error {
        constructor(
          readonly code: string,
          readonly status: number
        ) {
          super(code);
        }
      },
      createLedgerPreparation: createPreparation,
      createDiagnosticRequestBudget: () => ({
        signal: controller.signal,
        startedAt: Date.now(),
        deadline: Date.now() + 4500,
        dispose() {},
      }),
    }));
    vi.doMock("@/shared/observability", () => ({
      EVENT_NAMES: { NODE_OBSERVABILITY_TEMPORAL_COMPLETE: "terminal" },
      makeLogger: () => ({ info }),
    }));
    const { GET } = await import(
      "@/app/api/v1/nodes/[id]/observability/temporal/ledger/route"
    );
    prep.reader.read.mockImplementation(async (_binding, options) => {
      options.onAttempt();
      options.onAttempt();
      return {
        ...emptyLedgerDiagnostic(binding),
        state: "partial",
        reasonCodes: ["selection_incomplete"],
        budgets: { calls: 2, complete: false },
      };
    });
    const request = new Request("http://localhost/api?env=production");
    expect(
      (await GET(request, { params: Promise.resolve({ id: "operator" }) }))
        .status
    ).toBe(200);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      nodeId,
      env: "production",
      calls: 2,
      reasonCodes: ["selection_incomplete"],
      result: "partial",
    });
    prep.reader.read.mockImplementation(async (_binding, options) => {
      options.onAttempt();
      options.onAttempt();
      throw new Error("temporal_read_failed");
    });
    expect(
      (await GET(request, { params: Promise.resolve({ id: "operator" }) }))
        .status
    ).toBe(502);
    expect(info.mock.calls[1]?.[0]).toMatchObject({
      nodeId,
      env: "production",
      calls: 2,
      reasonCodes: ["temporal_read_failed"],
    });
    expect(info).toHaveBeenCalledTimes(2);

    prep.reader.read.mockClear();
    createPreparation.mockClear();
    controller.abort();
    expect(
      (await GET(request, { params: Promise.resolve({ id: "operator" }) }))
        .status
    ).toBe(503);
    expect(info.mock.calls[2]?.[0]).toMatchObject({
      env: "production",
      calls: 0,
      result: "deadline_exceeded",
      reasonCodes: ["deadline_exceeded"],
    });
    expect(prep.reader.read).not.toHaveBeenCalled();
    expect(createPreparation).not.toHaveBeenCalled();
    const invalid = new Request("http://localhost/api?env=PRIVATE_SENTINEL");
    expect(
      (await GET(invalid, { params: Promise.resolve({ id: "operator" }) }))
        .status
    ).toBe(503);
    expect(JSON.stringify(info.mock.calls[3])).not.toContain(
      "PRIVATE_SENTINEL"
    );
    expect(info.mock.calls[3]?.[0].env).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(4);
  });
});
