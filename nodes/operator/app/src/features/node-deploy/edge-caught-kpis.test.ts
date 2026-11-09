// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/edge-caught-kpis.test`
 * Purpose: Prove `edge.caught@1` (story.5148) over in-memory sources: the canary verdict, unknown-vs-number
 *   (a number only after a proven canary AND its own Loki line; an empty vector is a proven 0), the instant count
 *   query (per host and env-wide, 300 s / 1 h / 24 h, canary excluded, no mesh host), Caddy log-line parsing, host
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
  LokiInstantQuery,
  LokiLogLine,
  LokiQueryRange,
  LokiVectorSample,
} from "@/ports";
import {
  caughtCountQuery,
  classifyCanaryProbe,
  createEdgeCaughtCalculators,
  decideWindow,
  EDGE_CANARY_PATH,
  EDGE_CAUGHT_ID,
  type EdgeCaughtWindowEvent,
  edgeApplicationHosts,
  hasProbeLine,
  hostLineFilter,
  isCanaryUri,
  MAX_PROBE_LINES,
  parseCaddyLine,
  probeLineQuery,
  vectorTotal,
} from "./edge-caught-kpis";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const WINDOW = {
  start: new Date(NOW - 300_000).toISOString(),
  end: new Date(NOW).toISOString(),
};
const DOMAIN = "test.cognidao.org";
const HOST = DOMAIN;
const POLY = "poly-test.cognidao.org";
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
const vec = (...values: number[]): LokiVectorSample[] =>
  values.map((value) => ({ labels: {}, value }));

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

