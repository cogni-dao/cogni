// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import {
  createMetricService,
  type MetricAction,
  type MetricDefinition,
  type MetricDefinitionsPort,
  MetricError,
  type MetricObservationsPort,
  MetricRegistry,
  type MetricSnapshot,
} from "@cogni-dao/metrics";
import { createFleetTrainLagCalculator } from "@cogni-dao/metrics/fleet-train-lag";
import { afterEach, describe, expect, it, vi } from "vitest";

const now = new Date("2026-11-22T00:00:00.000Z");
const params = {
  publisher: "cogni-dao/node-template",
  members: [{ name: "@cogni-dao/metrics", tagPrefix: "metrics-v" }],
  consumers: [{ repo: "cogni-dao/cogni", manifestPath: "app/package.json" }],
  graceHours: 24,
};
const definition = (id = "fleet"): MetricDefinition => ({
  id,
  title: id,
  revision: "rev1",
  spec: {
    calculatorId: "fleet.train-lag@1",
    params,
    cadenceSeconds: 3600,
    maxAgeSeconds: 7200,
  },
});

function fixture(
  options: {
    defs?: MetricDefinition[];
    authorize?: (action: MetricAction) => Promise<boolean>;
    refuseCompletion?: boolean;
  } = {}
) {
  const defs = options.defs ?? [definition()];
  const registry = new MetricRegistry();
  registry.register(createFleetTrainLagCalculator());
  let clock = now;
  let serial = 0;
  const rows = new Map<string, { hash: string; snapshot: MetricSnapshot }>();
  const tokens = new Map<string, { key: string; token: string }>();
  const definitions: MetricDefinitionsPort = {
    get: async (id) => defs.find((d) => d.id === id) ?? null,
    list: async () => ({ items: defs, nextCursor: null }),
    revision: async () => "rev1",
  };
  // This models receipt conflicts and token refusal; it is not a Postgres concurrency test.
  const observations: MetricObservationsPort = {
    request: async (id, key, hash) => {
      const row = rows.get(`${id}:${key}`);
      if (row && row.hash !== hash)
        throw new MetricError("idempotency_conflict", 422);
      return row?.snapshot ?? null;
    },
    reserve: async ({ requestKey, requestHash, snapshot }) => {
      const key = `${snapshot.observation.metricId}:${requestKey}`;
      const old = rows.get(key);
      if (old) {
        if (old.hash !== requestHash)
          throw new MetricError("idempotency_conflict", 422);
        return { snapshot: old.snapshot, leaseToken: null };
      }
      const token = `lease-${++serial}`;
      rows.set(key, { hash: requestHash, snapshot });
      tokens.set(snapshot.observation.id, { key, token });
      return { snapshot, leaseToken: token };
    },
    complete: async (id, token, result) => {
      const lease = tokens.get(id);
      if (options.refuseCompletion || !lease || lease.token !== token)
        return null;
      const row = rows.get(lease.key);
      if (!row) return null;
      row.snapshot = { ...row.snapshot, observation: result };
      return result;
    },
    history: async (id, hash, limit) =>
      [...rows.values()]
        .map((r) => r.snapshot.observation)
        .filter((o) => o.metricId === id && o.definitionHash === hash)
        .reverse()
        .slice(0, limit),
    lastGood: async (id, hash) =>
      [...rows.values()]
        .map((r) => r.snapshot.observation)
        .reverse()
        .find(
          (o) =>
            o.metricId === id && o.definitionHash === hash && o.status === "ok"
        ) ?? null,
    scheduledAttempts: async (id, hash, slot) =>
      [...rows.values()]
        .map((r) => r.snapshot.observation)
        .reverse()
        .filter(
          (o) =>
            o.metricId === id &&
            o.definitionHash === hash &&
            o.scheduledFor === slot
        ),
    expireLeases: async () => {},
    cursor: async () => null,
    advanceCursor: async () => {},
    get: async () => null,
    snapshot: async () => null,
    at: async () => null,
    buckets: async () => [],
  };
  const service = createMetricService({
    definitions,
    observations,
    registry,
    scope: { node: "operator", environment: "test", dataScope: "node-members" },
    now: () => clock,
    authorize: options.authorize ?? (async () => true),
  });
  return {
    registry,
    service,
    setNow: (value: Date) => {
      clock = value;
    },
  };
}

function source(
  options: {
    version?: string;
    date?: string | null;
    fail?: boolean;
    empty?: boolean;
  } = {}
) {
  const signals: AbortSignal[] = [];
  let calls = 0;
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers:
        options.date === null
          ? {}
          : { date: options.date ?? "Sun, 22 Nov 2026 00:00:00 GMT" },
    });
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (init?.signal) signals.push(init.signal);
      const url = String(input);
      if (options.fail) return response({}, 503);
      if (url.includes("matching-refs"))
        return response(
          options.empty ? [] : [{ ref: "refs/tags/train-v0.24.0" }]
        );
      if (url.includes("/releases/tags/"))
        return response({
          tag_name: "metrics-v0.24.0",
          published_at: "2026-11-20T00:00:00Z",
        });
      return response({
        dependencies: {
          "@cogni-dao/metrics": `https://github.com/cogni-dao/node-template/releases/download/metrics-v${options.version ?? "0.24.0"}/metrics.tgz`,
        },
      });
    }
  );
  return {
    fetch,
    signals,
    get calls() {
      return calls;
    },
  };
}

