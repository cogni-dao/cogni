// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { parser } from "@prometheus-io/lezer-promql";
import { describe, expect, it } from "vitest";

import { deriveLeaseMetricsToken } from "./lease-metrics";
import {
  authenticateNodeMetricsRead,
  everySelectorScoped,
  MAX_QUERY_CHARS,
  MAX_RANGE_SECONDS,
  MAX_SELECTORS,
  parseNodeBasicAuth,
  pickReadParams,
  scopePromQuery,
} from "./lease-metrics-read";

const ROOT = "r".repeat(40);
const NODE = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const OTHER = "4b06359a-0000-4000-8000-000000000001";
const scope = { nodeId: NODE, env: "candidate-a" };
const M = `node="${NODE}",env="candidate-a"`;

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

const scoped = (query: string): string => {
  const r = scopePromQuery(query, scope);
  if (!r.ok) throw new Error(`refused: ${r.reason} for ${query}`);
  return r.query;
};

describe("scopePromQuery: exact rewrites", () => {
  it.each([
    ["foo", `foo{${M}}`],
    ["foo{}", `foo{${M}}`],
    ["foo{ }", `foo{ ${M}}`],
    ['foo{a="b"}', `foo{a="b",${M}}`],
    ['foo{a="b",}', `foo{a="b",${M}}`],
    ['foo{a=~"x.*",b!="y"}', `foo{a=~"x.*",b!="y",${M}}`],
    ['{__name__=~"http_.+"}', `{__name__=~"http_.+",${M}}`],
    // The grammar accepts a bare `{}`; Prometheus refuses it. The scoped output is a valid selector either way.
    ["{}", `{${M}}`],
    ['{"foo"}', `{"foo",${M}}`],
    ['foo{"a"="b"}', `foo{"a"="b",${M}}`],
    ["foo[5m]", `foo{${M}}[5m]`],
    ["rate(foo[5m])", `rate(foo{${M}}[5m])`],
    ["foo offset 5m @ 100", `foo{${M}} offset 5m @ 100`],
    ["foo @ end()", `foo{${M}} @ end()`],
    ["-foo", `-foo{${M}}`],
    ["(foo)", `(foo{${M}})`],
  ] as const)("%s", (query, expected) => {
    expect(scoped(query)).toBe(expected);
  });

  it("makes a caller-written node or env matcher an AND that cannot widen", () => {
    expect(scoped(`foo{node="${OTHER}"}`)).toBe(`foo{node="${OTHER}",${M}}`);
    expect(scoped('foo{env=~".+",node=~".*"}')).toBe(
      `foo{env=~".+",node=~".*",${M}}`
    );
    expect(scoped(`{node!="${NODE}"}`)).toBe(`{node!="${NODE}",${M}}`);
  });

  it("keeps tabs and newlines between tokens", () => {
    expect(scoped('foo{a="b",\n\tc="d"}\n or\tbar')).toBe(
      `foo{a="b",\n\tc="d",${M}}\n or\tbar{${M}}`
    );
  });

  it("does not touch text that only looks like a selector", () => {
    expect(scoped('label_replace(foo, "bar", "baz{x=\\"y\\"}", "", "")')).toBe(
      `label_replace(foo{${M}}, "bar", "baz{x=\\"y\\"}", "", "")`
    );
  });
});

