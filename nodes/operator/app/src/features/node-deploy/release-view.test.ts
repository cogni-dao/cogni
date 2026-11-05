// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/release-view.test`
 * Purpose: Pin the STATE_TABLE of `deriveReleaseTimeline` — every release state is reachable and means
 *   what the contract says — plus tolerance of rows that predate the step timeline.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import {
  DeployReleaseDetailSchema,
  DeployWorkloadsReadSchema,
} from "@/contracts/deploy.workloads.v1.contract";
import type { AttemptPhase, AttemptRow, DesiredRow, ReleaseRow } from "@/ports";
import {
  buildReleaseDetail,
  buildWorkloadView,
  deriveReleaseTimeline,
} from "./release-view";
import { canaryApp, ENV, NODE_ID, SHA_1 } from "./testing";

const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const R1 = "00000000-0000-4000-8000-000000000001";
const R2 = "00000000-0000-4000-8000-000000000002";

const attempt = (
  releaseId: string,
  n: number,
  phase: AttemptPhase,
  extra: Partial<AttemptRow> = {}
): AttemptRow => ({
  id: `a-${releaseId.slice(-1)}-${n}`,
  releaseId,
  attempt: n,
  cogniKey: `k-${releaseId}-${n}`,
  externalName: undefined,
  provider: undefined,
  endpoints: [],
  phase,
  error: undefined,
  unhealthySince: undefined,
  createdAt: new Date(T0 + n * 1000),
  leasedAt: undefined,
  updatedAt: new Date(T0 + n * 1000 + 500),
  steps: [],
  ...extra,
});

const release: ReleaseRow = {
  id: R1,
  nodeId: NODE_ID,
  env: ENV,
  workload: "canary",
  sourceSha: SHA_1,
  spec: canaryApp(),
  createdBy: "t",
  createdAt: new Date(T0),
};

const derive = (attemptsNewestFirst: AttemptRow[], current: string = R1) =>
  deriveReleaseTimeline({
    release,
    currentReleaseId: current,
    attemptsNewestFirst,
  });

