// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/deploy/delivery-kpi-source.testenvs`
 * Purpose: Pin the source SQL of the delivery KPIs against test envs (story.5159): every read that backs a v1
 *   KPI (releases for first-try / success / lead time and the lane lists behind serving drift and
 *   `fleet.lanes-down`) excludes test-env workloads by default, under BOTH table aliases; `only` selects them;
 *   `include` adds no clause; and the node / env clauses are unchanged.
 * Scope: The real `DeliveryKpiSource` over a fake tagged-template `Sql` that renders each query to text and
 *   positional parameters. No database.
 * Side-effects: none
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { DeliveryKpiSource } from "@/adapters/server/node-deploy/delivery-kpi-source.adapter";
import { TEST_ENV_KEY_PATTERN } from "@/ports";

interface Fragment {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}
const isFragment = (v: unknown): v is Fragment =>
  typeof v === "object" && v !== null && "strings" in v && "values" in v;

/** A tagged-template stand-in for postgres.js: records the rendered text and parameters of each awaited query. */
function fakeSql() {
  const queries: { text: string; params: unknown[] }[] = [];
  const render = (f: Fragment, params: unknown[]): string =>
    f.strings.reduce((acc, s, i) => {
      const v = f.values[i];
      if (i >= f.values.length) return acc + s;
      if (isFragment(v)) return acc + s + render(v, params);
      params.push(v);
      return `${acc}${s}$${params.length}`;
    }, "");
  const sql = (strings: readonly string[], ...values: unknown[]) => {
    const fragment: Fragment & {
      then: PromiseLike<unknown[]>["then"];
      cancel: () => void;
    } = {
      strings,
      values,
      cancel() {},
      // biome-ignore lint/suspicious/noThenProperty: a postgres.js query is a thenable
      then(onFulfilled, onRejected) {
        const params: unknown[] = [];
        queries.push({ text: render(fragment, params), params });
        return Promise.resolve([] as unknown[]).then(onFulfilled, onRejected);
      },
    };
    return fragment;
  };
  return { sql: sql as unknown as Sql, queries };
}

const args = (scope: Record<string, unknown>) => ({
  recordedFrom: new Date(0),
  to: new Date(1),
  scope,
  maxRows: 10,
  signal: new AbortController().signal,
});
const squash = (t: string) => t.replace(/\s+/g, " ");

describe("delivery KPI source: test envs", () => {
  it("releases(): excludes te workloads by default, under alias r, with the key pattern as a parameter", async () => {
    const { sql, queries } = fakeSql();
    await new DeliveryKpiSource(sql).releases(args({ env: "candidate-a" }));
    const q = queries[0];
    expect(squash(q?.text ?? "")).toMatch(
      /AND r\.env = \$\d+ AND r\.workload !~ \$\d+/
    );
    expect(q?.params).toContain(TEST_ENV_KEY_PATTERN);
    expect(q?.params).toContain("candidate-a");
  });

  it("servingLanes(): excludes te workloads by default, under alias d (drift, lanes-down)", async () => {
    const { sql, queries } = fakeSql();
    await new DeliveryKpiSource(sql).servingLanes({
      scope: { env: "candidate-a" },
      maxRows: 10,
      signal: new AbortController().signal,
    });
    const q = queries[0];
    expect(squash(q?.text ?? "")).toMatch(
      /AND d\.env = \$\d+ AND d\.workload !~ \$\d+/
    );
    expect(q?.params).toContain(TEST_ENV_KEY_PATTERN);
  });

  it("an unscoped read (no node, no env) still excludes te workloads", async () => {
    const { sql, queries } = fakeSql();
    await new DeliveryKpiSource(sql).releases(args({}));
    expect(squash(queries[0]?.text ?? "")).toMatch(/r\.workload !~ \$\d+/);
  });

  it('"only" selects te workloads (positive match) under both aliases', async () => {
    const { sql, queries } = fakeSql();
    const src = new DeliveryKpiSource(sql);
    await src.releases(args({ env: "candidate-a", testEnvs: "only" }));
    await src.servingLanes({
      scope: { env: "candidate-a", testEnvs: "only" },
      maxRows: 10,
      signal: new AbortController().signal,
    });
    const [r, d] = queries.map((q) => squash(q.text));
    expect(r).toMatch(/r\.workload ~ \$\d+/);
    expect(r).not.toMatch(/r\.workload !~/);
    expect(d).toMatch(/d\.workload ~ \$\d+/);
    expect(d).not.toMatch(/d\.workload !~/);
  });

  it('"include" adds no workload clause', async () => {
    const { sql, queries } = fakeSql();
    const src = new DeliveryKpiSource(sql);
    await src.releases(args({ env: "candidate-a", testEnvs: "include" }));
    await src.servingLanes({
      scope: { testEnvs: "include" },
      maxRows: 10,
      signal: new AbortController().signal,
    });
    for (const q of queries) {
      expect(squash(q.text)).not.toMatch(/workload !?~/);
      expect(q.params).not.toContain(TEST_ENV_KEY_PATTERN);
    }
  });

  it("the key pattern is exactly the TS key shape", () => {
    const re = new RegExp(TEST_ENV_KEY_PATTERN);
    expect(re.test("teqwkzmx")).toBe(true);
    for (const w of [
      "app",
      "canary",
      "te-qwkzmx",
      "teqwkzm",
      "tequwkzmx",
      "teqwkz1x",
    ])
      expect(re.test(w), w).toBe(false);
  });
});