describe("scopePromQuery: operators and functions", () => {
  it.each([
    ["foo or bar", 2],
    ["foo and bar unless baz", 3],
    ["foo and on(a) bar", 2],
    ["foo / ignoring(a) group_left bar", 2],
    ['label_replace(foo, "a", "$1", "b", "(.*)")', 1],
    ['label_join(foo, "a", ",", "b", "c")', 1],
    ["max_over_time(foo[5m:1m])", 1],
    ["max_over_time(rate(foo[1m])[10m:30s] offset 1h)", 1],
    ["count by (node) (foo)", 1],
    ["sum without (node) (rate(foo[5m]))", 1],
    ["absent(foo)", 1],
    ["absent_over_time(foo[5m])", 1],
    ["sum(count by (a) (foo)) / sum(count by (a) (bar))", 2],
    ["topk(3, sum by (a) (rate(foo[5m])))", 1],
    ["histogram_quantile(0.9, sum by (le) (rate(h_bucket[5m])))", 1],
    ["foo > bool on() bar", 2],
    ["vector(1) or foo", 1],
    ["sum(foo) + sum(bar) * 2", 2],
    ['foo and {a="b"}', 2],
    ["quantile(0.5, foo) by (x)", 1],
    ['count_values("v", foo)', 1],
    ["clamp_min(foo, 0) - clamp_max(bar, 1)", 2],
    ["timestamp(foo)", 1],
  ] as const)("%s", (query, selectors) => {
    const r = scopePromQuery(query, scope);
    expect(r).toMatchObject({ ok: true, selectors });
    if (r.ok) expect(everySelectorScoped(r.query, scope)).toBe(true);
  });

  it("allows queries that read no series", () => {
    for (const q of [
      "vector(1)",
      "time()",
      "1+1",
      '"a string"',
      "scalar(vector(3))",
      "pi()",
    ]) {
      expect(scopePromQuery(q, scope)).toEqual({
        ok: true,
        query: q,
        selectors: 0,
      });
    }
  });
});