describe("deriveReleaseTimeline STATE_TABLE", () => {
  it.each([
    ["planned", "deploying"],
    ["closing", "deploying"],
    ["failed", "parked"],
    ["active", "active"],
  ] as const)("exposes terminal refusal independently of %s recovery/serving state", (phase, releaseState) => {
    const admissionRefusal = {
      reason: "artifact_bundle_invalid: digest mismatch",
      at: new Date(T0).toISOString(),
    };
    const refused = { ...release, admissionRefusal };
    const rows = [attempt(R1, 1, phase)];
    const desired = {
      workload: "canary",
      state: "running",
      releaseId: R1,
    } as const;
    expect(
      buildWorkloadView({
        desired,
        release: refused,
        attemptsNewestFirst: rows,
      }).desired
    ).toMatchObject({
      releaseState,
      admissionRefusal,
      admissionRefusedAt: admissionRefusal.at,
    });
    const detail = buildReleaseDetail({
      desired,
      release: refused,
      attemptsNewestFirst: rows,
    });
    expect(DeployReleaseDetailSchema.parse(detail).release).toMatchObject({
      releaseState,
      admissionRefusal,
    });
    expect(
      deriveReleaseTimeline({
        release: refused,
        currentReleaseId: R2,
        attemptsNewestFirst: rows,
      })
    ).toMatchObject({ releaseState: "superseded", admissionRefusal });
  });

  it("queued: current release with no attempt", () => {
    expect(derive([])).toMatchObject({
      releaseState: "queued",
      startedAt: null,
      activatedAt: null,
      leadTimeMs: null,
    });
  });

  it.each([
    "planned",
    "created",
    "proving",
    "proven",
  ] as const)("deploying: an attempt in phase %s", (phase) => {
    expect(derive([attempt(R1, 1, phase)]).releaseState).toBe("deploying");
  });

  it("deploying: a failed lease is still being closed (the sequencer pays for nothing meanwhile)", () => {
    expect(
      derive([attempt(R1, 2, "closing"), attempt(R1, 1, "failed")]).releaseState
    ).toBe("deploying");
  });

  it("active: carries activatedAt from the activated step and leadTimeMs from the recording", () => {
    const t = derive([
      attempt(R1, 1, "active", {
        steps: [
          { step: "created", outcome: "ok", at: "2026-11-02T10:00:05.000Z" },
          { step: "activated", outcome: "ok", at: "2026-11-02T10:02:00.000Z" },
        ],
      }),
    ]);
    expect(t).toMatchObject({
      releaseState: "active",
      current: true,
      activatedAt: "2026-11-02T10:02:00.000Z",
      leadTimeMs: 120_000,
      startedAt: new Date(T0 + 1000).toISOString(),
      parkedReason: null,
    });
  });

  it("active: an attempt that predates the timeline falls back to its last phase change", () => {
    const t = derive([attempt(R1, 1, "active")]);
    expect(t.activatedAt).toBe(new Date(T0 + 1500).toISOString());
    expect(t.leadTimeMs).toBe(1500);
  });

  it("failed: fewer than 3 failures and nothing running (retry pending), or the live lease was lost", () => {
    expect(derive([attempt(R1, 1, "failed")]).releaseState).toBe("failed");
    expect(
      derive([attempt(R1, 2, "failed"), attempt(R1, 1, "failed")]).releaseState
    ).toBe("failed");
    expect(derive([attempt(R1, 1, "lost")]).releaseState).toBe("failed");
  });

  it("parked: 3 consecutive failures; the reason names the count and the last error", () => {
    const t = derive([
      attempt(R1, 3, "failed", { error: "proof_timeout: version 502" }),
      attempt(R1, 2, "failed", { error: "lease_not_ready" }),
      attempt(R1, 1, "failed"),
    ]);
    expect(t.releaseState).toBe("parked");
    expect(t.parkedReason).toBe(
      "3 consecutive failed attempts; last: proof_timeout: version 502"
    );
  });

  it("parked: the sequencer's own park verdict wins over a third attempt that is still closing", () => {
    const verdict = {
      step: "alert",
      outcome: "release_parked",
      at: "2026-11-02T10:10:00.000Z",
    };
    const attempts = [
      attempt(R1, 3, "closing", {
        error: "proof_timeout: version 502",
        steps: [verdict],
      }),
      attempt(R1, 2, "failed", { error: "lease_not_ready" }),
      attempt(R1, 1, "failed"),
    ];
    const t = derive(attempts);
    expect(t.releaseState).toBe("parked");
    expect(t.parkedReason).toMatch(
      /^3 consecutive failed attempts; last: proof_timeout/
    );
    // without the verdict the same rows are still deploying (the close is unconfirmed)
    expect(
      derive([
        { ...attempts[0], steps: [] } as AttemptRow,
        ...attempts.slice(1),
      ]).releaseState
    ).toBe("deploying");
  });

  it("serving: the release backing the live lease is flagged even when superseded, deploying or parked", () => {
    // R1 serves; R2 (desired) is parked after 3 failures -> R1: superseded + serving
    const attempts = [
      attempt(R2, 3, "failed"),
      attempt(R2, 2, "failed"),
      attempt(R2, 1, "failed"),
      attempt(R1, 1, "active"),
    ];
    expect(derive(attempts, R2)).toMatchObject({
      releaseState: "superseded",
      current: false,
      serving: true,
    });
    const r2 = deriveReleaseTimeline({
      release: { ...release, id: R2 },
      currentReleaseId: R2,
      attemptsNewestFirst: attempts,
    });
    expect(r2).toMatchObject({ releaseState: "parked", serving: false });
    const view = buildWorkloadView({
      desired: {
        workload: "canary",
        state: "running",
        releaseId: R2,
      },
      release: { ...release, id: R2 },
      attemptsNewestFirst: attempts,
    });
    expect(view.servingReleaseId).toBe(R1);
    expect(view.desired).toMatchObject({
      releaseState: "parked",
      serving: false,
    });
    // an active current release is serving itself
    expect(derive([attempt(R1, 1, "active")]).serving).toBe(true);
    expect(derive([]).serving).toBe(false);
  });

  it("a success in between resets the count: failed, failed, ACTIVE is not parked", () => {
    expect(
      derive([
        attempt(R1, 3, "active"),
        attempt(R1, 2, "failed"),
        attempt(R1, 1, "failed"),
      ]).releaseState
    ).toBe("active");
  });

  it("superseded: any release the desired row no longer points at, with its activation record kept", () => {
    const t = derive(
      [
        attempt(R2, 1, "active"),
        attempt(R1, 1, "retiring", {
          steps: [
            {
              step: "activated",
              outcome: "ok",
              at: "2026-11-02T10:01:00.000Z",
            },
          ],
        }),
      ],
      R2
    );
    expect(t).toMatchObject({
      releaseState: "superseded",
      current: false,
      parkedReason: null,
      activatedAt: "2026-11-02T10:01:00.000Z",
      leadTimeMs: 60_000,
    });
    // a parked-then-replaced release is superseded too, never `parked`
    expect(
      derive(
        [
          attempt(R1, 3, "failed"),
          attempt(R1, 2, "failed"),
          attempt(R1, 1, "failed"),
        ],
        R2
      ).releaseState
    ).toBe("superseded");
  });
});

