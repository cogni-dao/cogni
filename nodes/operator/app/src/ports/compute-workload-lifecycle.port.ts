// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Typed, redacted failure for the off-cluster compute path. The only live thrower is the
 * Kubernetes migration-Job adapter the akash-tx actuator drives; the lifecycle port the retired
 * ComputeWorkload controller implemented was deleted (task.5443).
 */

export type ComputeLifecycleFailureKind =
  | "not_found"
  | "transient"
  | "terminal"
  | "unknown_outcome";

export type ComputeLifecycleFailureReason =
  | "ProviderCredentialMissing"
  | "ProviderNotFound"
  | "ProviderTransient"
  | "ProviderRejected"
  | "ProviderOutcomeUnknown"
  | "SecretResolverUnavailable"
  | "SecretPolicyRejected"
  | "SecretReferenceMissing"
  | "DnsCredentialMissing"
  | "DnsReconcileFailed"
  | "DnsOwnershipChanged"
  | "EndpointVerificationFailed"
  | "BootStatusUnavailable"
  | "BootEndpointUnavailable"
  | "BootVersionUnavailable"
  | "BootSourceMismatch"
  | "BootReadinessUnavailable";

export class ComputeLifecycleError extends Error {
  constructor(
    public readonly kind: ComputeLifecycleFailureKind,
    /** Stable redacted code safe for CR status, Events, and structured logs. */
    public readonly reason: ComputeLifecycleFailureReason,
    public readonly retryable: boolean
  ) {
    super(reason);
    this.name = "ComputeLifecycleError";
  }
}
