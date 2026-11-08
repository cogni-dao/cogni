// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/fleet-observation-reader.adapter.int`
 * Purpose: Prove the raw SQL of `FleetObservationReader` (task.5457) on real PostgreSQL, over observations
 *   written by the published `@cogni-dao/metrics` 0.4.0 adapter itself (`reserve` then `complete`), so the
 *   rows have the package's real table shape, not a hand-built one.
 * Scope: Actual migrated `metric_observations`, the package's own writer and the reader; no production.
 * Invariants: Only `ok`, scheduled, in-window lanes-down readings of the asked env and `output: "down"`, in
 *   this node + environment scope, reach the caller. An on-demand (off-grid) compute is ignored.
 * Side-effects: IO (testcontainers PostgreSQL only)
 * Links: src/adapters/server/node-deploy/fleet-observation-reader.adapter.ts, task.5457
 * @internal
 */

import { randomUUID } from "node:crypto";
import { PostgresMetricObservations } from "@cogni-dao/metrics/adapters/postgres";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { describe, expect, it } from "vitest";
import { FleetObservationReader } from "@/adapters/server/node-deploy/fleet-observation-reader.adapter";

const MIN = 60_000;
const T0 = Date.parse("2026-11-07T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const EVIDENCE = (down: number) => `fleet:declared=7,probed=7,down=${down}`;

interface Seed {
  readonly evaluationAt: number;
  /** Undefined = an on-demand compute (no refresh slot). */
  readonly scheduledFor: number | undefined;
  readonly status?: "ok" | "unavailable";
  readonly env?: string;
  readonly output?: string;
  readonly calculator?: string;
  readonly cadenceSeconds?: number;
  readonly evidence?: string[];
}

/** Write one observation through the package's own adapter, then complete it. */
async function seed(
  node: string,
  environment: string,
  n: Seed
): Promise<string> {
  const observations = new PostgresMetricObservations(getSeedDb().$client, {
    node,
    environment,
    dataScope: "node-members",
  });
  const calculator = n.calculator ?? "fleet.lanes-down@1";
  const metricId = `fleet-lanes-down-${n.env ?? "production"}`;
  const definition = {
    id: metricId,
    title: "Fleet lanes down",
    revision: "1",
    spec: {
      calculatorId: calculator,
      params: { env: n.env ?? "production", output: n.output ?? "down" },
      ...(n.cadenceSeconds === undefined
        ? {}
        : { cadenceSeconds: n.cadenceSeconds }),
      maxAgeSeconds: 600,
    },
  };
  const id = randomUUID();
  const initial = {
    id,
    metricId,
    definitionRevision: "1",
    definitionHash: `hash-${n.output ?? "down"}-${n.env ?? "production"}`,
    calculatorVersion: calculator,
    paramsHash: "p",
    node,
    environment,
    dataScope: "node-members",
    window: { start: iso(n.evaluationAt), end: iso(n.evaluationAt) },
    ...(n.scheduledFor === undefined
      ? {}
      : { scheduledFor: iso(n.scheduledFor) }),
    sourceWatermarks: [],
    observedAt: null,
    status: "pending" as const,
    value: null,
    unit: "lanes",
    reason: null,
    evidenceRefs: [],
  };
  const reserved = await observations.reserve({
    requestKey: `seed/${id}`,
    requestHash: "h",
    snapshot: { definition, observation: initial },
    leaseMs: 60_000,
  });
  if (!reserved.leaseToken) throw new Error("seed: lease not granted");
  const status = n.status ?? "ok";
  const saved = await observations.complete(id, reserved.leaseToken, {
    ...initial,
    status,
    value: status === "ok" ? 0 : null,
    sourceWatermarks: [{ source: "http_probe", asOf: iso(n.evaluationAt) }],
    observedAt: iso(n.evaluationAt),
    reason: status === "ok" ? null : "source_failed",
    evidenceRefs: n.evidence ?? ["scope:env=production", EVIDENCE(1)],
  });
  if (!saved) throw new Error("seed: complete lost its lease");
  return id;
}

const read = (
  node: string,
  environment: string,
  over: Partial<{ env: string; from: number; to: number; maxRows: number }> = {}
) =>
  new FleetObservationReader(
    getSeedDb().$client,
    `${node}/${environment}/`
  ).lanesDown({
    env: over.env ?? "production",
    from: new Date(over.from ?? T0),
    to: new Date(over.to ?? T0 + 60 * MIN),
    maxRows: over.maxRows ?? 100,
    signal: new AbortController().signal,
  });

describe("FleetObservationReader on the package's real observation table", () => {
  it("returns only ok, scheduled, in-window lanes-down readings for the env, oldest first", async () => {
    const node = randomUUID();
    const wanted = await seed(node, "production", {
      evaluationAt: T0 + 10 * MIN,
      scheduledFor: T0 + 10 * MIN,
      cadenceSeconds: 300,
    });
    const wantedLater = await seed(node, "production", {
      evaluationAt: T0 + 20 * MIN,
      scheduledFor: T0 + 20 * MIN,
      evidence: ["scope:env=production", EVIDENCE(6)],
    });
    // Ignored: an on-demand compute (no refresh slot) at an off-grid instant.
    await seed(node, "production", {
      evaluationAt: T0 + 12 * MIN + 17_000,
      scheduledFor: undefined,
      evidence: ["scope:env=production", EVIDENCE(7)],
    });
    // Ignored: not an ok reading.
    await seed(node, "production", {
      evaluationAt: T0 + 30 * MIN,
      scheduledFor: T0 + 30 * MIN,
      status: "unavailable",
    });
    // Ignored: another env, another output, another calculator.
    await seed(node, "production", {
      evaluationAt: T0 + 31 * MIN,
      scheduledFor: T0 + 31 * MIN,
      env: "preview",
    });
    await seed(node, "production", {
      evaluationAt: T0 + 32 * MIN,
      scheduledFor: T0 + 32 * MIN,
      output: "probed",
    });
    await seed(node, "production", {
      evaluationAt: T0 + 33 * MIN,
      scheduledFor: T0 + 33 * MIN,
      calculator: "fleet.substrate-reach@1",
    });
    // Ignored: another environment's scope of the same node.
    await seed(node, "preview", {
      evaluationAt: T0 + 34 * MIN,
      scheduledFor: T0 + 34 * MIN,
    });
    // Ignored: another node.
    await seed(randomUUID(), "production", {
      evaluationAt: T0 + 35 * MIN,
      scheduledFor: T0 + 35 * MIN,
    });
    // Ignored: outside the half-open window [T0, T0 + 60 min): before it, and exactly at its end.
    await seed(node, "production", {
      evaluationAt: T0 - MIN,
      scheduledFor: T0 - MIN,
    });
    await seed(node, "production", {
      evaluationAt: T0 + 60 * MIN,
      scheduledFor: T0 + 60 * MIN,
    });
    // Ignored: no `fleet:declared=` evidence line to integrate.
    await seed(node, "production", {
      evaluationAt: T0 + 36 * MIN,
      scheduledFor: T0 + 36 * MIN,
      evidence: ["scope:env=production"],
    });

    const r = await read(node, "production");
    expect(r.truncated).toBe(false);
    expect(r.rows.map((x) => x.observationId)).toEqual([wanted, wantedLater]);
    expect(r.rows[0]).toMatchObject({
      evidence: EVIDENCE(1),
      cadenceSeconds: 300,
    });
    expect(r.rows[0]?.at).toEqual(new Date(T0 + 10 * MIN));
    expect(r.rows[0]?.scheduledFor).toEqual(new Date(T0 + 10 * MIN));
    expect(r.rows[1]).toMatchObject({
      evidence: EVIDENCE(6),
      cadenceSeconds: undefined,
    });
  });

  it("reports truncation instead of dropping rows past maxRows", async () => {
    const node = randomUUID();
    for (let i = 1; i <= 3; i++)
      await seed(node, "production", {
        evaluationAt: T0 + i * 5 * MIN,
        scheduledFor: T0 + i * 5 * MIN,
      });
    const r = await read(node, "production", { maxRows: 2 });
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(2);
  });
});
