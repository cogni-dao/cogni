// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ProvisionState } from "@cogni/ai-tools";

export const COMPUTE_WORKLOAD_FINALIZER =
  "compute.cogni.io/external-resource" as const;
export const COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION =
  "compute.cogni.io/last-attempt" as const;

export type ComputeWorkloadPhase =
  | "Ready"
  | "Progressing"
  | "Failed"
  | "Unknown";

export interface ComputeWorkloadSource {
  readonly repository: string;
  readonly sha: string;
}

/** One immutable CI-produced OCI artifact. The digest has one authority: `image`. */
export interface ComputeWorkloadArtifact {
  readonly name: string;
  readonly image: string;
}

export interface ComputeWorkloadBundle {
  /** Immutable OCI reference for the atomic bundle manifest selected by CI. */
  readonly ref: string;
  readonly source: ComputeWorkloadSource;
  readonly artifacts: readonly ComputeWorkloadArtifact[];
}

/** A value-free reference into the node/env/service scoped secret resolver (task.5054). */
export interface ComputeWorkloadSecretRef {
  readonly key: string;
}

/** Git-safe runtime declaration. `env` is non-secret binding/config only. */
export interface DeclaredProvisionServiceSpec {
  readonly name: string;
  readonly artifact: string;
  readonly runtimeProfile?: "cogni-node-app-v1";
  readonly secretRefs?: readonly ComputeWorkloadSecretRef[];
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly port: number;
  readonly visibility: "public" | "private";
  readonly bindings: Readonly<Record<string, string>>;
  readonly bindHost: "0.0.0.0";
  readonly cpuUnits: number;
  readonly memoryMi: number;
  readonly storageMi: number;
}

export interface DeclaredProvisionSpec {
  readonly name: string;
  readonly publicHost: string;
  readonly services: readonly DeclaredProvisionServiceSpec[];
}

export interface ComputeWorkloadSpec {
  readonly nodeId: string;
  readonly environment: string;
  readonly bundle: ComputeWorkloadBundle;
  readonly workload: DeclaredProvisionSpec;
}

export interface ComputeWorkloadCondition {
  readonly type: "Ready";
  readonly status: "True" | "False" | "Unknown";
  readonly observedGeneration: number;
  readonly reason: string;
  readonly message: string;
  readonly lastTransitionTime: string;
}

export interface ComputeWorkloadAttempt {
  readonly key: string;
  readonly operation: "create" | "update" | "recover" | "delete";
  readonly ordinal: number;
  readonly outcome:
    | "claimed"
    | "prepared"
    | "allocated"
    | "known_failure"
    | "succeeded"
    | "unknown";
  readonly retryCount: number;
  readonly leaderEpoch: string;
  /** Provider-opaque pre-allocation adoption cursor; contains no credential or manifest. */
  readonly allocationCursor?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
}

/** Durable, redacted operation receipt mirrored to metadata before provider I/O. */
export interface ComputeWorkloadAttemptReceipt {
  readonly key: string;
  readonly operation: ComputeWorkloadAttempt["operation"];
  readonly ordinal: number;
  readonly outcome: ComputeWorkloadAttempt["outcome"];
  readonly leaderEpoch: string;
  readonly allocationCursor?: string;
  readonly retryCount: number;
  readonly startedAt: string;
  readonly resource?: {
    readonly provider: string;
    readonly id: string;
  };
}

export interface ComputeWorkloadStatus {
  readonly phase: ComputeWorkloadPhase;
  readonly desiredGeneration: number;
  readonly observedGeneration?: number;
  readonly observedBundle?: ComputeWorkloadBundle;
  readonly resource?: {
    readonly provider: string;
    readonly id: string;
    readonly state: ProvisionState;
    readonly endpoints: readonly string[];
  };
  /** Exact CNAME value owned by this CR; used for fail-closed finalization. */
  readonly dns?: {
    readonly hostname: string;
    readonly target: string;
  };
  readonly attempt?: ComputeWorkloadAttempt;
  readonly recoveryCount?: number;
  /**
   * The `metadata.generation` the recovery budget (`recoveryCount`) was accrued
   * under (bug.5128). A generation bump always mints a fresh attempt budget;
   * absent on legacy statuses, where the count is attributed to
   * `desiredGeneration` (the pre-fix association).
   */
  readonly recoveryGeneration?: number;
  readonly failure?: {
    readonly reason: string;
    /** Stable redacted operator-safe detail; never a provider response body. */
    readonly message: string;
    readonly retryable: boolean;
    /**
     * The stage-specific reason of the last provider attempt when the terminal
     * reason aggregates it away (bug.5128): RecoveryLimitExceeded keeps the
     * last Boot* stage here so a wedged CR says WHY boot never converged.
     */
    readonly lastAttemptReason?: string;
  };
  readonly conditions: readonly ComputeWorkloadCondition[];
}

export interface ComputeWorkload {
  readonly apiVersion: "compute.cogni.io/v1alpha1";
  readonly kind: "ComputeWorkload";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly uid: string;
    readonly generation: number;
    readonly resourceVersion?: string;
    readonly deletionTimestamp?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
    readonly finalizers?: readonly string[];
  };
  readonly spec: ComputeWorkloadSpec;
  readonly status?: ComputeWorkloadStatus;
}

export function computeWorkloadIdempotencyKey(input: {
  resource: ComputeWorkload;
  operation: ComputeWorkloadAttempt["operation"];
  ordinal: number;
}): string {
  const { resource, operation, ordinal } = input;
  return [
    resource.metadata.namespace,
    resource.metadata.name,
    resource.metadata.uid,
    resource.metadata.generation,
    operation,
    ordinal,
  ].join(":");
}

export function encodeAttemptReceipt(
  receipt: ComputeWorkloadAttemptReceipt
): string {
  return JSON.stringify(receipt);
}

export function decodeAttemptReceipt(
  raw: string | undefined
): ComputeWorkloadAttemptReceipt | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ComputeWorkloadAttemptReceipt>;
    if (
      typeof value.key !== "string" ||
      typeof value.operation !== "string" ||
      typeof value.ordinal !== "number" ||
      typeof value.outcome !== "string" ||
      typeof value.leaderEpoch !== "string" ||
      typeof value.retryCount !== "number" ||
      typeof value.startedAt !== "string"
    ) {
      return undefined;
    }
    return value as ComputeWorkloadAttemptReceipt;
  } catch {
    // Legacy/non-JSON markers are deliberately treated as unknown orphan evidence.
    return undefined;
  }
}
