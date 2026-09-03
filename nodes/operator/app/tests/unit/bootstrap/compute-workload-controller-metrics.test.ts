// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Unit coverage for the controller's bounded-cardinality metrics contract. */

import { describe, expect, it } from "vitest";

import { createComputeWorkloadControllerMetrics } from "@/bootstrap/compute-workload-controller-metrics";

describe("compute workload controller metrics", () => {
  it("records reconcile, readiness, recovery, and provider outcomes by node and environment", async () => {
    const metrics = createComputeWorkloadControllerMetrics();

    metrics.setControllerReady(true);
    metrics.setLeader(true);
    metrics.replaceWorkloadStatuses([
      {
        namespace: "cogni-production",
        name: "node-resource-name",
        nodeId: "node-1",
        environment: "production",
        phase: "Ready",
        leaseState: "active",
        generationLag: 0,
      },
    ]);
    metrics.recordReconcile(
      { nodeId: "node-1", environment: "production" },
      "success",
      0.25
    );
    metrics.recordReadinessTransition({
      nodeId: "node-1",
      environment: "production",
      outcomeCode: "ReadinessPassed",
    });
    metrics.recordRecoveryLimit({
      nodeId: "node-1",
      environment: "production",
      outcomeCode: "RecoveryLimitExceeded",
    });
    metrics.recordMutationFailure({
      nodeId: "node-1",
      environment: "production",
      operation: "recover",
      outcomeCode: "ProviderRejected",
    });

    const output = await metrics.registry.metrics();

    expect(output).toContain("compute_workload_controller_ready 1");
    expect(output).toContain("compute_workload_controller_leader 1");
    expect(output).toContain(
      'compute_workload_reconcile_total{node_id="node-1",environment="production",result="success"} 1'
    );
    expect(output).toContain(
      'compute_workload_readiness_transition_total{node_id="node-1",environment="production",outcome="ReadinessPassed"} 1'
    );
    expect(output).toContain(
      'compute_workload_recovery_limit_total{node_id="node-1",environment="production",outcome="RecoveryLimitExceeded"} 1'
    );
    expect(output).toContain(
      'compute_workload_provider_mutation_failure_total{node_id="node-1",environment="production",operation="recover",outcome="ProviderRejected"} 1'
    );
    expect(output).toContain(
      'compute_workload_status{namespace="cogni-production",name="node-resource-name",node_id="node-1",environment="production",phase="Ready"} 1'
    );
    expect(output).toContain(
      'compute_workload_lease_state{node_id="node-1",environment="production",state="active"} 1'
    );
  });

  it("does not create lease, source SHA, or secret label dimensions", async () => {
    const metrics = createComputeWorkloadControllerMetrics();

    metrics.recordMutationFailure({
      nodeId: "node-1",
      environment: "preview",
      operation: "create",
      outcomeCode: "ProviderTransient",
    });

    const output = await metrics.registry.metrics();

    expect(output).not.toContain("lease_id");
    expect(output).not.toContain("source_sha");
    expect(output).not.toContain("secret");
  });
});
