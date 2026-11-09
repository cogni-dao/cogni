// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/edge-caught-kpis.test`
 * Purpose: Prove `edge.caught@1` (story.5148) over in-memory sources: the canary verdict, unknown-vs-number
 *   (a number only after a proven canary AND its own Loki line), Caddy log-line parsing, canary exclusion, host
 *   derivation from the catalog roster, the one `edge_caught_window` event per compute, and abort handling.
 * Side-effects: none
 */

import type {
  CalculatorContext,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { describe, expect, it } from "vitest";
import type {
  DeliveryProbeResult,
  EdgeCatalogNode,
  LokiLogLine,
  LokiQueryRange,
} from "@/ports";
import {
  caughtQuery,
  classifyCanaryProbe,
  countCaught,
  createEdgeCaughtCalculators,
  decideWindow,
  EDGE_CANARY_PATH,
  EDGE_CAUGHT_ID,
  type EdgeCaughtWindowEvent,
  edgeApplicationHosts,
  hasProbeLine,
  isCanaryUri,
  MAX_CAUGHT_LINES,
  parseCaddyLine,
  probeLineQuery,
} from "./edge-caught-kpis";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const WINDOW = {
  start: new Date(NOW - 300_000).toISOString(),
  end: new Date(NOW).toISOString(),
};
const DOMAIN = "test.cognidao.org";
const HOST = DOMAIN;
const NONCE = "abc123";

const NODES: EdgeCatalogNode[] = [
  { slug: "operator", primary: true },
  { slug: "poly", primary: false },
  { slug: "toks5", primary: false },
];

/** A Caddy JSON access line, the shape slice 1's catch-all writes. */
function caddyLine(over: {
  host?: string;
  uri?: string;
  status?: number;
  caught?: boolean;
}): string {
  return JSON.stringify({
    level: "error",
    logger: "http.log.access.log0",
    msg: "handled request",
    request: {
      remote_ip: "10.0.0.1",
      method: "GET",
      host: over.host ?? HOST,
      uri: over.uri ?? "/api/v1/work/items",
    },
    status: over.status ?? 503,
    resp_headers:
      over.caught === false
        ? { "Content-Type": ["text/html"] }
        : { "X-Cogni-Edge": ["caught"], "X-Cogni-Edge-Cause": ["502"] },
  });
}
const lines = (...raw: string[]): LokiLogLine[] =>
  raw.map((line, i) => ({ ts: `${NOW - i}000000`, line }));

const canaryOk: DeliveryProbeResult = {
  kind: "response",
  status: 503,
  body: "",
  headers: { "x-cogni-edge": "caught", "x-cogni-edge-cause": "502" },
};

describe("edgeApplicationHosts", () => {
  it("joins the primary to the bare domain and the rest as <slug>-<domain> under a deep domain", () => {
    expect(edgeApplicationHosts("test.cognidao.org", NODES)).toEqual([
      "poly-test.cognidao.org",
      "test.cognidao.org",
      "toks5-test.cognidao.org",
    ]);
    expect(edgeApplicationHosts("preview.cognidao.org", NODES)).toContain(
      "poly-preview.cognidao.org"
    );
  });

  it("uses a dot under a short domain and bare domain for production", () => {
    expect(edgeApplicationHosts("cognidao.org", NODES)).toEqual([
      "cognidao.org",
      "poly.cognidao.org",
      "toks5.cognidao.org",
    ]);
  });
});

describe("classifyCanaryProbe", () => {
  it("passes only a 503 that carries X-Cogni-Edge: caught", () => {
    expect(classifyCanaryProbe(canaryOk)).toEqual({ ok: true });
  });

  it("fails an unreachable host, a 404 (a host the edge no longer serves), and an app's own 503", () => {
    expect(
      classifyCanaryProbe({ kind: "unreachable", code: "timeout" })
    ).toEqual({ ok: false, reason: "canary_unreachable" });
    expect(
      classifyCanaryProbe({ kind: "response", status: 404, body: "" })
    ).toEqual({ ok: false, reason: "canary_status", status: 404 });
    expect(
      classifyCanaryProbe({
        kind: "response",
        status: 503,
        body: "{}",
        headers: {},
      })
    ).toEqual({ ok: false, reason: "canary_no_edge_header", status: 503 });
  });

  it("treats a probe result without headers as no marker", () => {
    expect(
      classifyCanaryProbe({ kind: "response", status: 503, body: "" })
    ).toEqual({ ok: false, reason: "canary_no_edge_header", status: 503 });
  });
});

describe("parseCaddyLine and canary exclusion", () => {
  it("parses host, uri, status and the caught marker", () => {
    expect(
      parseCaddyLine(caddyLine({ host: "Poly-Test.cognidao.org:443" }))
    ).toEqual({
      host: "poly-test.cognidao.org",
      uri: "/api/v1/work/items",
      status: 503,
      caught: true,
    });
    expect(parseCaddyLine(caddyLine({ caught: false }))?.caught).toBe(false);
  });

  it("rejects text that is not a Caddy access line", () => {
    expect(parseCaddyLine("not json")).toBeUndefined();
    expect(parseCaddyLine('{"msg":"x"}')).toBeUndefined();
    expect(
      parseCaddyLine('{"request":{"host":"a"},"status":"503"}')
    ).toBeUndefined();
  });

  it("knows the canary path, with any query", () => {
    expect(isCanaryUri(EDGE_CANARY_PATH)).toBe(true);
    expect(isCanaryUri(`${EDGE_CANARY_PATH}?probe=x`)).toBe(true);
    expect(isCanaryUri("/__edge/caught/extra")).toBe(false);
    expect(isCanaryUri("/api/v1/x?next=/__edge/caught")).toBe(false);
  });

  it("counts caught lines for the host and excludes the canary", () => {
    const l = lines(
      caddyLine({}),
      caddyLine({ uri: "/" }),
      caddyLine({ uri: `${EDGE_CANARY_PATH}?probe=${NONCE}` }),
      caddyLine({ uri: EDGE_CANARY_PATH }),
      caddyLine({ host: "poly-test.cognidao.org" }),
      caddyLine({ caught: false, status: 502 })
    );
    expect(countCaught(l, HOST)).toEqual({
      caught: 2,
      canaryExcluded: 2,
      unparseable: 0,
    });
  });

  it("counts a line it cannot parse as unparseable, never as caught", () => {
    expect(countCaught(lines("garbage", caddyLine({})), HOST)).toEqual({
      caught: 1,
      canaryExcluded: 0,
      unparseable: 1,
    });
  });

  it("finds the probe's own line only by nonce, host and the caught 503", () => {
    const own = caddyLine({ uri: `${EDGE_CANARY_PATH}?probe=${NONCE}` });
    expect(hasProbeLine(lines(own), HOST, NONCE)).toBe(true);
    expect(hasProbeLine(lines(own), HOST, "other")).toBe(false);
    expect(hasProbeLine(lines(own), "poly-test.cognidao.org", NONCE)).toBe(
      false
    );
    expect(
      hasProbeLine(
        lines(
          caddyLine({
            uri: `${EDGE_CANARY_PATH}?probe=${NONCE}`,
            caught: false,
          })
        ),
        HOST,
        NONCE
      )
    ).toBe(false);
  });
});

describe("decideWindow: unknown unless the canary proves the path", () => {
  const clean = { caught: 0, canaryExcluded: 1, unparseable: 0, lineCount: 1 };

  it("reads 0 only with a proven canary, its own line, and a clean complete window", () => {
    expect(
      decideWindow({
        canary: { ok: true },
        probeLineSeen: true,
        window: clean,
        maxLines: MAX_CAUGHT_LINES,
      })
    ).toEqual({ kind: "number", caught: 0, canaryExcluded: 1 });
  });

  it("is unknown when the canary fails, even with a clean window", () => {
    expect(
      decideWindow({
        canary: { ok: false, reason: "canary_status", status: 404 },
        probeLineSeen: true,
        window: clean,
        maxLines: MAX_CAUGHT_LINES,
      })
    ).toEqual({ kind: "unknown", reason: "canary_status", canaryStatus: 404 });
  });

  it("is unknown when the probe's own log line is missing", () => {
    expect(
      decideWindow({
        canary: { ok: true },
        probeLineSeen: false,
        window: clean,
        maxLines: MAX_CAUGHT_LINES,
      })
    ).toEqual({ kind: "unknown", reason: "canary_log_missing" });
  });

  it("is unknown when the read filled its cap or held an unparseable line", () => {
    expect(
      decideWindow({
        canary: { ok: true },
        probeLineSeen: true,
        window: { ...clean, lineCount: MAX_CAUGHT_LINES },
        maxLines: MAX_CAUGHT_LINES,
      })
    ).toEqual({ kind: "unknown", reason: "log_read_truncated" });
    expect(
      decideWindow({
        canary: { ok: true },
        probeLineSeen: true,
        window: { ...clean, unparseable: 1 },
        maxLines: MAX_CAUGHT_LINES,
      })
    ).toEqual({ kind: "unknown", reason: "log_lines_unparseable" });
  });
});

describe("queries", () => {
  it("scopes the caught count to the env label and the host, with the verified marker", () => {
    expect(caughtQuery("candidate-a", HOST)).toBe(
      '{service="caddy", env="candidate-a"} |= "\\"X-Cogni-Edge\\":[\\"caught\\"]" |= "\\"host\\":\\"test.cognidao.org\\""'
    );
    expect(probeLineQuery("candidate-a", HOST, NONCE)).toContain(
      '|= "probe=abc123"'
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The calculator over fakes
// ---------------------------------------------------------------------------------------------

interface Harness {
  readonly calc: ReturnType<typeof createEdgeCaughtCalculators>[number];
  readonly events: EdgeCaughtWindowEvent[];
  readonly probes: { host: string; path: string }[];
  readonly queries: LokiQueryRange[];
  readonly sleeps: number[];
}

function harness(input: {
  probe?: DeliveryProbeResult | (() => Promise<DeliveryProbeResult>);
  /** The probe line appears in Loki on this poll (1-based); never when undefined. */
  probeLineOnPoll?: number;
  windowLines?: string[];
  loki?: "unwired" | "throws";
  domain?: string | undefined;
  env?: string | undefined;
}): Harness {
  const events: EdgeCaughtWindowEvent[] = [];
  const probes: { host: string; path: string }[] = [];
  const queries: LokiQueryRange[] = [];
  const sleeps: number[] = [];
  let polls = 0;
  const [calc] = createEdgeCaughtCalculators({
    env: "env" in input ? input.env : "candidate-a",
    domain: "domain" in input ? input.domain : DOMAIN,
    catalog: { edgeNodes: async () => NODES },
    probe: async ({ host, path }) => {
      probes.push({ host, path });
      const p = input.probe ?? canaryOk;
      return typeof p === "function" ? p() : p;
    },
    loki:
      input.loki === "unwired"
        ? null
        : {
            queryRange: async (range) => {
              queries.push(range);
              if (input.loki === "throws") throw new Error("loki down");
              if (range.query.includes("probe=")) {
                polls++;
                return input.probeLineOnPoll !== undefined &&
                  polls >= input.probeLineOnPoll
                  ? lines(
                      caddyLine({ uri: `${EDGE_CANARY_PATH}?probe=${NONCE}` })
                    )
                  : [];
              }
              return lines(...(input.windowLines ?? []));
            },
          },
    log: (e) => events.push(e),
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    nonce: () => NONCE,
  });
  if (!calc) throw new Error("no calculator");
  return { calc, events, probes, queries, sleeps };
}

function ctx(
  signal: AbortSignal = new AbortController().signal
): CalculatorContext {
  return {
    window: WINDOW,
    signal,
    budget: {
      timeoutMs: 45_000,
      maxSourceCalls: 100,
      maxRows: MAX_CAUGHT_LINES,
      maxResponseBytes: 4096,
    },
    read: (source) => source(signal, ctxBudget),
  };
}
const ctxBudget = {
  timeoutMs: 45_000,
  maxSourceCalls: 100,
  maxRows: MAX_CAUGHT_LINES,
  maxResponseBytes: 4096,
};

const compute = (
  h: Harness,
  params: unknown = { env: "candidate-a", host: HOST }
) => h.calc.compute(params, ctx());

const expectUnknown = (s: MetricSample, reason: string) => {
  expect(s.complete).toBe(false);
  expect(s.value).toBe(0);
  expect(s.reason).toBe(reason);
};

describe("createEdgeCaughtCalculators", () => {
  it("registers one id with dashes, a 300 s window and a volume display", () => {
    const h = harness({});
    expect(h.calc.id).toBe(EDGE_CAUGHT_ID);
    expect(h.calc.id).not.toContain("_");
    expect(h.calc.windowSeconds?.({})).toBe(300);
    expect(h.calc.display).toBe("volume");
    expect(
      h.calc.paramsSchema.safeParse({ env: "production", host: "Bad Host" })
        .success
    ).toBe(false);
    expect(
      h.calc.paramsSchema.safeParse({ env: "production", host: "cognidao.org" })
        .success
    ).toBe(true);
  });

  it("reports the caught count, canary excluded, after the probe's own line is read back", async () => {
    const h = harness({
      probeLineOnPoll: 2,
      windowLines: [
        caddyLine({}),
        caddyLine({}),
        caddyLine({}),
        caddyLine({ uri: `${EDGE_CANARY_PATH}?probe=${NONCE}` }),
      ],
    });
    const s = await compute(h);
    expect(s).toMatchObject({ value: 3, unit: "responses", complete: true });
    expect(s.evidenceRefs).toContain("edge:caught=3,canary_excluded=1");
    // The probe went to the canary with its nonce; the line was polled twice (4 s then 6 s).
    expect(h.probes).toEqual([
      { host: HOST, path: `${EDGE_CANARY_PATH}?probe=${NONCE}` },
    ]);
    expect(h.sleeps).toEqual([4000, 6000]);
    // The window read used the window bounds.
    const windowQuery = h.queries.at(-1);
    expect(windowQuery?.startNs).toBe(`${Date.parse(WINDOW.start)}000000`);
    expect(windowQuery?.endNs).toBe(`${Date.parse(WINDOW.end)}000000`);
    expect(windowQuery?.query).toBe(caughtQuery("candidate-a", HOST));
    // Exactly one event, a number.
    expect(h.events).toEqual([
      expect.objectContaining({
        env: "candidate-a",
        host: HOST,
        outcome: "number",
        caught: 3,
        reason: "none",
        canaryExcluded: 1,
      }),
    ]);
  });

  it("reads a proven 0 when the pipeline is proven and nothing was caught", async () => {
    const h = harness({ probeLineOnPoll: 1, windowLines: [] });
    const s = await compute(h);
    expect(s).toMatchObject({ value: 0, complete: true });
    expect(h.events[0]).toMatchObject({ outcome: "number", caught: 0 });
  });

  it("is unknown, never 0, when the canary 404s (a host no longer routed to the edge)", async () => {
    const h = harness({
      probe: { kind: "response", status: 404, body: "" },
      probeLineOnPoll: 1,
    });
    const s = await compute(h);
    expectUnknown(s, "source_failed");
    expect(s.evidenceRefs).toContain("edge:unknown=canary_status");
    expect(s.evidenceRefs).toContain("edge:canary_status=404");
    expect(h.queries).toHaveLength(0);
    expect(h.events).toEqual([
      expect.objectContaining({
        outcome: "unknown",
        caught: null,
        reason: "canary_status",
        canaryStatus: 404,
      }),
    ]);
  });

  it("is unknown when the probe is unreachable or throws", async () => {
    const unreachable = harness({
      probe: { kind: "unreachable", code: "timeout" },
    });
    expectUnknown(await compute(unreachable), "source_failed");
    expect(unreachable.events[0]?.reason).toBe("canary_unreachable");

    const throws = harness({
      probe: async () => {
        throw new Error("socket");
      },
    });
    expectUnknown(await compute(throws), "source_failed");
    expect(throws.events[0]?.reason).toBe("canary_unreachable");
  });

  it("is unknown when the canary passes but its own log line never reaches Loki", async () => {
    const h = harness({ windowLines: [] });
    const s = await compute(h);
    expectUnknown(s, "source_failed");
    expect(s.evidenceRefs).toContain("edge:unknown=canary_log_missing");
    // Three polls, no window read.
    expect(h.sleeps).toEqual([4000, 6000, 8000]);
    expect(h.queries).toHaveLength(3);
    expect(h.events[0]).toMatchObject({
      outcome: "unknown",
      reason: "canary_log_missing",
    });
  });

  it("is unknown for a host outside the roster (mesh hosts) and probes nothing", async () => {
    const h = harness({ probeLineOnPoll: 1 });
    const s = await compute(h, {
      env: "candidate-a",
      host: "mesh-cogni-test.cognidao.org",
    });
    expectUnknown(s, "incomplete_or_invalid_source");
    expect(s.evidenceRefs).toContain("edge:unknown=unprobed_host");
    expect(h.probes).toHaveLength(0);
    expect(h.events[0]).toMatchObject({
      reason: "unprobed_host",
      outcome: "unknown",
    });
  });

  it("is unknown for another env, or when the operator has no env domain", async () => {
    const other = harness({ probeLineOnPoll: 1 });
    expectUnknown(
      await compute(other, { env: "production", host: HOST }),
      "incomplete_or_invalid_source"
    );
    expect(other.events[0]?.reason).toBe("env_not_served");

    const noDomain = harness({ domain: undefined });
    expectUnknown(await compute(noDomain), "incomplete_or_invalid_source");
    expect(noDomain.probes).toHaveLength(0);
  });

  it("is unknown when the Loki reader is unwired, without probing", async () => {
    const h = harness({ loki: "unwired" });
    expectUnknown(await compute(h), "source_failed");
    expect(h.events[0]?.reason).toBe("loki_unwired");
    expect(h.probes).toHaveLength(0);
  });

  it("is unknown (source_error) when a Loki read fails, and logs one event", async () => {
    const h = harness({ loki: "throws" });
    expectUnknown(await compute(h), "source_failed");
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.reason).toBe("source_error");
  });

  it("is unknown when the window read fills its cap", async () => {
    const h = harness({
      probeLineOnPoll: 1,
      windowLines: Array.from({ length: MAX_CAUGHT_LINES }, () =>
        caddyLine({})
      ),
    });
    const s = await compute(h);
    expectUnknown(s, "incomplete_or_invalid_source");
    expect(h.events[0]?.reason).toBe("log_read_truncated");
  });

  it("logs the abort once and rethrows, so the engine records the timeout", async () => {
    const controller = new AbortController();
    const h = harness({
      probe: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    });
    await expect(
      h.calc.compute({ env: "candidate-a", host: HOST }, ctx(controller.signal))
    ).rejects.toThrow();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.reason).toBe("aborted");
  });

  it("reports watermarks that are not in the future of the compute", async () => {
    const h = harness({ probeLineOnPoll: 1 });
    const s = await compute(h);
    expect(s.sourceWatermarks.map((w) => w.source)).toEqual([
      "edge_canary_probe",
      "loki_caddy_access_log",
    ]);
    for (const w of s.sourceWatermarks)
      expect(Date.parse(w.asOf ?? "")).toBeLessThanOrEqual(NOW);
  });
});
