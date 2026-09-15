// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { assessComputeWorkloadReadiness } from "./compute-workload-readiness";

const expected = {
  apiVersion: "compute.cogni.io/v1alpha1",
  kind: "ComputeWorkload",
  metadata: { name: "node-id", namespace: "cogni-candidate-a" },
  spec: {
    nodeId: "node-id",
    bundle: { ref: "image@sha256:digest", source: { sha: "source-sha" } },
    workload: { name: "sample", services: [] },
  },
};

function live(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: expected.apiVersion,
    kind: expected.kind,
    metadata: { ...expected.metadata, generation: 2 },
    spec: expected.spec,
    status: {
      phase: "Ready",
      observedGeneration: 2,
      observedBundle: expected.spec.bundle,
      conditions: [{ type: "Ready", status: "True", observedGeneration: 2 }],
    },
    ...overrides,
  };
}

describe("assessComputeWorkloadReadiness", () => {
  it("accepts the exact desired spec at the controller-observed generation", () => {
    expect(assessComputeWorkloadReadiness({ expected, live: live() })).toEqual({
      ready: true,
    });
  });

  it.each([
    [
      "desired_spec_pending",
      { spec: { ...expected.spec, workload: { name: "old" } } },
    ],
    [
      "generation_pending",
      { status: { ...live().status, observedGeneration: 1 } },
    ],
    [
      "ready_condition_pending",
      { status: { ...live().status, conditions: [] } },
    ],
    [
      "deletion_pending",
      {
        metadata: {
          ...expected.metadata,
          generation: 2,
          deletionTimestamp: "2026-09-02T21:00:00Z",
        },
      },
    ],
  ])("fails closed with %s", (reason, overrides) => {
    expect(
      assessComputeWorkloadReadiness({ expected, live: live(overrides) })
    ).toEqual({ ready: false, reason });
  });

  it("names the controller failure reason when the phase is not Ready (bug.5116)", () => {
    expect(
      assessComputeWorkloadReadiness({
        expected,
        live: live({
          status: {
            ...live().status,
            phase: "Failed",
            failure: {
              reason: "MigrationFailed",
              message: "node database migration for the desired bundle failed",
              retryable: false,
            },
          },
        }),
      })
    ).toEqual({ ready: false, reason: "phase_not_ready:MigrationFailed" });
  });

  it("keeps the bare phase_not_ready reason when no failure is recorded", () => {
    expect(
      assessComputeWorkloadReadiness({
        expected,
        live: live({ status: { ...live().status, phase: "Progressing" } }),
      })
    ).toEqual({ ready: false, reason: "phase_not_ready" });
  });
});

describe("assessComputeWorkloadReadiness — XComputeWorkload (story.5016)", () => {
  const xExpected = {
    apiVersion: "compute.cogni.io/v1alpha1",
    kind: "XComputeWorkload",
    metadata: { name: "72aa130b", namespace: "cogni-production" },
    spec: { migration: { mode: "Skip" }, bootPolicy: { onDeadline: "Hold" } },
  };
  const xLive = (over: Record<string, unknown> = {}) => ({
    apiVersion: "compute.cogni.io/v1alpha1",
    kind: "XComputeWorkload",
    metadata: {
      name: "72aa130b",
      namespace: "cogni-production",
      generation: 4,
    },
    spec: {
      migration: { mode: "Skip" },
      bootPolicy: { onDeadline: "Hold" },
      // Crossplane mutates the composite's spec — extra keys must not block readiness.
      compositionRef: { name: "xcomputeworkload-akash" },
    },
    status: {
      phase: "Ready",
      serving: true,
      conditions: [
        { type: "Synced", status: "True", observedGeneration: 4 },
        { type: "Ready", status: "True", observedGeneration: 4 },
      ],
    },
    ...over,
  });

  it("is ready when phase Ready + serving + Synced/Ready conditions hold", () => {
    expect(
      assessComputeWorkloadReadiness({ expected: xExpected, live: xLive() })
    ).toEqual({ ready: true });
  });

  it("tolerates crossplane-added spec keys but rejects a drifted declared key", () => {
    const drifted = xLive();
    (drifted.spec as Record<string, unknown>).migration = {
      mode: "RequireBeforeTransaction",
    };
    expect(
      assessComputeWorkloadReadiness({ expected: xExpected, live: drifted })
    ).toEqual({ ready: false, reason: "desired_spec_pending" });
  });

  it("refuses a composite that is not serving", () => {
    const notServing = xLive();
    (notServing.status as Record<string, unknown>).serving = false;
    expect(
      assessComputeWorkloadReadiness({ expected: xExpected, live: notServing })
    ).toEqual({ ready: false, reason: "not_serving" });
  });

  it("refuses Ready conditions observed at a PRIOR generation (update staleness)", () => {
    const stale = xLive();
    (stale.metadata as Record<string, unknown>).generation = 5;
    expect(
      assessComputeWorkloadReadiness({ expected: xExpected, live: stale })
    ).toEqual({ ready: false, reason: "ready_condition_pending" });
  });

  it("surfaces the composite failure reason when the phase is not Ready", () => {
    const failed = xLive();
    (failed.status as Record<string, unknown>).phase = "Failed";
    (failed.status as Record<string, unknown>).failure = {
      reason: "ProviderRejected",
    };
    expect(
      assessComputeWorkloadReadiness({ expected: xExpected, live: failed })
    ).toEqual({ ready: false, reason: "phase_not_ready:ProviderRejected" });
  });
});
