// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import type {
  AkashTxLeaseLogSource,
  AkashTxLeaseLogSources,
  LeaseLogStream,
  ProviderLeaseLogLine,
} from "@/ports";

import { LeaseLogPump, type LeaseLogPumpLogger } from "./lease-log-pump";

const POLY_SOURCE: AkashTxLeaseLogSource = {
  nodeId: "4b06359a-a859-4399-888e-a8c7a6696f7e",
  workload: "poly",
  environment: "candidate-a",
  dseq: "7001",
  gseq: 1,
  oseq: 1,
  providerAccount: "akash1provider",
  providerHostUri: "https://provider.example.com:8443",
  services: ["app", "paper-trader"],
};

function snapshot(
  sources: readonly AkashTxLeaseLogSource[]
): AkashTxLeaseLogSources {
  return { sources, token: "jwt", ttlSeconds: 300 };
}

function silentLog(): LeaseLogPumpLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

interface Harness {
  pump: LeaseLogPump;
  pushes: LeaseLogStream[][];
  errors: { fields: Record<string, unknown>; message: string }[];
}

function harness(input: {
  sources: () => Promise<AkashTxLeaseLogSources>;
  windows: () => Promise<readonly ProviderLeaseLogLine[]>;
  /** Decide per push request; may throw a custom error instead of returning true. */
  failPush?: (streams: readonly LeaseLogStream[]) => boolean;
  maxPushLines?: number;
}): Harness {
  const pushes: LeaseLogStream[][] = [];
  const errors: Harness["errors"] = [];
  const pump = new LeaseLogPump({
    sources: input.sources,
    readLogs: () => input.windows(),
    push: async (streams) => {
      if (input.failPush?.(streams)) throw new Error("loki down");
      pushes.push([...streams]);
    },
    log: {
      ...silentLog(),
      error: (fields, message) => errors.push({ fields, message }),
    },
    now: () => new Date(1_700_000_000_000),
    ...(input.maxPushLines ? { maxPushLines: input.maxPushLines } : {}),
  });
  return { pump, pushes, errors };
}

const shippedLines = (pushes: LeaseLogStream[][]): string[] =>
  pushes.flat().flatMap((s) => s.values.map((v) => v[1]));

