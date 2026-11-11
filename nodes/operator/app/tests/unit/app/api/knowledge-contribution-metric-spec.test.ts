// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/knowledge-contribution-metric-spec`
 * Purpose: a contribution that inserts a metric row may carry `serves` and `band` beside the spec
 *   (story.0033); a malformed one is a clear 4xx, never a 422 from the strict core spec.
 * Scope: handleCreate with a mocked container and a real MetricRegistry. No Doltgres.
 * Invariants: ANNEX_NOT_CORE.
 * Side-effects: none
 * Links: src/app/api/v1/knowledge/contributions/_handlers.ts, story.0033
 * @internal
 */

import { MetricRegistry } from "@cogni-dao/metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const create = vi.fn();
const registry = new MetricRegistry();
registry.register({
  id: "work.count@1",
  unit: "items",
  paramsSchema: z.strictObject({ mode: z.enum(["open", "validated"]) }),
  budget: {
    timeoutMs: 1000,
    maxSourceCalls: 1,
    maxRows: 1,
    maxResponseBytes: 1000,
  },
  compute: async () => {
    throw new Error("not computed");
  },
});
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    knowledgeContributionService: { create },
    goalMetrics: { registry },
    log: { warn: vi.fn() },
  }),
}));

import { handleCreate } from "@/app/api/v1/knowledge/contributions/_handlers";

const session = {
  id: "user-1",
  walletAddress: "0x070075F1389Ae1182aBac722B36CA12285d0c949",
  displayName: null,
} as never;
const spec = {
  calculatorId: "work.count@1",
  params: { mode: "open" },
  maxAgeSeconds: 7200,
};
const post = (metricSpec: unknown) =>
  handleCreate(
    new Request("http://x/api/v1/knowledge/contributions", {
      method: "POST",
      body: JSON.stringify({
        message: "add metric",
        edits: [
          {
            op: "insert",
            entry: {
              id: "open-work",
              domain: "strategy",
              title: "Open work",
              content: "A metric.",
              entryType: "metric",
              metricSpec,
            },
          },
        ],
      }),
    }),
    session
  );

describe("handleCreate metric spec with serves + band (story.0033)", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ contributionId: "c1" });
  });

  it("accepts a metric row carrying serves and band", async () => {
    const res = await post({
      ...spec,
      serves: { kpi: "deploy-first-try-7d", role: "diagnostic" },
      band: {
        comparator: "lte",
        target: { value: 10, unit: "items" },
        breach: "failing",
      },
    });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a malformed band",
      { band: { comparator: "gte", target: { value: "x", unit: "items" } } },
    ],
    [
      "a band that names a metricId",
      {
        band: {
          comparator: "gte",
          target: { value: 1, unit: "items" },
          metricId: "x",
        },
      },
    ],
    ["a role outside the enum", { serves: { kpi: "k", role: "driver" } }],
  ])("rejects %s with a 400 naming the issue", async (_n, extra) => {
    const res = await post({ ...spec, ...extra });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid metric definition");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a band whose unit does not match the metric with a 422", async () => {
    const res = await post({
      ...spec,
      band: { comparator: "gte", target: { value: 1, unit: "%" } },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("unit");
  });

  it("still rejects an unknown calculator with a 422", async () => {
    const res = await post({ ...spec, calculatorId: "nope@1" });
    expect(res.status).toBe(422);
  });
});
