// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/kubernetes-migration-job.adapter`
 * Purpose: Prove per-bundle-digest DB migrations for externally placed workloads via one
 *   idempotent Kubernetes Job on the operator substrate (bug.5116). The k3s lane runs the
 *   identical contract as a Deployment initContainer; an Akash-placed node has no Deployment,
 *   so the ComputeWorkload controller runs the same migrator image here before any lease I/O.
 * Scope: BatchV1Api CRUD on `migrate-<slug>-<digest12>` Jobs in the controller's namespace.
 *   Renders caller-provided phases mechanically — it owns no runtimeProfile path policy.
 * Invariants:
 *   - PER_DIGEST_IDEMPOTENT: the Job name pins the bundle digest; a completed Job IS the
 *     durable skip marker (deliberately no ttlSecondsAfterFinished).
 *   - VALUE_FREE: DATABASE_URL reaches the Job only as a secretKeyRef; secret values never
 *     transit the controller.
 *   - RECONCILER_OWNS_POLICY: backoffLimit 0; retry/terminality decisions belong to the caller.
 *   - GC_SUPERSEDED: when a newer digest succeeds, older `migrate-<slug>-*` Jobs are deleted
 *     best-effort so the namespace holds one marker per node.
 * Side-effects: Kubernetes Job create/list/delete in one namespace.
 * Links: bug.5116, story.5016, infra/k8s/base/node-app/deployment.yaml (k3s initContainer)
 * @internal
 */

import type { BatchV1Api, V1Container, V1Job } from "@kubernetes/client-node";
import {
  ComputeLifecycleError,
  type ComputeWorkloadMigrationInput,
  type ComputeWorkloadMigrationPhase,
  type ComputeWorkloadMigrationPort,
} from "@/ports";

const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
const MANAGED_BY_LABEL_VALUE = "compute-workload-controller";
const ACTIVE_DEADLINE_SECONDS = 600;

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    statusCode?: number;
    response?: { statusCode?: number };
  };
  return candidate.statusCode ?? candidate.response?.statusCode;
}

function transient(): ComputeLifecycleError {
  return new ComputeLifecycleError("transient", "ProviderTransient", true);
}

export function migrationJobName(
  nodeSlug: string,
  bundleDigest: string
): string {
  const match = DIGEST_PATTERN.exec(bundleDigest);
  if (!match?.[1]) {
    throw new ComputeLifecycleError("terminal", "ProviderRejected", false);
  }
  return `migrate-${nodeSlug}-${match[1].slice(0, 12)}`;
}

function phaseContainer(
  input: ComputeWorkloadMigrationInput,
  phase: ComputeWorkloadMigrationPhase
): V1Container {
  return {
    name: phase.name,
    image: input.image,
    command: [...phase.command],
    env: [
      { name: "NODE_NAME", value: input.nodeSlug },
      {
        name: "DATABASE_URL",
        valueFrom: {
          secretKeyRef: {
            name: input.secretName,
            key: phase.databaseUrlSecretKey,
          },
        },
      },
    ],
    // Mirrors the k3s lane's migrate initContainer sizing verbatim.
    resources: {
      requests: { memory: "384Mi", cpu: "200m" },
      limits: { memory: "1Gi", cpu: "1000m" },
    },
  };
}

function buildJob(input: ComputeWorkloadMigrationInput, name: string): V1Job {
  const phases = [...input.phases];
  const main = phases.pop();
  if (!main) {
    throw new ComputeLifecycleError("terminal", "ProviderRejected", false);
  }
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      labels: {
        "cogni.io/node": input.nodeSlug,
        "cogni.io/environment": input.environment,
        "app.kubernetes.io/managed-by": MANAGED_BY_LABEL_VALUE,
      },
    },
    spec: {
      // The reconciler owns retry policy; a failed Job is terminal for its digest.
      backoffLimit: 0,
      activeDeadlineSeconds: ACTIVE_DEADLINE_SECONDS,
      template: {
        metadata: {
          labels: {
            "cogni.io/node": input.nodeSlug,
            "app.kubernetes.io/managed-by": MANAGED_BY_LABEL_VALUE,
          },
        },
        spec: {
          restartPolicy: "Never",
          ...(phases.length > 0
            ? {
                initContainers: phases.map((phase) =>
                  phaseContainer(input, phase)
                ),
              }
            : {}),
          containers: [phaseContainer(input, main)],
        },
      },
    },
  };
}

function jobCondition(job: V1Job, type: "Complete" | "Failed"): boolean {
  return (job.status?.conditions ?? []).some(
    (condition) => condition.type === type && condition.status === "True"
  );
}

type BatchApi = Pick<
  BatchV1Api,
  | "readNamespacedJob"
  | "createNamespacedJob"
  | "listNamespacedJob"
  | "deleteNamespacedJob"
>;

export class KubernetesMigrationJobAdapter
  implements ComputeWorkloadMigrationPort
{
  constructor(
    private readonly batch: BatchApi,
    private readonly namespace: string
  ) {}

  async ensure(
    input: ComputeWorkloadMigrationInput
  ): Promise<"succeeded" | "running" | "failed"> {
    const name = migrationJobName(input.nodeSlug, input.bundleDigest);
    let job: V1Job | undefined;
    try {
      job = (await this.batch.readNamespacedJob(name, this.namespace)).body;
    } catch (error) {
      if (statusCode(error) !== 404) throw transient();
    }
    if (!job) {
      try {
        await this.batch.createNamespacedJob(
          this.namespace,
          buildJob(input, name)
        );
      } catch (error) {
        if (error instanceof ComputeLifecycleError) throw error;
        // 409: another pass created it between read and create — same outcome.
        if (statusCode(error) !== 409) throw transient();
      }
      return "running";
    }
    if ((job.status?.succeeded ?? 0) > 0 || jobCondition(job, "Complete")) {
      await this.collectSuperseded(input, name);
      return "succeeded";
    }
    if (jobCondition(job, "Failed")) return "failed";
    return "running";
  }

  /** Best-effort: keep exactly one durable skip marker per node once a newer digest wins. */
  private async collectSuperseded(
    input: ComputeWorkloadMigrationInput,
    keep: string
  ): Promise<void> {
    try {
      const list = await this.batch.listNamespacedJob(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `cogni.io/node=${input.nodeSlug},app.kubernetes.io/managed-by=${MANAGED_BY_LABEL_VALUE}`
      );
      const prefix = `migrate-${input.nodeSlug}-`;
      await Promise.all(
        (list.body.items ?? [])
          .map((item) => item.metadata?.name)
          .filter(
            (candidate): candidate is string =>
              typeof candidate === "string" &&
              candidate !== keep &&
              candidate.startsWith(prefix)
          )
          .map((candidate) =>
            this.batch
              .deleteNamespacedJob(
                candidate,
                this.namespace,
                undefined,
                undefined,
                undefined,
                undefined,
                "Background"
              )
              .catch(() => {})
          )
      );
    } catch {
      // GC is advisory; the succeeded verdict for the current digest stands.
    }
  }
}

/**
 * A controller with no external-compute credential must surface
 * `ProviderCredentialMissing` from the lifecycle port, not a migration status —
 * and must not burn Jobs it can never act on. Pass-through keeps that honest.
 */
export class DormantComputeWorkloadMigrationAdapter
  implements ComputeWorkloadMigrationPort
{
  async ensure(): Promise<"succeeded" | "running" | "failed"> {
    return "succeeded";
  }
}