describe("read-model builders", () => {
  const desired: DesiredRow = {
    nodeId: NODE_ID,
    env: ENV,
    workload: "canary",
    state: "running",
    releaseId: R1,
    updatedAt: new Date(T0),
  };

  it("tolerate rows without a timeline, timestamps or a release row (pre-timeline data)", () => {
    const sparse = { phase: "active", externalName: "222", attempt: 2 };
    const v = buildWorkloadView({
      desired,
      release: { sourceSha: SHA_1 },
      attemptsNewestFirst: [sparse as unknown as AttemptRow],
    });
    expect(v.active?.steps).toEqual([]);
    expect(v.desired.releaseState).toBe("queued");
    expect(
      buildWorkloadView({
        desired,
        release: undefined,
        attemptsNewestFirst: [],
      }).desired.sourceSha
    ).toBeUndefined();
  });

  it("emit shapes the contract schemas accept (workload list and release detail)", () => {
    const attempts = [
      attempt(R1, 1, "active", {
        externalName: "1002",
        provider: "akash1abc",
        endpoints: ["x.provider.example"],
        steps: [
          { step: "activated", outcome: "ok", at: "2026-11-02T10:02:00.000Z" },
        ],
      }),
    ];
    const list = {
      nodeId: NODE_ID,
      env: ENV,
      workloads: [
        buildWorkloadView({
          desired,
          release,
          attemptsNewestFirst: attempts,
        }),
      ],
    };
    expect(
      DeployWorkloadsReadSchema.parse(list).workloads[0]?.desired
    ).toMatchObject({ releaseState: "active", leadTimeMs: 120_000 });
    const detail = buildReleaseDetail({
      release,
      desired,
      attemptsNewestFirst: attempts,
    });
    expect(DeployReleaseDetailSchema.parse(detail).attempts).toHaveLength(1);
    expect(detail.desiredState).toBe("running");
  });

  it("detail lists only that release's attempts, oldest first", () => {
    const detail = buildReleaseDetail({
      release,
      desired: { state: "running", releaseId: R2 },
      attemptsNewestFirst: [
        attempt(R2, 1, "active"),
        attempt(R1, 2, "failed"),
        attempt(R1, 1, "failed"),
      ],
    });
    expect(
      detail.attempts.map((a) => `${a.releaseId.slice(-1)}:${a.attempt}`)
    ).toEqual(["1:1", "1:2"]);
    expect(detail.release.releaseState).toBe("superseded");
  });
});
