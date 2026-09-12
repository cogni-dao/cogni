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
