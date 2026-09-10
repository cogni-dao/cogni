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
 *   - RECONCILER_OWNS_POLICY: bounded in-Job retries (backoffLimit 2, safe because the
 *     migrator is idempotent + advisory-locked); terminality decisions belong to the caller.
 *   - SCRIPT_FAILURE_IS_TERMINAL: only a migrate container that actually ran and exited
 *     non-zero makes a Failed Job terminal for its digest. A Job that failed without any
 *     such exit (DeadlineExceeded while Pending on a packed node, eviction) is an
 *     infrastructure failure: it is deleted and reported "running" so the next pass
 *     recreates it — a scheduling problem must never masquerade as a migration failure.
 *   - GC_SUPERSEDED: when a newer digest succeeds, older FINISHED `migrate-<slug>-*` Jobs are
 *     deleted best-effort so the namespace holds one marker per node; running Jobs are never
 *     collected.
 * Side-effects: Kubernetes Job create/list/delete in one namespace.
 * Links: bug.5116, story.5016, infra/k8s/base/node-app/deployment.yaml (k3s initContainer)
 * @internal
 */

import type {
  BatchV1Api,
  CoreV1Api,
  V1Container,
  V1Job,
  V1Pod,
} from "@kubernetes/client-node";
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
    // Requests are deliberately tiny (NOT the k3s initContainer's 384Mi mirror):
    // a migration is a brief single-connection process, and on a packed
    // single-node environment a 384Mi request left the Job Pending —
    // "Insufficient memory" — until activeDeadlineSeconds failed it (bug.5116
    // follow-up, candidate-a). The 1Gi/1000m limits still bound actual usage.
    resources: {
      requests: { memory: "128Mi", cpu: "50m" },
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
      // migrate.mjs is idempotent (drizzle journal) and single-writer
      // (pg_advisory_lock), so a couple of in-Job retries absorb transient DB
      // blips without poisoning the digest. A Job that still ends Failed is
      // terminal for its digest — the reconciler owns that policy.
      backoffLimit: 2,
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

type PodsApi = Pick<CoreV1Api, "listNamespacedPod">;

/** Structural pino subset: infra-retry decisions must be visible, not silent. */
export interface MigrationJobLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * True only when some migrate/migrate-doltgres container in the pod actually ran
 * and exited non-zero — the one signal that the migration SCRIPT failed. Every
 * container in the Job (init phases + main) is a migration phase, so any
 * terminated non-zero exit counts.
 */
function podHasScriptFailure(pod: V1Pod): boolean {
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  return statuses.some((status) => {
    const terminated = status.state?.terminated ?? status.lastState?.terminated;
    return terminated !== undefined && terminated.exitCode !== 0;
  });
}

export class KubernetesMigrationJobAdapter
  implements ComputeWorkloadMigrationPort
{
  constructor(
    private readonly batch: BatchApi,
    private readonly pods: PodsApi,
    private readonly namespace: string,
    private readonly log?: MigrationJobLogger
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
    if (jobCondition(job, "Failed")) {
      return this.classifyFailedJob(input, job, name);
    }
    return "running";
  }

  /**
   * A Failed Job is terminal for its digest ONLY if the migration script
   * provably ran and exited non-zero. Failure without any such container exit
   * (activeDeadlineSeconds elapsing while the pod sat Pending on a packed node,
   * node-pressure eviction) is infrastructure, not migration: delete the Job and
   * report "running" so the next reconcile pass recreates it.
   *
   * Tradeoff: an environment that stays unschedulable retries indefinitely —
   * each round implicitly bounded by activeDeadlineSeconds and made visible by
   * the warn log below every cycle — rather than poisoning the digest, which
   * only a new build could otherwise escape.
   */
  private async classifyFailedJob(
    input: ComputeWorkloadMigrationInput,
    job: V1Job,
    name: string
  ): Promise<"failed" | "running"> {
    let pods: V1Pod[];
    try {
      const list = await this.pods.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `job-name=${name}`
      );
      pods = list.body.items ?? [];
    } catch {
      // Cannot prove either way without the pods; neither a terminal verdict
      // nor a delete is safe. Retry the observation.
      throw transient();
    }
    // A pod whose migrate container ran and failed wins over any later
    // infra-failure pod: the script failure is the terminal fact.
    if (pods.some(podHasScriptFailure)) return "failed";
    const failureReason =
      (job.status?.conditions ?? []).find(
        (condition) =>
          condition.type === "Failed" && condition.status === "True"
      )?.reason ?? "Unknown";
    this.log?.warn(
      {
        job: name,
        node: input.nodeSlug,
        environment: input.environment,
        failureReason,
        podCount: pods.length,
        decision:
          "no pod has a terminated migrate container with a non-zero exitCode; " +
          "classifying as infrastructure failure and retrying",
      },
      "compute_workload_migration_job_infra_retry"
    );
    try {
      await this.batch.deleteNamespacedJob(
        name,
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        "Background"
      );
    } catch (error) {
      // 404: another pass already deleted it — same outcome (recreate next pass).
      if (statusCode(error) !== 404) throw transient();
    }
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
          // Only finished Jobs (Complete or Failed) are collectible: a rollback
          // race must never kill another digest's migration mid-flight.
          .filter(
            (item) =>
              jobCondition(item, "Complete") || jobCondition(item, "Failed")
          )
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
