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
}

function harness(input: {
  sources: () => Promise<AkashTxLeaseLogSources>;
  windows: () => Promise<readonly ProviderLeaseLogLine[]>;
  failPush?: () => boolean;
}): Harness {
  const pushes: LeaseLogStream[][] = [];
  const pump = new LeaseLogPump({
    sources: input.sources,
    readLogs: () => input.windows(),
    push: async (streams) => {
      if (input.failPush?.()) throw new Error("loki down");
      pushes.push([...streams]);
    },
    log: silentLog(),
    now: () => new Date(1_700_000_000_000),
  });
  return { pump, pushes };
}

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

    const streams = pushes[0] ?? [];
    const services = streams.map((s) => s.labels.service).sort();
    expect(services).toEqual(["app", "paper-trader"]);
    for (const stream of streams) {
      expect(stream.labels).toMatchObject({
        app: "cogni-template",
        env: "candidate-a",
        node: POLY_SOURCE.nodeId,
        service_name: "poly",
        source: "lease",
      });
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