describe("LeaseLogPump.tick", () => {
  it("ships every service's lines with per-service ledger-derived labels", async () => {
    const { pump, pushes } = harness({
      sources: async () => snapshot([POLY_SOURCE]),
      windows: async () => [
        { name: "app-abc12-x", message: "app line 1" },
        { name: "paper-trader-def34-y", message: "sidecar line 1" },
      ],
    });

    const report = await pump.tick();
    expect(report.pushed).toBe(true);
    expect(report.streams).toBe(2);

    // BOUNDED_PER_STREAM_PUSHES: one stream per push request.
    expect(pushes.every((p) => p.length === 1)).toBe(true);
    const streams = pushes.flat();
    const services = streams.map((s) => s.labels.service).sort();
    expect(services).toEqual(["app", "paper-trader"]);
    for (const stream of streams) {
      expect(stream.labels).toMatchObject({
        app: "cogni-template",
        env: "candidate-a",
        node: POLY_SOURCE.nodeId,
        source: "lease",
      });
      // STABLE_CONTEXT_ENVELOPE: service_name mirrors service; the renameable slug
      // is never a label; no stream label is asserted.
      expect(stream.labels.service_name).toBe(stream.labels.service);
      expect(stream.labels).not.toHaveProperty("stream");
      expect(Object.values(stream.labels)).not.toContain("poly");
    }
  });

  it("prepends one attach marker per newly seen stream, then never again", async () => {
    let window: ProviderLeaseLogLine[] = [
      { name: "app-abc12-x", message: "line 1" },
    ];
    const { pump, pushes } = harness({
      sources: async () => snapshot([POLY_SOURCE]),
      windows: async () => window,
    });

    await pump.tick();
    const first = (pushes[0] ?? [])[0];
    expect(first?.values[0]?.[1]).toContain("lease_log_pump_attached");
    expect(first?.values[1]?.[1]).toBe("line 1");

    window = [
      { name: "app-abc12-x", message: "line 1" },
      { name: "app-abc12-x", message: "line 2" },
    ];
    await pump.tick();
    const second = (pushes[1] ?? [])[0];
    expect(second?.values.map((v) => v[1])).toEqual(["line 2"]);
  });

  it("does not advance cursors when the push fails, and re-ships next tick", async () => {
    let failing = true;
    const { pump, pushes } = harness({
      sources: async () => snapshot([POLY_SOURCE]),
      windows: async () => [{ name: "app-abc12-x", message: "line 1" }],
      failPush: () => failing,
    });

    const failed = await pump.tick();
    expect(failed.pushed).toBe(false);
    expect(pushes).toHaveLength(0);

    failing = false;
    const recovered = await pump.tick();
    expect(recovered.pushed).toBe(true);
    const values = (pushes[0] ?? [])[0]?.values.map((v) => v[1]);
    expect(values).toContain("line 1");
  });

  it("skips an unreachable source without wedging the others", async () => {
    const other: AkashTxLeaseLogSource = {
      ...POLY_SOURCE,
      dseq: "7002",
      workload: "toks4",
      nodeId: "21d7ae14-210c-4495-ab6c-6fe5caad34a6",
      services: ["app"],
    };
    const { pump, pushes } = harness({
      sources: async () => snapshot([POLY_SOURCE, other]),
      windows: (() => {
        let call = 0;
        return async (): Promise<readonly ProviderLeaseLogLine[]> => {
          call += 1;
          if (call === 1) throw new Error("provider unreachable");
          return [{ name: "app-abc12-x", message: "alive" }];
        };
      })(),
    });

    const report = await pump.tick();
    expect(report.skippedSources).toBe(1);
    expect(report.pushed).toBe(true);
    expect((pushes[0] ?? [])[0]?.labels.node).toBe(other.nodeId);
  });

  it("a failing stream's push neither blocks nor un-commits the other streams (bug.5516)", async () => {
    let window: ProviderLeaseLogLine[] = [
      { name: "app-abc12-x", message: "app 1" },
      { name: "paper-trader-def34-y", message: "sidecar 1" },
    ];
    let appFails = true;
    const { pump, pushes, errors } = harness({
      sources: async () => snapshot([POLY_SOURCE]),
      windows: async () => window,
      failPush: (streams) =>
        appFails && streams.some((s) => s.labels.service === "app"),
    });

    const first = await pump.tick();
    expect(first).toMatchObject({
      streams: 2,
      pushedStreams: 1,
      failedStreams: 1,
      pushed: true,
    });
    expect(pushes.flat().map((s) => s.labels.service)).toEqual([
      "paper-trader",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("lease_log_pump_push_failed");
    expect(errors[0]?.fields).toMatchObject({ service: "app", lines: 2 });

    // Next cycle: the sidecar's cursor committed, so only its NEW line ships; the app's
    // cursor did not, so its attach marker + line re-ship (at-least-once).
    appFails = false;
    pushes.length = 0;
    window = [
      ...window,
      { name: "paper-trader-def34-y", message: "sidecar 2" },
    ];
    const second = await pump.tick();
    expect(second).toMatchObject({ pushedStreams: 2, failedStreams: 0 });
    const byService = Object.fromEntries(
      pushes.flat().map((s) => [s.labels.service, s.values.map((v) => v[1])])
    );
    expect(byService["paper-trader"]).toEqual(["sidecar 2"]);
    expect(byService.app?.[0]).toContain("lease_log_pump_attached");
    expect(byService.app?.[1]).toBe("app 1");
  });

  it("chunks a stream by line cap and commits only after every chunk lands", async () => {
    const window: ProviderLeaseLogLine[] = ["l1", "l2", "l3", "l4"].map(
      (message) => ({ name: "app-abc12-x", message })
    );
    let failSecondChunk = true;
    let requests = 0;
    const { pump, pushes, errors } = harness({
      sources: async () => snapshot([POLY_SOURCE]),
      windows: async () => window,
      maxPushLines: 2,
      failPush: () => {
        requests += 1;
        return failSecondChunk && requests === 2;
      },
    });

    // attach + 4 lines = 5 values → chunks of 2/2/1; chunk 2 fails, chunk 3 never sent.
    const failed = await pump.tick();
    expect(failed).toMatchObject({ pushedStreams: 0, failedStreams: 1 });
    expect(requests).toBe(2);
    expect(errors[0]?.fields).toMatchObject({ chunk: 2, chunks: 3, lines: 2 });

    // Cursor was not committed: the whole stream re-ships, still in ≤2-line requests.
    failSecondChunk = false;
    pushes.length = 0;
    const recovered = await pump.tick();
    expect(recovered).toMatchObject({ pushedStreams: 1, pushedLines: 5 });
    expect(pushes.every((p) => (p[0]?.values.length ?? 0) <= 2)).toBe(true);
    expect(shippedLines(pushes).slice(1)).toEqual(["l1", "l2", "l3", "l4"]);

    // Committed: an unchanged window ships nothing.
    pushes.length = 0;
    await pump.tick();
    expect(pushes).toHaveLength(0);
  });

  it("logs the failure's cause code and chunk size, never the credential", async () => {
    const errors: { fields: Record<string, unknown>; message: string }[] = [];
    const pump = new LeaseLogPump({
      sources: async () => snapshot([POLY_SOURCE]),
      readLogs: async () => [{ name: "app-abc12-x", message: "hello" }],
      push: async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("other side closed"), {
            code: "UND_ERR_SOCKET",
          }),
        });
      },
      log: {
        ...silentLog(),
        error: (fields, message) => errors.push({ fields, message }),
      },
    });

    await pump.tick();
    const fields = errors[0]?.fields ?? {};
    expect(fields).toMatchObject({
      errorName: "TypeError",
      causeMessage: "fetch failed",
      causeCode: "UND_ERR_SOCKET",
      causeDetail: "other side closed",
      lines: 2,
    });
    expect(fields.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(fields)).not.toMatch(/jwt|authorization|password/i);
  });

  it("ships only new lines once a stream outgrows the retained tail (bug.5516)", async () => {
    const lines = (from: number, to: number): ProviderLeaseLogLine[] =>
      Array.from({ length: to - from }, (_, i) => ({
        name: "app-abc12-x",
        message: `line ${from + i}`,
      }));
    // 300-line window > default maxTail (200): previously re-shipped in full every poll.
    let window = lines(0, 300);
    const { pump, pushes } = harness({
      sources: async () => snapshot([POLY_SOURCE]),
      windows: async () => window,
    });
    await pump.tick();
    expect(shippedLines(pushes)).toHaveLength(301); // attach + 300

    pushes.length = 0;
    window = lines(1, 301);
    await pump.tick();
    expect(shippedLines(pushes)).toEqual(["line 300"]);

    pushes.length = 0;
    await pump.tick();
    expect(pushes).toHaveLength(0);
  });

  it("drops successful fast readyz access lines and keeps every other line (task.5344)", async () => {
    const access = (fields: Record<string, unknown>): string =>
      JSON.stringify({ level: 30, msg: "request complete", ...fields });
    const readyzOk = access({
      route: "meta.readyz",
      status: 200,
      durationMs: 3,
    });
    const readyz503 = access({
      route: "meta.readyz",
      status: 503,
      durationMs: 4,
    });
    const readyzSlow = access({
      route: "meta.readyz",
      status: 200,
      durationMs: 1500,
    });
    const readyzNoDuration = access({ route: "meta.readyz", status: 200 });
    const appLine = access({ route: "work.items.list", status: 200 });
    const { pump, pushes } = harness({
      sources: async () => snapshot([POLY_SOURCE]),
      windows: async () =>
        [
          readyzOk,
          readyz503,
          readyzOk,
          appLine,
          readyzSlow,
          readyzNoDuration,
          "plain non-JSON line",
          '{"route":"meta.readyz"',
        ].map((message) => ({ name: "app-abc12-x", message })),
    });

    const report = await pump.tick();
    expect(shippedLines(pushes).slice(1)).toEqual([
      readyz503,
      appLine,
      readyzSlow,
      readyzNoDuration,
      "plain non-JSON line",
      '{"route":"meta.readyz"',
    ]);
    expect(report).toMatchObject({ pushedLines: 7, droppedLines: 2 });
  });

  it("advances a readyz-only stream's cursor so dropped lines never re-ship (task.5344)", async () => {
    const readyzOk = (n: number): ProviderLeaseLogLine => ({
      name: "app-abc12-x",
      message: JSON.stringify({
        route: "meta.readyz",
        status: 200,
        durationMs: 2,
        reqId: `r${n}`,
      }),
    });
    let window: ProviderLeaseLogLine[] = [readyzOk(1), readyzOk(2)];
    const { pump, pushes } = harness({
      sources: async () => snapshot([POLY_SOURCE]),
      windows: async () => window,
    });

    // First sight still ships the attach marker (SILENCE_IS_DETECTABLE).
    await pump.tick();
    expect(shippedLines(pushes)).toHaveLength(1);
    expect(shippedLines(pushes)[0]).toContain("lease_log_pump_attached");

    // Only dropped lines are new: nothing ships, yet the cursor moves past them.
    pushes.length = 0;
    window = [readyzOk(1), readyzOk(2), readyzOk(3)];
    const quiet = await pump.tick();
    expect(pushes).toHaveLength(0);
    expect(quiet).toMatchObject({ streams: 0, droppedLines: 1 });

    // A real line ships alone; earlier readyz lines are not re-evaluated as new.
    pushes.length = 0;
    window = [
      readyzOk(2),
      readyzOk(3),
      { name: "app-abc12-x", message: "boot complete" },
    ];
    const next = await pump.tick();
    expect(shippedLines(pushes)).toEqual(["boot complete"]);
    expect(next).toMatchObject({ droppedLines: 0 });
  });

  it("absorbs a sources outage and reports an idle tick", async () => {
    const { pump, pushes } = harness({
      sources: async () => {
        throw new Error("actuator down");
      },
      windows: async () => [],
    });
    const report = await pump.tick();
    expect(report).toMatchObject({ sources: 0, streams: 0, pushed: false });
    expect(pushes).toHaveLength(0);
  });
});
