// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/lane-view.test`
 * Purpose: Pin the lane view (task.5479) on a worked example of bug.5621: one candidate-a app lane where
 *   several validators' releases supersede each other before any of them serves. Expected values are
 *   counted from the fixture below by hand, not computed with the implementation.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import {
  DeployLanesReadSchema,
  DeployLaneViewSchema,
} from "@/contracts/deploy.workloads.v1.contract";
import type { AttemptRow, DeliveryReleaseFacts, ReleaseRow } from "@/ports";
import { buildLaneView } from "./lane-view";
import { canaryApp, NODE_ID } from "./testing";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const ago = (h: number, min = 0) =>
  new Date(NOW.getTime() - (h * 60 + min) * 60_000);

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const SHA = (c: string) => c.repeat(40);

const facts = (
  n: number,
  over: Partial<DeliveryReleaseFacts>
): DeliveryReleaseFacts => ({
  releaseId: ID(n),
  nodeId: NODE_ID,
  env: "candidate-a",
  workload: "app",
  sourceSha: SHA(String(n)),
  createdBy: `user:u${n}`,
  admissionRefusalReason: undefined,
  createdAt: NOW,
  activatedAt: undefined,
  activatedStepAt: undefined,
  served: false,
  parkedAt: undefined,
  parkStepSeen: false,
  current: false,
  firstActivatedAttempt: undefined,
  failedBeforeActivation: false,
  ...over,
});

const row = (n: number, createdAt: Date): ReleaseRow => ({
  id: ID(n),
  nodeId: NODE_ID,
  env: "candidate-a",
  workload: "app",
  sourceSha: SHA(String(n)),
  spec: canaryApp(),
  createdBy: `user:u${n}`,
  createdAt,
});

const attempt = (
  n: number,
  releaseId: string,
  phase: AttemptRow["phase"],
  extra: Partial<AttemptRow> = {}
): AttemptRow => ({
  id: `a-${n}`,
  releaseId,
  attempt: 1,
  cogniKey: `k-${n}`,
  externalName: undefined,
  provider: undefined,
  endpoints: [],
  phase,
  error: undefined,
  unhealthySince: undefined,
  createdAt: ago(1),
  leasedAt: undefined,
  updatedAt: ago(0, 30),
  steps: [],
  ...extra,
});

/**
 * Lane history (oldest first):
 *  1  recorded 10h ago by u1; first activated 6 min later (lead 360 000 ms); STILL SERVES (its attempt is active)
 *  2  recorded 5h ago by u2; replaced 4h50m ago by 3 before serving        -> superseded
 *  3  recorded 4h50m ago by u3; replaced 4h ago by 4 before serving         -> superseded (had a failed attempt)
 *  4  recorded 4h ago by u4; parked by the sequencer 3h ago                 -> parked
 *  5  recorded 2h ago by u5; deploying now (attempt in flight)              -> in flight, current
 * plus a release of ANOTHER workload ("db") that must be ignored.
 */
const releases: DeliveryReleaseFacts[] = [
  facts(1, {
    createdAt: ago(10),
    activatedAt: ago(9, 54),
    served: true,
    firstActivatedAttempt: 1,
  }),
  facts(2, { createdAt: ago(5) }),
  facts(3, { createdAt: ago(4, 50), failedBeforeActivation: true }),
  facts(4, { createdAt: ago(4), parkedAt: ago(3) }),
  facts(5, { createdAt: ago(2), current: true }),
  facts(6, { workload: "db", createdAt: ago(1), parkedAt: ago(0, 10) }),
];

const input = {
  now: NOW,
  desired: { workload: "app", state: "running", releaseId: ID(5) } as const,
  desiredRelease: row(5, ago(2)),
  attemptsNewestFirst: [
    attempt(5, ID(5), "proving", { createdAt: ago(1, 50) }),
    attempt(1, ID(1), "active", { activatedAt: ago(9, 54) }),
  ],
  servingRelease: row(1, ago(10)),
  releases,
};

