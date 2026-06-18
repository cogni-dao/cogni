// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/scheduled-jobs/registry` (tests)
 * Purpose: Pin the `defineScheduledJob` registry contract — id validation, unique-id
 *   guard, lookup, and Deps-bound invocation via runScheduledJob.
 * Scope: Pure unit tests. No I/O.
 * Side-effects: none (resets the registry between cases).
 * Links: ./registry
 * @public
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetScheduledJobRegistryForTest,
  defineScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  runScheduledJob,
} from "./registry";
import type { ScheduledJobContext } from "./types";

const noop = async () => {};

function ctx<Deps>(deps: Deps): ScheduledJobContext<Deps> {
  return {
    jobId: "t",
    nodeId: "node",
    scheduledFor: null,
    idempotencyKey: null,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    deps,
  };
}

afterEach(() => {
  __resetScheduledJobRegistryForTest();
});

describe("defineScheduledJob", () => {
  it("registers a job and returns the frozen definition", () => {
    const def = defineScheduledJob({ id: "a", cron: "* * * * *", run: noop });
    expect(def.id).toBe("a");
    expect(Object.isFrozen(def)).toBe(true);
    expect(getScheduledJob("a")).toBe(def);
    expect(listScheduledJobs()).toHaveLength(1);
  });

  it("rejects ids that are not route-safe", () => {
    for (const bad of [
      "A",
      "with space",
      "with/slash",
      "../x",
      "x.y",
      "-lead",
    ]) {
      expect(() =>
        defineScheduledJob({ id: bad, cron: "* * * * *", run: noop })
      ).toThrow(/invalid id/);
    }
  });

  it("accepts lowercase-dash ids", () => {
    expect(() =>
      defineScheduledJob({ id: "metrics-ingest", cron: "* * * * *", run: noop })
    ).not.toThrow();
  });

  it("rejects duplicate ids", () => {
    defineScheduledJob({ id: "dup", cron: "* * * * *", run: noop });
    expect(() =>
      defineScheduledJob({ id: "dup", cron: "0 0 * * *", run: noop })
    ).toThrow(/duplicate job id/);
  });

  it("getScheduledJob returns undefined for unknown id", () => {
    expect(getScheduledJob("nope")).toBeUndefined();
  });
});

describe("runScheduledJob", () => {
  it("invokes run with the supplied Deps-bound context", async () => {
    const run = vi.fn(async (c: ScheduledJobContext<{ n: number }>) => {
      expect(c.deps.n).toBe(7);
    });
    defineScheduledJob<{ n: number }>({ id: "r", cron: "* * * * *", run });
    await runScheduledJob<{ n: number }>("r", ctx({ n: 7 }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("throws for an unregistered id", async () => {
    await expect(runScheduledJob("missing", ctx(null))).rejects.toThrow(
      /no job registered/
    );
  });
});
