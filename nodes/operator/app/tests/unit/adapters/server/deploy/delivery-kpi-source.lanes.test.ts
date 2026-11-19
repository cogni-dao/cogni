// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/deploy/delivery-kpi-source.lanes`
 * Purpose: Pin that `servingLanes({ nodeAppsOnly: true })` leaves out `worker` releases (bug.5641: a worker gets no
 *   METRICS_TOKEN and serves no `/api/metrics`, so scraping it would read `up = 0` for ever), and that a read without
 *   the flag keeps every lane (the fleet KPIs probe workers too).
 * Scope: The real `DeliveryKpiSource` over a fake tagged-template `Sql` that renders each query to text. No database.
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

const squash = (t: string) => t.replace(/\s+/g, " ");
const WORKER_CLAUSE =
  "AND dr.spec ->> 'runtimeProfile' IS DISTINCT FROM 'worker'";

const lanes = (nodeAppsOnly?: boolean) => ({
  scope: {},
  maxRows: 10,
  signal: new AbortController().signal,
  ...(nodeAppsOnly === undefined ? {} : { nodeAppsOnly }),
});

describe("delivery KPI source: servingLanes nodeAppsOnly", () => {
  it("leaves out worker releases when asked for node apps only", async () => {
    const { sql, queries } = fakeSql();
    await new DeliveryKpiSource(sql).servingLanes(lanes(true));
    expect(squash(queries[0]?.text ?? "")).toContain(WORKER_CLAUSE);
  });

  it("keeps every lane by default", async () => {
    const { sql, queries } = fakeSql();
    await new DeliveryKpiSource(sql).servingLanes(lanes());
    await new DeliveryKpiSource(sql).servingLanes(lanes(false));
    for (const q of queries)
      expect(squash(q.text)).not.toContain("runtimeProfile");
  });
});