function installSource(s: ReturnType<typeof source>) {
  vi.stubGlobal("fetch", s.fetch);
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fleet factory on the installed metrics engine", () => {
  it("publishes its actual strict catalog and rejects invalid definitions", () => {
    const { registry } = fixture();
    const row = registry
      .describe()
      .find((entry) => entry.id === "fleet.train-lag@1");
    expect(row).toMatchObject({
      unit: "nodes",
      limits: { maxSourceCalls: 1 },
      paramsSchema: { additionalProperties: false },
    });
    expect(row?.paramsSchema.properties?.consumers).toMatchObject({
      items: { additionalProperties: false },
    });
    expect(() => registry.validate(definition())).not.toThrow();
    const invalid = definition();
    invalid.spec.params = { ...params, unexpected: true };
    expect(() => registry.validate(invalid)).toThrow(
      expect.objectContaining({ code: "invalid_definition" })
    );
    expect(() => registry.register(createFleetTrainLagCalculator())).toThrow(
      expect.objectContaining({ code: "duplicate_calculator" })
    );
  });

  it("preserves zero, lag and unavailable with the last good result", async () => {
    const { service } = fixture();
    const zero = source();
    installSource(zero);
    expect(
      await service.compute("fleet", { requestKey: "zero" })
    ).toMatchObject({ status: "ok", value: 0 });
    expect(zero.calls).toBe(3);
    expect(zero.signals).toHaveLength(3);
    expect(zero.signals.every((signal) => signal.aborted)).toBe(true);
    installSource(source({ version: "0.20.0" }));
    expect(await service.compute("fleet", { requestKey: "lag" })).toMatchObject(
      { status: "ok", value: 1 }
    );
    installSource(source({ fail: true }));
    expect(
      await service.compute("fleet", { requestKey: "failure" })
    ).toMatchObject({
      status: "unavailable",
      value: null,
      reason: "source_failed",
    });
    expect(await service.read("fleet")).toMatchObject({
      viewState: "unavailable",
      lastGood: { value: 1 },
    });
  });

  it("does not turn missing, future or incomplete sources into zero", async () => {
    for (const options of [
      { date: null },
      { date: "Mon, 23 Nov 2026 00:00:00 GMT" },
      { empty: true },
    ]) {
      const { service } = fixture();
      installSource(source(options));
      expect(
        await service.compute("fleet", { requestKey: "bad" })
      ).toMatchObject({ status: "unavailable", value: null });
    }
  });

  it("denies reads and computes before source access; replays and rejects payload drift", async () => {
    const denied = fixture({ authorize: async () => false });
    const src = source();
    installSource(src);
    await expect(
      denied.service.compute("fleet", { requestKey: "denied" })
    ).rejects.toMatchObject({ code: "metric_not_found" });
    await expect(denied.service.read("fleet")).rejects.toMatchObject({
      code: "metric_not_found",
    });
    expect(src.calls).toBe(0);
    const { service } = fixture();
    const first = await service.compute("fleet", { requestKey: "same" });
    expect((await service.compute("fleet", { requestKey: "same" })).id).toBe(
      first.id
    );
    await expect(
      service.compute("fleet", {
        requestKey: "same",
        evaluationAt: now.toISOString(),
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(src.calls).toBe(3);
  });

  it("refuses a simulated expired lease completion", async () => {
    const { service } = fixture({ refuseCompletion: true });
    installSource(source());
    await expect(
      service.compute("fleet", { requestKey: "fence" })
    ).rejects.toMatchObject({ code: "observation_lease_expired" });
  });

  it("aborts the real factory source on the old engine deadline", async () => {
    const { registry, service } = fixture();
    const calculator = registry.get("fleet.train-lag@1");
    expect(calculator.budget.timeoutMs).toBe(30_000);
    calculator.budget = { ...calculator.budget, timeoutMs: 10 };
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        })
    );
    expect(
      await service.compute("fleet", { requestKey: "timeout" })
    ).toMatchObject({ status: "error", reason: "source_timeout", value: null });
    expect(signal?.aborted).toBe(true);
  });

  it("retries a failed scheduled attempt and refreshes a healthy sibling", async () => {
    const sibling = definition("healthy");
    sibling.spec.calculatorId = "healthy@1";
    const f = fixture({ defs: [definition(), sibling] });
    f.registry.register({
      id: "healthy@1",
      unit: "nodes",
      paramsSchema: createFleetTrainLagCalculator().paramsSchema,
      budget: {
        timeoutMs: 1000,
        maxSourceCalls: 1,
        maxRows: 1,
        maxResponseBytes: 100,
      },
      compute: async () => ({
        complete: true,
        value: 2,
        unit: "nodes",
        sourceWatermarks: [{ source: "sibling", asOf: now.toISOString() }],
        evidenceRefs: [],
      }),
    });
    installSource(source({ fail: true }));
    const first = await f.service.refreshDue();
    expect(first.observations.map((o) => [o.metricId, o.status])).toEqual([
      ["fleet", "unavailable"],
      ["healthy", "ok"],
    ]);
    f.setNow(new Date(now.getTime() + 60_000));
    installSource(source());
    const retry = await f.service.refreshDue();
    expect(retry.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metricId: "fleet", status: "ok", value: 0 }),
      ])
    );
  });
});