describe("parseCaddyLine and the probe line", () => {
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
    expect(isCanaryUri("/-/edge-probe/extra")).toBe(false);
    expect(isCanaryUri("/api/v1/x?next=/-/edge-probe")).toBe(false);
  });

  it("finds the probe's own line only by nonce, host and the caught 503, and tolerates a port or uppercase host", () => {
    const own = caddyLine({ uri: `${EDGE_CANARY_PATH}?probe=${NONCE}` });
    expect(hasProbeLine(lines(own), HOST, NONCE)).toBe(true);
    expect(
      hasProbeLine(
        lines(
          caddyLine({
            host: "TEST.cognidao.org:443",
            uri: `${EDGE_CANARY_PATH}?probe=${NONCE}`,
          })
        ),
        HOST,
        NONCE
      )
    ).toBe(true);
    expect(hasProbeLine(lines(own), HOST, "other")).toBe(false);
    expect(hasProbeLine(lines(own), POLY, NONCE)).toBe(false);
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

describe("vectorTotal and decideWindow: unknown unless the canary proves the path", () => {
  it("totals a vector; an empty vector is 0; a bad sample is undefined", () => {
    expect(vectorTotal([])).toBe(0);
    expect(vectorTotal(vec(7))).toBe(7);
    expect(vectorTotal(vec(2, 3))).toBe(5);
    expect(vectorTotal(vec(Number.NaN))).toBeUndefined();
    expect(vectorTotal(vec(-1))).toBeUndefined();
    expect(vectorTotal(vec(Number.POSITIVE_INFINITY))).toBeUndefined();
  });

  it("reads a number only with a proven canary, its own line, and a valid vector (empty = 0)", () => {
    expect(
      decideWindow({
        canary: { ok: true },
        probeLineSeen: true,
        vector: vec(4),
      })
    ).toEqual({ kind: "number", caught: 4 });
    expect(
      decideWindow({ canary: { ok: true }, probeLineSeen: true, vector: [] })
    ).toEqual({ kind: "number", caught: 0 });
  });

  it("is unknown when the canary fails, even with a vector", () => {
    expect(
      decideWindow({
        canary: { ok: false, reason: "canary_status", status: 404 },
        probeLineSeen: true,
        vector: vec(0),
      })
    ).toEqual({ kind: "unknown", reason: "canary_status", canaryStatus: 404 });
  });

  it("is unknown when the probe's own log line is missing", () => {
    expect(
      decideWindow({
        canary: { ok: true },
        probeLineSeen: false,
        vector: vec(0),
      })
    ).toEqual({ kind: "unknown", reason: "canary_log_missing" });
  });

  it("is unknown when the vector is invalid", () => {
    expect(
      decideWindow({
        canary: { ok: true },
        probeLineSeen: true,
        vector: vec(Number.NaN),
      })
    ).toEqual({ kind: "unknown", reason: "count_invalid" });
  });
});

describe("queries", () => {
  it("counts caught lines of one host as an instant metric query, canary excluded, no line cap", () => {
    expect(caughtCountQuery("candidate-a", [HOST], 300)).toBe(
      'sum(count_over_time({service="caddy", env="candidate-a"} |= "\\"X-Cogni-Edge\\":[\\"caught\\"]" != "/-/edge-probe" |~ `(?i)"host":"test\\.cognidao\\.org(:[0-9]+)?"` [300s]))'
    );
    expect(caughtCountQuery("production", [HOST], 86400)).toContain("[86400s]");
    expect(caughtCountQuery("production", [HOST], 3600)).toContain("[3600s]");
  });

  it("matches several hosts with one alternation (env-wide), never a mesh host", () => {
    const q = caughtCountQuery("candidate-a", [POLY, HOST], 3600);
    expect(q).toContain(
      '`(?i)"host":"(poly-test\\.cognidao\\.org|test\\.cognidao\\.org)(:[0-9]+)?"`'
    );
    expect(q).not.toContain("mesh");
    expect(q).toContain('!= "/-/edge-probe"');
  });

  it("builds the probe-line query with the nonce", () => {
    expect(probeLineQuery("candidate-a", HOST, NONCE)).toContain(
      '|= "probe=abc123"'
    );
  });

  it("pre-filters with a case-insensitive host that allows a port, so :443 and uppercase lines reach the parser", () => {
    const m = /\|~ `([^`]+)`/.exec(hostLineFilter([HOST]));
    // LogQL regex is RE2: translate the (?i) flag for JS.
    const re = new RegExp((m?.[1] ?? "").replace("(?i)", ""), "i");
    for (const host of [
      "test.cognidao.org",
      "test.cognidao.org:443",
      "TEST.Cognidao.org:80",
    ])
      expect(re.test(`{"request":{"host":"${host}","uri":"/"}}`)).toBe(true);
    // A different host, or one that only ends like this one, does not pass.
    expect(re.test('{"request":{"host":"poly-test.cognidao.org"}}')).toBe(
      false
    );
    expect(re.test('{"request":{"host":"testXcognidao.org"}}')).toBe(false);
  });

  it("an alternation matches each host, with a port or uppercase, and nothing else", () => {
    const m = /\|~ `([^`]+)`/.exec(hostLineFilter([POLY, HOST]));
    const re = new RegExp((m?.[1] ?? "").replace("(?i)", ""), "i");
    for (const host of [POLY, `${POLY}:443`, HOST.toUpperCase(), `${HOST}:80`])
      expect(re.test(`{"request":{"host":"${host}"}}`)).toBe(true);
    expect(re.test('{"request":{"host":"mesh-cogni-test.cognidao.org"}}')).toBe(
      false
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
  readonly instants: LokiInstantQuery[];
  readonly sleeps: number[];
}

function harness(input: {
  probe?: DeliveryProbeResult | (() => Promise<DeliveryProbeResult>);
  /** Per-host canary answers (a host not listed gets `probe`, else the passing canary). */
  probeByHost?: Record<string, DeliveryProbeResult>;
  /** The probe line appears in Loki on this poll (1-based); never when undefined. */
  probeLineOnPoll?: number;
  vector?: LokiVectorSample[];
  loki?: "unwired" | "range-throws" | "instant-throws";
  domain?: string | undefined;
  env?: string | undefined;
  nodes?: EdgeCatalogNode[];
}): Harness {
  const events: EdgeCaughtWindowEvent[] = [];
  const probes: { host: string; path: string }[] = [];
  const queries: LokiQueryRange[] = [];
  const instants: LokiInstantQuery[] = [];
  const sleeps: number[] = [];
  let polls = 0;
  const [calc] = createEdgeCaughtCalculators({
    env: "env" in input ? input.env : "candidate-a",
    domain: "domain" in input ? input.domain : DOMAIN,
    catalog: { edgeNodes: async () => input.nodes ?? NODES },
    probe: async ({ host, path }) => {
      probes.push({ host, path });
      const byHost = input.probeByHost?.[host];
      if (byHost) return byHost;
      const p = input.probe ?? canaryOk;
      return typeof p === "function" ? p() : p;
    },
    loki:
      input.loki === "unwired"
        ? null
        : {
            queryRange: async (range) => {
              queries.push(range);
              if (input.loki === "range-throws") throw new Error("loki down");
              polls++;
              return input.probeLineOnPoll !== undefined &&
                polls >= input.probeLineOnPoll
                ? lines(
                    caddyLine({ uri: `${EDGE_CANARY_PATH}?probe=${NONCE}` })
                  )
                : [];
            },
            queryInstant: async (q) => {
              instants.push(q);
              if (input.loki === "instant-throws") throw new Error("loki 500");
              return input.vector ?? [];
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
  return { calc, events, probes, queries, instants, sleeps };
}

const ctxBudget = {
  timeoutMs: 60_000,
  maxSourceCalls: 100,
  maxRows: MAX_PROBE_LINES,
  maxResponseBytes: 4096,
};

function ctx(
  signal: AbortSignal = new AbortController().signal
): CalculatorContext {
  return {
    window: WINDOW,
    signal,
    budget: ctxBudget,
    read: (source) => source(signal, ctxBudget),
  };
}

const compute = (
  h: Harness,
  params: unknown = { env: "candidate-a", host: HOST }
) => h.calc.compute(params, ctx());

const expectUnknown = (s: MetricSample, reason: string) => {
  expect(s.complete).toBe(false);
  expect(s.value).toBe(0);
  expect(s.reason).toBe(reason);
};

describe("params", () => {
  const h = harness({});
  const ok = (p: unknown) => h.calc.paramsSchema.safeParse(p).success;

  it("registers one id with dashes and a volume display", () => {
    expect(h.calc.id).toBe(EDGE_CAUGHT_ID);
    expect(h.calc.id).not.toContain("_");
    expect(h.calc.display).toBe("volume");
  });

  it("defaults the window to 300 s and allows only 300, 3600 and 86400", () => {
    expect(h.calc.windowSeconds?.({ env: "production", host: HOST })).toBe(300);
    expect(h.calc.windowSeconds?.({ env: "production" })).toBe(300);
    expect(
      h.calc.windowSeconds?.({ env: "production", windowSeconds: 3600 })
    ).toBe(3600);
    expect(
      h.calc.windowSeconds?.({ env: "production", windowSeconds: 86400 })
    ).toBe(86400);
    expect(ok({ env: "production", windowSeconds: 300 })).toBe(true);
    expect(ok({ env: "production", windowSeconds: 60 })).toBe(false);
    expect(ok({ env: "production", windowSeconds: 7200 })).toBe(false);
  });

  it("makes host optional, keeps it a valid hostname, and stays strict", () => {
    expect(ok({ env: "production" })).toBe(true);
    expect(ok({ env: "production", host: "cognidao.org" })).toBe(true);
    expect(ok({ env: "production", host: "Bad Host" })).toBe(false);
    expect(ok({ env: "production", extra: 1 })).toBe(false);
    expect(ok({ host: "cognidao.org" })).toBe(false);
  });
});

describe("edge.caught@1 per host", () => {
  it("reports the instant count after the probe's own line is read back", async () => {
    const h = harness({ probeLineOnPoll: 2, vector: vec(3) });
    const s = await compute(h);
    expect(s).toMatchObject({ value: 3, unit: "responses", complete: true });
    expect(s.evidenceRefs).toContain("edge:caught=3");
    expect(s.evidenceRefs).toContain("edge:scope=host");
    // The probe went to the canary with its nonce; the line was polled twice (4 s then 6 s).
    expect(h.probes).toEqual([
      { host: HOST, path: `${EDGE_CANARY_PATH}?probe=${NONCE}` },
    ]);
    expect(h.sleeps).toEqual([4000, 6000]);
    // One instant count query, evaluated at the window end, 300 s wide, for this host only.
    expect(h.instants).toEqual([
      {
        query: caughtCountQuery("candidate-a", [HOST], 300),
        atNs: `${Date.parse(WINDOW.end)}000000`,
        signal: expect.any(AbortSignal),
      },
    ]);
    // Exactly one event, a number.
    expect(h.events).toEqual([
      expect.objectContaining({
        event: "edge_caught_window",
        env: "candidate-a",
        scope: "host",
        host: HOST,
        windowSeconds: 300,
        outcome: "number",
        caught: 3,
        reason: "none",
      }),
    ]);
  });

  it("uses the asked window in the count query (1 h and 24 h)", async () => {
    for (const windowSeconds of [3600, 86400]) {
      const h = harness({ probeLineOnPoll: 1, vector: vec(1) });
      await compute(h, { env: "candidate-a", host: HOST, windowSeconds });
      expect(h.instants[0]?.query).toContain(`[${windowSeconds}s]`);
      expect(h.events[0]).toMatchObject({ windowSeconds });
    }
  });

  it("reads a proven 0 on an empty vector once the pipeline is proven", async () => {
    const h = harness({ probeLineOnPoll: 1, vector: [] });
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
    expect(h.instants).toHaveLength(0);
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
    const h = harness({ vector: vec(0) });
    const s = await compute(h);
    expectUnknown(s, "source_failed");
    expect(s.evidenceRefs).toContain("edge:unknown=canary_log_missing");
    // Three polls, no count query.
    expect(h.sleeps).toEqual([4000, 6000, 8000]);
    expect(h.queries).toHaveLength(3);
    expect(h.instants).toHaveLength(0);
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

  it("is unknown when the Loki instant query fails, and logs one event", async () => {
    const h = harness({ probeLineOnPoll: 1, loki: "instant-throws" });
    expectUnknown(await compute(h), "source_failed");
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.reason).toBe("source_error");
  });

  it("is unknown when the probe-line read fails", async () => {
    const h = harness({ loki: "range-throws" });
    expectUnknown(await compute(h), "source_failed");
    expect(h.events[0]?.reason).toBe("source_error");
  });

  it("is unknown when the vector holds an invalid sample", async () => {
    const h = harness({ probeLineOnPoll: 1, vector: vec(Number.NaN) });
    const s = await compute(h);
    expectUnknown(s, "incomplete_or_invalid_source");
    expect(h.events[0]?.reason).toBe("count_invalid");
  });
});

describe("edge.caught@1 env-wide (no host)", () => {
  const envWide = { env: "candidate-a", windowSeconds: 86400 };

  it("probes only the operator's own env host and counts every roster application host over the window", async () => {
    const h = harness({ probeLineOnPoll: 1, vector: vec(11) });
    const s = await compute(h, envWide);
    expect(s).toMatchObject({ value: 11, complete: true });
    expect(s.evidenceRefs).toContain("edge:scope=env");
    expect(s.evidenceRefs).toContain("edge:window_s=86400");
    // One canary, on the operator's own host, not on each host.
    expect(h.probes).toEqual([
      { host: DOMAIN, path: `${EDGE_CANARY_PATH}?probe=${NONCE}` },
    ]);
    // The count covers the roster application hosts, in one instant query: no mesh host can be in it.
    expect(h.instants).toHaveLength(1);
    expect(h.instants[0]?.query).toBe(
      caughtCountQuery(
        "candidate-a",
        edgeApplicationHosts(DOMAIN, NODES),
        86400
      )
    );
    expect(h.instants[0]?.query).toContain("[86400s]");
    expect(h.instants[0]?.query).not.toContain("mesh");
    expect(h.events).toEqual([
      expect.objectContaining({
        scope: "env",
        host: DOMAIN,
        windowSeconds: 86400,
        outcome: "number",
        caught: 11,
      }),
    ]);
  });

  it("reads a proven 0 on an empty vector", async () => {
    const h = harness({ probeLineOnPoll: 1, vector: [] });
    expect(await compute(h, envWide)).toMatchObject({
      value: 0,
      complete: true,
    });
  });

  it("is unknown when the env host's canary fails", async () => {
    const h = harness({
      probe: { kind: "response", status: 502, body: "" },
      probeLineOnPoll: 1,
      vector: vec(0),
    });
    const s = await compute(h, envWide);
    expectUnknown(s, "source_failed");
    expect(s.evidenceRefs).toContain("edge:unknown=canary_status");
    expect(h.instants).toHaveLength(0);
  });

  it("is unknown when the env host's own probe line never reaches Loki", async () => {
    const h = harness({ vector: vec(0) });
    expectUnknown(await compute(h, envWide), "source_failed");
    expect(h.events[0]?.reason).toBe("canary_log_missing");
    expect(h.instants).toHaveLength(0);
  });

  it("is unknown when the Loki instant query fails", async () => {
    const h = harness({ probeLineOnPoll: 1, loki: "instant-throws" });
    expectUnknown(await compute(h, envWide), "source_failed");
    expect(h.events[0]?.reason).toBe("source_error");
  });

  it("is unknown when the roster has no env host to probe, or the operator has no env domain", async () => {
    const noPrimary = harness({
      probeLineOnPoll: 1,
      nodes: [{ slug: "poly", primary: false }],
    });
    expectUnknown(
      await compute(noPrimary, envWide),
      "incomplete_or_invalid_source"
    );
    expect(noPrimary.events[0]?.reason).toBe("unprobed_host");
    expect(noPrimary.probes).toHaveLength(0);

    const noDomain = harness({ domain: undefined });
    expectUnknown(
      await compute(noDomain, envWide),
      "incomplete_or_invalid_source"
    );
    expect(noDomain.events[0]?.reason).toBe("env_not_served");
  });

  it("does not need any other host's canary: a dead app host does not make the env count unknown", async () => {
    const h = harness({
      probeLineOnPoll: 1,
      vector: vec(5),
      probeByHost: { [POLY]: { kind: "response", status: 404, body: "" } },
    });
    expect(await compute(h, envWide)).toMatchObject({
      value: 5,
      complete: true,
    });
  });
});

describe("edge.caught@1 shared rules", () => {
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