describe("scopePromQuery: refusals", () => {
  it.each([
    ["", "empty"],
    ["   \n", "empty"],
    ["foo{", "syntax"],
    ["foo bar", "syntax"],
    ["sum(", "syntax"],
    ["!!!", "syntax"],
    ['foo{a="b}', "syntax"],
    ["rate(foo[5m)", "syntax"],
    ["info(foo)", "unsupported_function"],
    ['info(foo, {a="b"})', "unsupported_function"],
  ] as const)("%j is %s", (query, reason) => {
    expect(scopePromQuery(query, scope)).toEqual({ ok: false, reason });
  });

  // The grammar ends a `#` comment at `\n` only; Prometheus also ends it at `\r`. `foo #\r or foo` is ONE selector to the
  // grammar and TWO to Prometheus, so a comment (or any control character) must never reach the upstream.
  it.each([
    "foo #\r or foo",
    'foo # x\r or {__name__=~".+"}',
    "foo # a comment\n",
    "foo # }\n",
    'foo{a="b" # }\n}',
    "foo{# c\n}",
    "foo\r",
    "foo\r\nor bar",
    "foo\u000b or bar",
    "foo\u000c or bar",
    "foo\u0000 or bar",
    "foo\u0007",
    "foo\u007f",
    "foo\u0085 or bar",
    "foo\u2028 or bar",
    "foo\u2029 or bar",
    "foo\u009f or bar",
  ])("refuses a comment or control character: %j", (query) => {
    expect(scopePromQuery(query, scope)).toEqual({
      ok: false,
      reason: "syntax",
    });
    expect(everySelectorScoped(`${query}`, scope)).toBe(false);
  });

  it("refuses a hidden second selector even when the first is already scoped", () => {
    expect(everySelectorScoped(`foo{${M}} #\r or foo`, scope)).toBe(false);
  });

  it("refuses a query over the length cap, valid or not", () => {
    expect(scopePromQuery("x".repeat(MAX_QUERY_CHARS + 1), scope)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("refuses more selectors than the bound", () => {
    const many = Array.from({ length: MAX_SELECTORS + 1 }, () => "a").join(
      " or "
    );
    expect(scopePromQuery(many, scope)).toEqual({
      ok: false,
      reason: "too_many_selectors",
    });
    const atBound = Array.from({ length: MAX_SELECTORS }, () => "a").join(
      " or "
    );
    expect(scopePromQuery(atBound, scope).ok).toBe(true);
  });

  it("accepts a query of exactly the length cap", () => {
    const pad = " ".repeat(MAX_QUERY_CHARS - "foo".length);
    expect(scopePromQuery(`foo${pad}`, scope).ok).toBe(true);
  });
});

describe("every selector in the OUTPUT tree carries both matchers", () => {
  const table = [
    "foo",
    "foo{}",
    'foo{node="x"}',
    'foo{node=~".*", env=~".*"}',
    '{__name__=~".+"}',
    '{node!=""}',
    'sum by (node, env) (rate({__name__=~"http_.+", node=~".+"}[5m]))',
    "foo or bar or baz",
    "foo unless on() bar",
    "foo and ignoring(node) bar",
    'label_replace(label_replace(foo, "node", "$1", "x", "(.*)"), "env", "p", "", "")',
    "max_over_time((foo or bar)[1h:1m])",
    "sum(max_over_time(rate(foo[1m])[1h:1m] offset 5m @ start()))",
    'absent(nonexistent{job="x"})',
    "count(count by (node) (up))",
    "sum(sum(sum(sum(foo))))",
    "((((foo))))",
    "-(-(-foo))",
    "foo{a='single'}",
    "foo{a=`raw`}",
    'foo{a="x",\n b="y"}',
    "foo[5m:] offset -1m",
    "histogram_quantile(0.5, sum by (le) (foo_bucket)) > bool 0.1",
    "foo * on(node) group_left(env) bar",
    "(foo > 0) and (bar < 1) or (baz == 2)",
    '{"quoted.metric", "quoted.label"="v"}',
    "up == 1 and on() vector(1)",
    "scalar(foo) + scalar(bar)",
  ];

  it.each(table)("%s", (query) => {
    const out = scoped(query);
    // Walk the re-parsed OUTPUT tree independently of the implementation's own check.
    const tree = parser.parse(out);
    let selectors = 0;
    tree.iterate({
      enter(node) {
        if (node.type.isError) throw new Error(`error node in output: ${out}`);
        if (node.name !== "VectorSelector") return;
        selectors += 1;
        const text = out.slice(node.from, node.to);
        expect(text).toContain(`node="${NODE}"`);
        expect(text).toContain(`env="candidate-a"`);
      },
    });
    expect(selectors).toBeGreaterThan(0);
    // The input's selectors are all there, none added or lost.
    let before = 0;
    parser.parse(query).iterate({
      enter(node) {
        if (node.name === "VectorSelector") before += 1;
      },
    });
    expect(selectors).toBe(before);
  });

  it("everySelectorScoped rejects an unscoped or half-scoped query", () => {
    expect(everySelectorScoped("foo", scope)).toBe(false);
    expect(everySelectorScoped(`foo{node="${NODE}"}`, scope)).toBe(false);
    expect(everySelectorScoped(`foo{${M}} or bar`, scope)).toBe(false);
    expect(everySelectorScoped(`foo{${M}} or bar{${M}}`, scope)).toBe(true);
    expect(
      everySelectorScoped(`foo{node=~"${NODE}",env="candidate-a"}`, scope)
    ).toBe(false);
    expect(everySelectorScoped("foo{", scope)).toBe(false);
  });

  it("is idempotent in effect: scoping twice keeps every selector scoped", () => {
    const once = scoped("rate(foo[5m]) / bar");
    expect(everySelectorScoped(scoped(once), scope)).toBe(true);
  });
});

describe("authenticateNodeMetricsRead", () => {
  it("resolves the env whose derived token was presented", () => {
    for (const env of ["candidate-a", "preview", "production"] as const) {
      const token = deriveLeaseMetricsToken(ROOT, NODE, env);
      expect(authenticateNodeMetricsRead(basic(NODE, token), ROOT)).toEqual({
        nodeId: NODE,
        env,
      });
    }
  });

  it("refuses another node's token, another root, a non-flight env and junk", () => {
    const token = deriveLeaseMetricsToken(ROOT, NODE, "preview");
    expect(authenticateNodeMetricsRead(basic(OTHER, token), ROOT)).toBeNull();
    expect(
      authenticateNodeMetricsRead(basic(NODE, token), "x".repeat(40))
    ).toBeNull();
    expect(
      authenticateNodeMetricsRead(
        basic(NODE, deriveLeaseMetricsToken(ROOT, NODE, "staging")),
        ROOT
      )
    ).toBeNull();
    expect(authenticateNodeMetricsRead(null, ROOT)).toBeNull();
    expect(authenticateNodeMetricsRead(`Bearer ${token}`, ROOT)).toBeNull();
    expect(
      authenticateNodeMetricsRead(basic("not-a-uuid", token), ROOT)
    ).toBeNull();
    expect(authenticateNodeMetricsRead(basic(NODE, ""), ROOT)).toBeNull();
    expect(authenticateNodeMetricsRead("Basic !!!", ROOT)).toBeNull();
  });
});

describe("parseNodeBasicAuth", () => {
  it("parses case-insensitively, keeps a colon in the password, caps size", () => {
    expect(parseNodeBasicAuth(basic(NODE, "a:b"))).toEqual({
      nodeId: NODE,
      token: "a:b",
    });
    expect(parseNodeBasicAuth(`basic ${basic(NODE, "t").slice(6)}`)).toEqual({
      nodeId: NODE,
      token: "t",
    });
    expect(parseNodeBasicAuth(basic(NODE, "t".repeat(257)))).toBeNull();
    expect(parseNodeBasicAuth(`Basic ${"A".repeat(600)}`)).toBeNull();
    expect(
      parseNodeBasicAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`)
    ).toBeNull();
  });
});

describe("pickReadParams: range bounds", () => {
  const range = (start: string, end: string, step: string) =>
    pickReadParams(
      "query_range",
      new URLSearchParams({ query: "up", start, end, step })
    );

  it("accepts a bounded window in unix seconds, RFC 3339 or a duration step", () => {
    expect(range("1700000000", "1700003600", "15").ok).toBe(true);
    expect(range("1700000000", "1700003600", "15s").ok).toBe(true);
    expect(range("1700000000", "1700003600", "1m30s").ok).toBe(true);
    expect(
      range("2026-01-01T00:00:00Z", "2026-01-02T00:00:00.5Z", "1m").ok
    ).toBe(true);
    expect(range("0", String(MAX_RANGE_SECONDS), "60").ok).toBe(true);
  });

  it("refuses a window over 7 days, an inverted one, and more than 11000 points", () => {
    expect(range("0", String(MAX_RANGE_SECONDS + 1), "3600")).toMatchObject({
      ok: false,
      reason: "range longer than 7d",
    });
    expect(range("10", "5", "1")).toMatchObject({
      ok: false,
      reason: "end before start",
    });
    expect(range("0", "100000", "1")).toMatchObject({
      ok: false,
      reason: "too many points",
    });
    expect(range("0", "11000", "1").ok).toBe(true);
  });

  it("refuses a zero, negative or unparsable step and unparsable times", () => {
    for (const bad of ["0", "-5", "0s", "abc", "1x", ""])
      expect(range("0", "100", bad).ok).toBe(false);
    expect(range("yesterday", "100", "1").ok).toBe(false);
    expect(range("0", "2026-13-99", "1").ok).toBe(false);
  });
});

describe("pickReadParams", () => {
  it("forwards only the allowlisted parameters, first value each", () => {
    const r = pickReadParams(
      "query",
      new URLSearchParams(
        "query=up&query=down&time=1&timeout=5s&stats=all&lookback_delta=9h&start=1"
      )
    );
    expect(r.ok && Object.fromEntries(r.params)).toEqual({
      query: "up",
      time: "1",
      timeout: "5s",
    });
  });

  it("requires start, end and step for a range query", () => {
    expect(
      pickReadParams(
        "query_range",
        new URLSearchParams("query=up&start=1&end=2")
      )
    ).toEqual({ ok: false, reason: "missing required parameter step" });
    const ok = pickReadParams(
      "query_range",
      new URLSearchParams("query=up&start=1&end=2&step=15&extra=1")
    );
    expect(ok.ok && [...ok.params.keys()]).toEqual([
      "query",
      "start",
      "end",
      "step",
    ]);
  });

  it("refuses a missing query and an overlong value", () => {
    expect(pickReadParams("query", new URLSearchParams("time=1"))).toEqual({
      ok: false,
      reason: "missing required parameter query",
    });
    expect(
      pickReadParams(
        "query",
        new URLSearchParams(`query=up&time=${"1".repeat(65)}`)
      )
    ).toEqual({ ok: false, reason: "parameter time too long" });
  });
});