describe("buildLaneView (bug.5621 worked example)", () => {
  const lane = buildLaneView(input);

  it("is schema-valid on the wire", () => {
    DeployLaneViewSchema.parse(lane);
    DeployLanesReadSchema.parse({
      nodeId: NODE_ID,
      env: "candidate-a",
      asOf: NOW.toISOString(),
      truncated: false,
      lanes: [lane],
    });
  });

  it("serving: the older release whose attempt still holds the lease", () => {
    expect(lane.serving).toEqual({
      releaseId: ID(1),
      sourceSha: SHA("1"),
      sha8: "11111111",
      requestedBy: "user:u1",
      servingSince: ago(9, 54).toISOString(),
    });
  });

  it("in flight: the desired release, who recorded it and how long it has waited", () => {
    expect(lane.inFlight).toEqual({
      releaseId: ID(5),
      sourceSha: SHA("5"),
      sha8: "55555555",
      state: "deploying",
      attempts: 1,
      recordedAt: ago(2).toISOString(),
      startedAt: ago(1, 50).toISOString(),
      requestedBy: "user:u5",
      waitingMs: 2 * 3_600_000,
    });
    expect(lane.desired).toMatchObject({
      releaseId: ID(5),
      releaseState: "deploying",
    });
  });

  it("history24h: newest first; supersedes name who replaced them; the park is timed by its instant", () => {
    expect(
      lane.history24h.map((h) => [h.sha8, h.outcome, h.requestedBy, h.endedAt])
    ).toEqual([
      ["44444444", "parked", "user:u4", ago(3).toISOString()],
      ["33333333", "superseded", "user:u3", ago(4).toISOString()],
      ["22222222", "superseded", "user:u2", ago(4, 50).toISOString()],
    ]);
    const second = lane.history24h[2];
    expect(second?.supersededBy).toEqual({
      releaseId: ID(3),
      sha8: "33333333",
      requestedBy: "user:u3",
    });
    expect(second?.reason).toBe(
      "superseded by 33333333 (user:u3) before it finished"
    );
    expect(lane.history24h[1]?.hadFailedAttempt).toBe(true);
    expect(lane.history24h[0]?.supersededBy).toBeNull();
    expect(lane.history24h[0]?.reason).toBe(
      "parked by the sequencer after consecutive failed attempts"
    );
  });

  it("KPIs: 1 activated, 1 parked, 2 superseded; ratio and lead time from the one activation", () => {
    for (const k of [lane.kpis.last24h, lane.kpis.last7d]) {
      expect(k).toMatchObject({
        activated: 1,
        parked: 1,
        successRatio: 0.5,
        leadTimeP50Ms: 360_000,
        leadTimeP90Ms: 360_000,
        superseded: 2,
      });
    }
    expect(lane.kpis.last24h.windowHours).toBe(24);
    expect(lane.kpis.last7d.windowHours).toBe(168);
  });
});

describe("buildLaneView edges", () => {
  it("windows: a release that ended 30h ago is in the 7d KPIs but not in the 24h history or KPIs", () => {
    const old: DeliveryReleaseFacts[] = [
      facts(1, { createdAt: ago(40), activatedAt: ago(39, 50), served: true }),
      facts(2, { createdAt: ago(31) }),
      facts(3, { createdAt: ago(30), parkedAt: ago(29), current: true }),
    ];
    const lane = buildLaneView({
      ...input,
      desired: { workload: "app", state: "running", releaseId: ID(3) },
      desiredRelease: row(3, ago(30)),
      attemptsNewestFirst: [
        attempt(3, ID(3), "failed", {
          steps: [
            {
              step: "alert",
              outcome: "release_parked",
              at: ago(29).toISOString(),
            },
          ],
        }),
      ],
      servingRelease: undefined,
      releases: old,
    });
    expect(lane.history24h).toEqual([]);
    expect(lane.kpis.last24h).toMatchObject({
      activated: 0,
      parked: 0,
      successRatio: null,
      leadTimeP50Ms: null,
      leadTimeP90Ms: null,
      superseded: 0,
    });
    expect(lane.kpis.last7d).toMatchObject({
      activated: 1,
      parked: 1,
      successRatio: 0.5,
      superseded: 1,
    });
    expect(lane.serving).toBeNull();
    expect(lane.inFlight).toBeNull();
    expect(lane.desired.releaseState).toBe("parked");
  });

  it("a release that served then was replaced is a success, not a supersede", () => {
    const lane = buildLaneView({
      ...input,
      releases: [
        facts(1, { createdAt: ago(3), activatedAt: ago(2, 50), served: true }),
        facts(2, { createdAt: ago(2), current: true }),
      ],
    });
    expect(lane.history24h).toEqual([]);
    expect(lane.kpis.last24h).toMatchObject({ activated: 1, superseded: 0 });
  });

  it("queued: an in-flight release with no attempt yet reads startedAt null", () => {
    const lane = buildLaneView({
      ...input,
      attemptsNewestFirst: [],
      servingRelease: undefined,
    });
    expect(lane.serving).toBeNull();
    expect(lane.inFlight).toMatchObject({
      state: "queued",
      attempts: 0,
      startedAt: null,
    });
  });

  it("a serving desired release is not in flight; an admission refusal is the park reason", () => {
    const served = buildLaneView({
      ...input,
      attemptsNewestFirst: [attempt(5, ID(5), "active")],
      servingRelease: row(5, ago(2)),
    });
    expect(served.inFlight).toBeNull();
    expect(served.serving?.releaseId).toBe(ID(5));

    const refused = buildLaneView({
      ...input,
      releases: [
        facts(4, {
          createdAt: ago(4),
          parkedAt: ago(3),
          admissionRefusalReason: "artifact_bundle_invalid: digest mismatch",
        }),
      ],
    });
    expect(refused.history24h[0]?.reason).toBe(
      "artifact_bundle_invalid: digest mismatch"
    );
  });
});
