// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/deploy/delivery-kpi-source.shas`
 * Purpose: Pin that `DeliveryScope.sourceShas` reaches the release read as a SQL `source_sha IN (...)` filter, with
 *   the shas as parameters and the node/env clauses unchanged, and that a read without it has no such clause
 *   (task.5498: served-ness of a head is looked up by sha, not by a time window).
 * Scope: The real `DeliveryKpiSource` over a fake tagged-template `Sql` that renders each query to text and
 *   positional parameters. No database.
 * Side-effects: none
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { DeliveryKpiSource } from "@/adapters/server/node-deploy/delivery-kpi-source.adapter";

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
      if (i >= f.values.length) return acc + s;
      const v = f.values[i];
      if (isFragment(v)) return acc + s + render(v, params);
      if (Array.isArray(v)) {
        // postgres.js `sql(array)` in an IN list: one parameter per element
        const slots = v.map((x) => {
          params.push(x);
          return `$${params.length}`;
        });
        return `${acc}${s}(${slots.join(", ")})`;
      }
      params.push(v);
      return `${acc}${s}$${params.length}`;
    }, "");
  const sql = (strings: readonly string[], ...values: unknown[]) => {
    // `sql(array)` (a list helper, not a template call) is the array itself
    if (!("raw" in strings)) return strings;
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

const read = (scope: Record<string, unknown>) => ({
  recordedFrom: new Date(0),
  to: new Date(1),
  scope,
  maxRows: 10,
  signal: new AbortController().signal,
});
const squash = (t: string) => t.replace(/\s+/g, " ");
const A = "a".repeat(40);
const B = "b".repeat(40);

describe("delivery KPI source: sourceShas scope", () => {
  it("adds `r.source_sha IN (...)` with the shas as parameters, after the node and env clauses", async () => {
    const { sql, queries } = fakeSql();
    await new DeliveryKpiSource(sql).releases(
      read({ nodeId: "n1", env: "candidate-a", sourceShas: [A, B] })
    );
    const q = queries[0];
    expect(squash(q?.text ?? "")).toMatch(
      /AND r\.node_id = \$\d+ AND r\.env = \$\d+ AND r\.source_sha IN \(\$\d+, \$\d+\)/
    );
    expect(q?.params).toEqual(
      expect.arrayContaining(["n1", "candidate-a", A, B])
    );
  });

  it("adds no sha clause without sourceShas or with an empty list", async () => {
    const { sql, queries } = fakeSql();
    const src = new DeliveryKpiSource(sql);
    await src.releases(read({ nodeId: "n1", env: "candidate-a" }));
    await src.releases(read({ nodeId: "n1", sourceShas: [] }));
    for (const q of queries)
      expect(squash(q.text)).not.toMatch(/source_sha IN/);
  });

  it("a lane read ignores sourceShas", async () => {
    const { sql, queries } = fakeSql();
    await new DeliveryKpiSource(sql).servingLanes({
      scope: { env: "candidate-a", sourceShas: [A] },
      maxRows: 10,
      signal: new AbortController().signal,
    });
    expect(squash(queries[0]?.text ?? "")).not.toMatch(/source_sha IN/);
  });
});
