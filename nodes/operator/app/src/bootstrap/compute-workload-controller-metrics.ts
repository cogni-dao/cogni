// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded-cardinality Prometheus instrumentation for the compute controller. */

import type { ProvisionState } from "@cogni/ai-tools";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { ComputeLifecycleFailureReason } from "@/ports";

interface WorkloadLabels {
  readonly namespace: string;
  readonly name: string;
  readonly nodeId: string;
  readonly environment: string;
}

interface WorkloadSnapshot extends WorkloadLabels {
  readonly phase: string;
  readonly leaseState: ProvisionState | "none";
  readonly generationLag: number;
}

interface ReconcileLabels {
  readonly nodeId: string;
  readonly environment: string;
}

export interface ComputeWorkloadControllerMetrics {
  readonly registry: Registry;
  readonly setControllerReady: (ready: boolean) => void;
  readonly setLeader: (leader: boolean) => void;
  readonly replaceWorkloadStatuses: (
    workloads: readonly WorkloadSnapshot[]
  ) => void;
  readonly recordReconcile: (
    labels: ReconcileLabels,
    result: "success" | "error",
    durationSeconds: number
  ) => void;
  readonly recordReadinessTransition: (input: {
    nodeId: string;
    environment: string;
    outcomeCode: "ReadinessPassed" | "ReadinessFailed";
  }) => void;
  readonly recordRecoveryLimit: (input: {
    nodeId: string;
    environment: string;
    outcomeCode: "RecoveryLimitExceeded";
  }) => void;
  readonly recordMutationFailure: (input: {
    nodeId: string;
    environment: string;
    operation: "create" | "update" | "recover";
    outcomeCode: ComputeLifecycleFailureReason;
  }) => void;
}

export function createComputeWorkloadControllerMetrics(
  registry = new Registry()
): ComputeWorkloadControllerMetrics {
  const reconcileTotal = new Counter({
    name: "compute_workload_reconcile_total",
    help: "ComputeWorkload reconciliation attempts",
    labelNames: ["node_id", "environment", "result"] as const,
    registers: [registry],
  });
  const reconcileDuration = new Histogram({
    name: "compute_workload_reconcile_duration_seconds",
    help: "ComputeWorkload reconciliation duration",
    labelNames: ["node_id", "environment"] as const,
    buckets: [0.1, 0.5, 1, 5, 30, 120, 360],
    registers: [registry],
  });
  const controllerReadyGauge = new Gauge({
    name: "compute_workload_controller_ready",
    help: "1 when the controller can reach Kubernetes",
    registers: [registry],
  });
  const leaderGauge = new Gauge({
    name: "compute_workload_controller_leader",
    help: "1 when this controller instance holds the Kubernetes Lease",
    registers: [registry],
  });
  const workloadStatusGauge = new Gauge({
    name: "compute_workload_status",
    help: "Current ComputeWorkload phase (one labeled series with value 1 per resource)",
    labelNames: [
      "namespace",
      "name",
      "node_id",
      "environment",
      "phase",
    ] as const,
    registers: [registry],
  });
  const generationLagGauge = new Gauge({
    name: "compute_workload_generation_lag",
    help: "Desired generation minus the last generation observed by the provider controller",
    labelNames: ["namespace", "name", "node_id", "environment"] as const,
    registers: [registry],
  });
  const leaseStateGauge = new Gauge({
    name: "compute_workload_lease_state",
    help: "Current external workload lease state without its opaque lease ID",
    labelNames: ["node_id", "environment", "state"] as const,
    registers: [registry],
  });
  const readinessTransitionTotal = new Counter({
    name: "compute_workload_readiness_transition_total",
    help: "ComputeWorkload readiness transitions by bounded outcome",
    labelNames: ["node_id", "environment", "outcome"] as const,
    registers: [registry],
  });
  const recoveryLimitTotal = new Counter({
    name: "compute_workload_recovery_limit_total",
    help: "ComputeWorkload recovery limits reached",
    labelNames: ["node_id", "environment", "outcome"] as const,
    registers: [registry],
  });
  const mutationFailureTotal = new Counter({
    name: "compute_workload_provider_mutation_failure_total",
    help: "External compute provider mutation failures",
    labelNames: ["node_id", "environment", "operation", "outcome"] as const,
    registers: [registry],
  });

  return {
    registry,
    setControllerReady: (ready) => controllerReadyGauge.set(ready ? 1 : 0),
    setLeader: (leader) => leaderGauge.set(leader ? 1 : 0),
    replaceWorkloadStatuses: (workloads) => {
      workloadStatusGauge.reset();
      generationLagGauge.reset();
      leaseStateGauge.reset();
      for (const workload of workloads) {
        const labels = {
          namespace: workload.namespace,
          name: workload.name,
          node_id: workload.nodeId,
          environment: workload.environment,
        };
        workloadStatusGauge.set({ ...labels, phase: workload.phase }, 1);
        generationLagGauge.set(labels, Math.max(0, workload.generationLag));
        leaseStateGauge.set(
          {
            node_id: workload.nodeId,
            environment: workload.environment,
            state: workload.leaseState,
          },
          1
        );
      }
    },
    recordReconcile: (labels, result, durationSeconds) => {
      const metricLabels = {
        node_id: labels.nodeId,
        environment: labels.environment,
      };
      reconcileTotal.inc({ ...metricLabels, result });
      reconcileDuration.observe(metricLabels, durationSeconds);
    },
    recordReadinessTransition: (input) =>
      readinessTransitionTotal.inc({
        node_id: input.nodeId,
        environment: input.environment,
        outcome: input.outcomeCode,
      }),
    recordRecoveryLimit: (input) =>
      recoveryLimitTotal.inc({
        node_id: input.nodeId,
        environment: input.environment,
        outcome: input.outcomeCode,
      }),
    recordMutationFailure: (input) =>
      mutationFailureTotal.inc({
        node_id: input.nodeId,
        environment: input.environment,
        operation: input.operation,
        outcome: input.outcomeCode,
      }),
  };
}
