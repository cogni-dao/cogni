// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Level-based reconciliation for one provider-neutral ComputeWorkload resource. */

import type { ProvisionOutput, ProvisionSpec } from "@cogni/ai-tools";
import {
  COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION,
  COMPUTE_WORKLOAD_FINALIZER,
  ComputeLifecycleError,
  type ComputeLifecycleFailureReason,
  type ComputeWorkload,
  type ComputeWorkloadAttempt,
  type ComputeWorkloadAttemptReceipt,
  type ComputeWorkloadDnsPort,
  type ComputeWorkloadLifecyclePort,
  type ComputeWorkloadMigrationPhase,
  type ComputeWorkloadMigrationPort,
  type ComputeWorkloadSecretResolverPort,
  type ComputeWorkloadStatePort,
  type ComputeWorkloadStatus,
  computeWorkloadIdempotencyKey,
  decodeAttemptReceipt,
  encodeAttemptReceipt,
} from "@/ports";
import { hostForNode } from "@/shared/node-registry/resolve";
import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "./node-services-workload-spec";
import { buildNodeAppIdentityEnv } from "./node-workload-spec";

const MAX_MUTATION_RETRIES = 3;
const MAX_RECOVERY_ATTEMPTS = 3;

export interface ComputeWorkloadReconcileDeps {
  readonly lifecycle: ComputeWorkloadLifecyclePort;
  readonly state: ComputeWorkloadStatePort;
  readonly dns: ComputeWorkloadDnsPort;
  readonly secretResolver: ComputeWorkloadSecretResolverPort;
  readonly migration: ComputeWorkloadMigrationPort;
  readonly environment: string;
  readonly deploymentDomain: string;
  readonly leaderEpoch: string;
  readonly assertLeadership: (epoch: string) => Promise<boolean>;
  readonly now: () => Date;
  readonly recordReadinessTransition: (input: {
    nodeId: string;
    environment: string;
    sourceSha: string;
    leaseId: string;
    healthEndpoint: "/readyz";
    outcomeCode: "ReadinessPassed" | "ReadinessFailed";
  }) => void;
  readonly recordRecoveryLimit: (input: {
    nodeId: string;
    environment: string;
    sourceSha: string;
    leaseId: string;
    recoveryCount: number;
    outcomeCode: "RecoveryLimitExceeded";
  }) => void;
  readonly recordMutationFailure: (input: {
    nodeId: string;
    environment: string;
    sourceSha: string;
    leaseId: string;
    operation: "create" | "update" | "recover";
    outcomeCode: ComputeLifecycleFailureReason;
  }) => void;
  readonly recordMigrationFailure: (input: {
    nodeId: string;
    environment: string;
    sourceSha: string;
    leaseId: string;
    outcomeCode: "MigrationFailed" | "MigrationSpecInvalid";
  }) => void;
  /**
   * A migration probe that threw (API blip, RBAC not yet synced) is HELD, not
   * failed — and held passes write no status. This warn-level record is the only
   * signal, so a persistently held fleet is visible instead of silently
   * Progressing forever.
   */
  readonly recordMigrationHold: (input: {
    nodeId: string;
    environment: string;
    nodeSlug: string;
    bundleDigest: string;
    causeMessage: string;
  }) => void;
}

const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  ProviderCredentialMissing:
    "external compute provider credential is not configured",
  ProviderNotFound: "external resource was not found",
  ProviderTransient: "external compute provider is temporarily unavailable",
  ProviderRejected: "external compute provider rejected the operation",
  BootStatusUnavailable: "external workload status did not become available",
  BootEndpointUnavailable:
    "external workload did not publish a serving endpoint",
  BootVersionUnavailable:
    "external workload version endpoint did not become available",
  BootSourceMismatch:
    "external workload did not serve the declared source revision",
  BootReadinessUnavailable:
    "external workload did not pass the fixed readiness endpoint",
  ProviderOutcomeUnknown:
    "external provider mutation outcome is unknown; automatic replay is blocked",
  SecretResolverUnavailable: "declared runtime secrets cannot yet be resolved",
  SecretPolicyRejected:
    "declared runtime secret is not approved for external compute",
  SecretReferenceMissing:
    "declared runtime secret is not available in the node scope",
  DnsCredentialMissing: "external workload DNS credential is not configured",
  DnsReconcileFailed: "external workload DNS reconciliation did not succeed",
  DnsOwnershipChanged:
    "external workload DNS record no longer matches controller ownership",
  EndpointVerificationFailed: "workload source verification did not succeed",
  MutationClaimConflict: "another controller writer claimed this generation",
  WalletAllocationBlocked:
    "another uncertain wallet allocation must be resolved before creating more compute",
  MutationOutcomeUnknown:
    "external provider mutation outcome is unknown; automatic replay is blocked",
  OrphanRisk:
    "a mutation receipt exists without a durable resource handle; automatic create is blocked",
  OwnershipMismatch: "resource ownership does not match this controller",
  PublicHostOwnershipMismatch:
    "public host does not match the operator-owned node hostname",
  MigrationInProgress:
    "node database migration for the desired bundle is still running",
  MigrationFailed: "node database migration for the desired bundle failed",
  MigrationSpecInvalid:
    "desired bundle does not declare a resolvable digest and app artifact for migration",
  RetryLimitExceeded: "known-outcome retry limit was exceeded",
  RecoveryLimitExceeded:
    "generation recovery limit was reached; further allocation is blocked",
  FinalizationBlocked: "external resource finalization has not completed",
  ServingVerificationPending:
    "waiting for the workload to serve the expected source revision",
  ReadinessPassed: "fixed application health endpoint succeeded",
  ReadinessFailed: "fixed application health endpoint did not succeed",
  ResourceClosed: "external resource closure was durably observed",
  ResourceMissing: "external resource absence was durably observed",
};

function safeMessage(reason: string): string {
  return SAFE_MESSAGES[reason] ?? "external workload reconciliation failed";
}

function condition(
  resource: ComputeWorkload,
  now: string,
  status: "True" | "False" | "Unknown",
  reason: string
) {
  return {
    type: "Ready" as const,
    status,
    observedGeneration: resource.metadata.generation,
    reason,
    message: safeMessage(reason),
    lastTransitionTime: now,
  };
}

function baseStatus(resource: ComputeWorkload) {
  return {
    desiredGeneration: resource.metadata.generation,
    ...(resource.status?.dns ? { dns: resource.status.dns } : {}),
  };
}

function observedIdentity(resource: ComputeWorkload) {
  return { observedBundle: resource.spec.bundle };
}

function resourceStatus(output: ProvisionOutput) {
  return {
    provider: output.provider,
    id: output.leaseId,
    state: output.state,
    endpoints: output.endpoints,
  };
}

function sharedSubstrateEnv(
  environment: string,
  secrets: Readonly<Record<string, string>>
): Record<string, string> {
  const databaseUrl = secrets.DATABASE_URL;
  if (!databaseUrl) return {};
  try {
    const host = new URL(databaseUrl).hostname;
    if (!host) return {};
    return {
      APP_ENV: "production",
      DEPLOY_ENVIRONMENT: environment,
      TEMPORAL_ADDRESS: `${host}:7233`,
      TEMPORAL_NAMESPACE: `cogni-${environment}`,
      TEMPORAL_TASK_QUEUE: "scheduler-tasks",
      REDIS_URL: `redis://${host}:6379`,
      LITELLM_BASE_URL: `http://${host}:4000`,
    };
  } catch {
    throw new ComputeLifecycleError(
      "terminal",
      "SecretReferenceMissing",
      false
    );
  }
}

/** Explicit node-app compatibility policy; generic/private services do not inherit it. */
function legacyCogniAppEnv(input: {
  resource: ComputeWorkload;
  runtimeProfile: "cogni-node-app-v1" | undefined;
  bindings: Readonly<Record<string, string>>;
  secrets: Readonly<Record<string, string>>;
}): Record<string, string> {
  if (input.runtimeProfile !== "cogni-node-app-v1") {
    return { ...input.bindings, ...input.secrets };
  }
  if (
    COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS.some((key) => !input.secrets[key])
  ) {
    throw new ComputeLifecycleError(
      "terminal",
      "SecretReferenceMissing",
      false
    );
  }
  const { LITELLM_VIRTUAL_KEY: virtualKey, ...legacySecrets } = input.secrets;
  if (!virtualKey) {
    throw new ComputeLifecycleError(
      "terminal",
      "SecretReferenceMissing",
      false
    );
  }
  return buildNodeAppIdentityEnv({
    slug: input.resource.spec.workload.name,
    publicUrl: `https://${input.resource.spec.workload.publicHost}`,
    env: {
      APP_ENV: "production",
      DEPLOY_ENVIRONMENT: input.resource.spec.environment,
      COGNI_REPO_SHA: input.resource.spec.bundle.source.sha,
      ...sharedSubstrateEnv(input.resource.spec.environment, input.secrets),
      ...input.bindings,
      ...legacySecrets,
      // Named compatibility only: the value remains the node-scoped virtual
      // key; the operator's LiteLLM master key never enters this process.
      LITELLM_MASTER_KEY: virtualKey,
    },
  });
}

/**
 * Migration command policy implied by the `cogni-node-app-v1` runtime profile
 * (bug.5116). Fork images bundle the migrator at `/app/app/...` — the same
 * contract the k3s lane's `migrate` initContainer exercises. Policy lives here
 * with `legacyCogniAppEnv`; the Kubernetes Job adapter renders phases blindly.
 */
function cogniNodeAppMigrationPhases(input: {
  doltgres: boolean;
}): readonly ComputeWorkloadMigrationPhase[] {
  return [
    {
      name: "migrate",
      command: [
        "/bin/sh",
        "-c",
        "exec node /app/app/migrate.mjs /app/app/migrations",
      ],
      databaseUrlSecretKey: "DATABASE_URL",
    },
    ...(input.doltgres
      ? [
          {
            name: "migrate-doltgres",
            command: [
              "/bin/sh",
              "-c",
              "exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations",
            ],
            databaseUrlSecretKey: "DOLTGRES_URL",
          },
        ]
      : []),
  ];
}

function bundleDigest(ref: string): string | undefined {
  return /@(sha256:[0-9a-f]{64})$/.exec(ref)?.[1];
}

/**
 * Level-triggered migration gate (bug.5116). Every reconcile of a
 * `cogni-node-app-v1` workload re-proves that the desired bundle digest's DB
 * migrations completed before any provider mutation or recovery is attempted.
 * An already-migrated digest passes instantly, so steady-state and recover
 * replays cost one Job read. `failed` is terminal for the generation and never
 * mutates the lease: the old lease keeps serving the old sha.
 */
async function migrationGate(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload
): Promise<"passed" | "blocked"> {
  const appService = resource.spec.workload.services.find(
    (service) => service.runtimeProfile === "cogni-node-app-v1"
  );
  if (!appService) return "passed";
  const image = resource.spec.bundle.artifacts.find(
    (artifact) => artifact.name === appService.artifact
  )?.image;
  const digest = bundleDigest(resource.spec.bundle.ref);
  let outcome: "succeeded" | "running" | "failed";
  let failureReason: "MigrationFailed" | "MigrationSpecInvalid" =
    "MigrationFailed";
  if (!image || !digest) {
    // A bundle that cannot name its digest or app image cannot prove migration
    // currency; the distinct reason points operators at the bundle, not the DB.
    outcome = "failed";
    failureReason = "MigrationSpecInvalid";
  } else {
    try {
      outcome = await deps.migration.ensure({
        nodeSlug: resource.spec.workload.name,
        environment: resource.spec.environment,
        bundleDigest: digest,
        image,
        secretName: `${resource.spec.workload.name}-compute-env-secrets`,
        phases: cogniNodeAppMigrationPhases({
          doltgres: (appService.secretRefs ?? []).some(
            (ref) => ref.key === "DOLTGRES_URL"
          ),
        }),
      });
    } catch (error) {
      if (error instanceof ComputeLifecycleError && error.kind === "terminal") {
        outcome = "failed";
      } else {
        // We could not find out. Write NOTHING: the status merge patch deletes
        // absent fields, so a Progressing write here would erase a hard-block
        // failure (BootSourceMismatch / MigrationFailed) and resume the exact
        // allocation churn blocksSameGenerationRecovery exists to stop. Hold
        // this level pass; the warn record keeps a persistent hold visible.
        deps.recordMigrationHold({
          nodeId: resource.spec.nodeId,
          environment: resource.spec.environment,
          nodeSlug: resource.spec.workload.name,
          bundleDigest: digest,
          causeMessage:
            error instanceof Error ? error.message : "unknown cause",
        });
        return "blocked";
      }
    }
  }
  if (outcome === "succeeded") return "passed";
  const now = deps.now().toISOString();
  const currentCondition = resource.status?.conditions?.[0];
  const preserved = {
    ...(resource.status?.observedGeneration !== undefined
      ? { observedGeneration: resource.status.observedGeneration }
      : {}),
    ...(resource.status?.observedBundle
      ? { observedBundle: resource.status.observedBundle }
      : {}),
    ...(resource.status?.resource
      ? { resource: resource.status.resource }
      : {}),
    ...(resource.status?.attempt ? { attempt: resource.status.attempt } : {}),
    recoveryCount: resource.status?.recoveryCount ?? 0,
  };
  if (outcome === "running") {
    // Level-triggered no-op: a migration Job runs for minutes against a 15s
    // reconcile loop; rewriting an identical status every pass only bloats kine.
    const alreadyHeld =
      resource.status?.phase === "Progressing" &&
      currentCondition?.reason === "MigrationInProgress" &&
      currentCondition.observedGeneration === resource.metadata.generation;
    if (!alreadyHeld) {
      await deps.state.patchStatus({
        resource,
        status: {
          ...baseStatus(resource),
          phase: "Progressing",
          ...preserved,
          // Absent fields are deleted by the merge patch; an existing failure
          // record must survive an in-flight migration observation.
          ...(resource.status?.failure
            ? { failure: resource.status.failure }
            : {}),
          conditions: [
            condition(resource, now, "False", "MigrationInProgress"),
          ],
        },
      });
    }
    return "blocked";
  }
  const alreadyFailed =
    resource.status?.phase === "Failed" &&
    resource.status.failure?.reason === failureReason &&
    currentCondition?.reason === failureReason &&
    currentCondition.observedGeneration === resource.metadata.generation;
  if (!alreadyFailed) {
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        phase: "Failed",
        ...preserved,
        failure: {
          reason: failureReason,
          message: safeMessage(failureReason),
          retryable: false,
        },
        conditions: [condition(resource, now, "False", failureReason)],
      },
    });
  }
  if (resource.status?.failure?.reason !== failureReason) {
    deps.recordMigrationFailure({
      nodeId: resource.spec.nodeId,
      environment: resource.spec.environment,
      sourceSha: resource.spec.bundle.source.sha,
      leaseId: resource.status?.resource?.id ?? "unallocated",
      outcomeCode: failureReason,
    });
    await emit(deps, resource, "Warning", failureReason);
  }
  return "blocked";
}

async function toProvisionSpec(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload
): Promise<ProvisionSpec> {
  const artifacts = new Map(
    resource.spec.bundle.artifacts.map((artifact) => [
      artifact.name,
      artifact.image,
    ])
  );
  const servicePorts = new Map(
    resource.spec.workload.services.map((service) => [
      service.name,
      service.port,
    ])
  );
  const services = await Promise.all(
    resource.spec.workload.services.map(async (service) => {
      const image = artifacts.get(service.artifact);
      if (!image) {
        throw new ComputeLifecycleError("terminal", "ProviderRejected", false);
      }
      const secrets = await deps.secretResolver.resolve({
        nodeId: resource.spec.nodeId,
        nodeSlug: resource.spec.workload.name,
        environment: resource.spec.environment,
        serviceName: service.name,
        sourceSha: resource.spec.bundle.source.sha,
        refs: service.secretRefs ?? [],
      });
      const bindingEnv = Object.fromEntries(
        Object.entries(service.bindings).map(([envName, target]) => [
          envName,
          `http://${target}:${servicePorts.get(target) ?? 0}`,
        ])
      );
      const runtimeEnv = legacyCogniAppEnv({
        resource,
        runtimeProfile: service.runtimeProfile,
        bindings: bindingEnv,
        secrets,
      });
      return {
        name: service.name,
        image,
        env: {
          HOST: service.bindHost,
          HOSTNAME: service.bindHost,
          PORT: String(service.port),
          ...runtimeEnv,
        },
        ...(service.command ? { command: service.command } : {}),
        ...(service.args ? { args: service.args } : {}),
        cpuUnits: service.cpuUnits,
        memoryMi: service.memoryMi,
        storageMi: service.storageMi,
        expose: [
          {
            port: service.port,
            as: service.visibility === "public" ? 80 : service.port,
            global: service.visibility === "public",
            ...(service.visibility === "public"
              ? { hosts: [resource.spec.workload.publicHost] }
              : {}),
          },
        ],
      };
    })
  );
  return {
    name: resource.spec.workload.name,
    services,
  } as ProvisionSpec;
}

async function emit(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  type: "Normal" | "Warning",
  reason: string
): Promise<void> {
  await deps.state
    .event({ resource, type, reason, message: safeMessage(reason) })
    .catch(() => {});
}

async function emitReadinessTransition(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  leaseId: string,
  outcomeCode: "ReadinessPassed" | "ReadinessFailed"
): Promise<void> {
  const previous = resource.status?.conditions.find(
    (entry) => entry.type === "Ready"
  );
  if (previous?.reason === outcomeCode) return;
  const fields = {
    nodeId: resource.spec.nodeId,
    environment: resource.spec.environment,
    sourceSha: resource.spec.bundle.source.sha,
    leaseId,
    healthEndpoint: "/readyz" as const,
    outcomeCode,
  };
  deps.recordReadinessTransition(fields);
  await deps.state
    .event({
      resource,
      type: outcomeCode === "ReadinessPassed" ? "Normal" : "Warning",
      reason: outcomeCode,
      message: Object.entries(fields)
        .map(([key, value]) => `${key}=${value}`)
        .join(" "),
    })
    .catch(() => {});
}

async function patchReceipt(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  receipt: ComputeWorkloadAttemptReceipt
): Promise<void> {
  await deps.state.patchMetadata({
    resource,
    annotations: {
      [COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]: encodeAttemptReceipt(receipt),
    },
  });
}

async function writeUnknown(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  reason: string,
  attempt?: ComputeWorkloadAttempt,
  current = resource.status?.resource
): Promise<void> {
  const now = deps.now().toISOString();
  await deps.state.patchStatus({
    resource,
    status: {
      ...baseStatus(resource),
      phase: "Unknown",
      ...(resource.status?.observedGeneration !== undefined
        ? { observedGeneration: resource.status.observedGeneration }
        : {}),
      ...(resource.status?.observedBundle
        ? { observedBundle: resource.status.observedBundle }
        : {}),
      ...(current ? { resource: current } : {}),
      ...(attempt ? { attempt } : {}),
      recoveryCount: resource.status?.recoveryCount ?? 0,
      failure: { reason, message: safeMessage(reason), retryable: false },
      conditions: [condition(resource, now, "Unknown", reason)],
    },
  });
  await emit(deps, resource, "Warning", reason);
}

function ownershipFailure(
  resource: ComputeWorkload,
  environment: string
): boolean {
  const labels = resource.metadata.labels ?? {};
  return (
    resource.spec.environment !== environment ||
    resource.metadata.name !== resource.spec.nodeId ||
    labels["cogni.io/environment"] !== resource.spec.environment ||
    labels["cogni.io/node-id"] !== resource.spec.nodeId ||
    labels["cogni.io/node"] !== resource.spec.workload.name
  );
}

export function computeWorkloadPublicHost(
  slug: string,
  deploymentDomain: string
): string {
  const domain = deploymentDomain.toLowerCase().replace(/^\.+|\.+$/g, "");
  return hostForNode(slug, false, domain);
}

function generationRecoveryCount(resource: ComputeWorkload): number {
  const attempt = resource.status?.attempt;
  if (
    attempt?.operation === "recover" &&
    attempt.key ===
      computeWorkloadIdempotencyKey({
        resource,
        operation: "recover",
        ordinal: attempt.ordinal,
      })
  ) {
    return attempt.ordinal;
  }
  if (resource.status?.desiredGeneration !== resource.metadata.generation) {
    return 0;
  }
  return resource.status.recoveryCount ?? 0;
}

function blocksSameGenerationRecovery(resource: ComputeWorkload): boolean {
  return (
    resource.status?.desiredGeneration === resource.metadata.generation &&
    (resource.status?.failure?.reason === "BootSourceMismatch" ||
      resource.status?.failure?.reason === "BootReadinessUnavailable" ||
      resource.status?.failure?.reason === "MigrationFailed" ||
      resource.status?.failure?.reason === "MigrationSpecInvalid")
  );
}

/**
 * A definitive provider failure that burned the whole per-key mutation budget. The
 * idempotency key carries `metadata.generation`, so re-asserting the same desired state
 * recomputes the *same* key and the replay guard refuses it forever. Only a fresh
 * recovery ordinal can make progress, and only when the receipt proves the provider
 * definitively failed without ever handing back a handle — or when the attempt is a
 * claim abandoned by a dead leader epoch (bug.5108): the epoch changes on every
 * controller restart, so a non-live claimant can never settle its own outcome and
 * the exhausted key would otherwise replay RetryLimitExceeded forever. A claim held
 * by the LIVE epoch is never eligible; a concurrent in-process attempt stays blocked.
 */
function exhaustedRetryBudgetNeedsRecovery(
  resource: ComputeWorkload,
  liveEpoch: string
): boolean {
  const attempt = resource.status?.attempt;
  if (
    resource.status?.desiredGeneration !== resource.metadata.generation ||
    resource.status?.failure?.reason !== "RetryLimitExceeded" ||
    !attempt ||
    (attempt.operation !== "create" && attempt.operation !== "recover")
  ) {
    return false;
  }
  return (
    attempt.outcome === "known_failure" ||
    (attempt.outcome === "claimed" && attempt.leaderEpoch !== liveEpoch)
  );
}

async function recoverBounded(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload
): Promise<void> {
  const completed = generationRecoveryCount(resource);
  if (completed >= MAX_RECOVERY_ATTEMPTS) {
    const now = deps.now().toISOString();
    const current = resource.status?.resource;
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        ...observedIdentity(resource),
        phase: "Failed",
        observedGeneration: resource.metadata.generation,
        ...(current ? { resource: current } : {}),
        ...(resource.status?.attempt
          ? { attempt: resource.status.attempt }
          : {}),
        recoveryCount: completed,
        failure: {
          reason: "RecoveryLimitExceeded",
          message: safeMessage("RecoveryLimitExceeded"),
          retryable: false,
        },
        conditions: [
          condition(resource, now, "False", "RecoveryLimitExceeded"),
        ],
      },
    });
    if (resource.status?.failure?.reason !== "RecoveryLimitExceeded") {
      const fields = {
        nodeId: resource.spec.nodeId,
        environment: resource.spec.environment,
        sourceSha: resource.spec.bundle.source.sha,
        leaseId: current?.id ?? "unknown",
        recoveryCount: completed,
        outcomeCode: "RecoveryLimitExceeded" as const,
      };
      deps.recordRecoveryLimit(fields);
      await deps.state
        .event({
          resource,
          type: "Warning",
          reason: "RecoveryLimitExceeded",
          message: Object.entries(fields)
            .map(([key, value]) => `${key}=${value}`)
            .join(" "),
        })
        .catch(() => {});
    }
    return;
  }
  await mutate(deps, resource, "recover", completed + 1);
}

function attemptReceipt(
  attempt: ComputeWorkloadAttempt,
  resource?: { provider: string; id: string }
): ComputeWorkloadAttemptReceipt {
  return {
    key: attempt.key,
    operation: attempt.operation,
    ordinal: attempt.ordinal,
    outcome: attempt.outcome,
    leaderEpoch: attempt.leaderEpoch,
    ...(attempt.allocationCursor
      ? { allocationCursor: attempt.allocationCursor }
      : {}),
    retryCount: attempt.retryCount,
    startedAt: attempt.startedAt,
    ...(resource ? { resource } : {}),
  };
}

async function beginAttempt(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  operation: ComputeWorkloadAttempt["operation"],
  ordinal: number,
  retryCount: number,
  preservedFailure?: ComputeWorkloadStatus["failure"]
): Promise<ComputeWorkloadAttempt | undefined> {
  const attempt: ComputeWorkloadAttempt = {
    key: computeWorkloadIdempotencyKey({ resource, operation, ordinal }),
    operation,
    ordinal,
    outcome: "claimed",
    retryCount,
    leaderEpoch: deps.leaderEpoch,
    startedAt: deps.now().toISOString(),
  };
  const claimed = await deps.state.claimAttempt({
    resource,
    receipt: encodeAttemptReceipt(attemptReceipt(attempt)),
  });
  if (!claimed) return undefined;
  await deps.state.patchStatus({
    resource,
    status: {
      ...baseStatus(resource),
      phase: preservedFailure ? "Failed" : "Progressing",
      ...(resource.status?.observedGeneration !== undefined
        ? { observedGeneration: resource.status.observedGeneration }
        : {}),
      ...(resource.status?.observedBundle
        ? { observedBundle: resource.status.observedBundle }
        : {}),
      ...(resource.status?.resource
        ? { resource: resource.status.resource }
        : {}),
      attempt,
      recoveryCount: resource.status?.recoveryCount ?? 0,
      ...(preservedFailure ? { failure: preservedFailure } : {}),
      conditions: [
        condition(
          resource,
          attempt.startedAt,
          "False",
          preservedFailure
            ? preservedFailure.reason
            : `${operation[0]?.toUpperCase()}${operation.slice(1)}InProgress`
        ),
      ],
    },
  });
  return attempt;
}

function lifecycleError(
  error: unknown,
  mutating: boolean
): ComputeLifecycleError {
  if (error instanceof ComputeLifecycleError) return error;
  return new ComputeLifecycleError(
    mutating ? "unknown_outcome" : "transient",
    mutating ? "ProviderOutcomeUnknown" : "ProviderTransient",
    !mutating
  );
}

async function mutate(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  operation: "create" | "update" | "recover",
  ordinal: number,
  allowOrphanRiskReplay = false
): Promise<void> {
  const previous = resource.status?.attempt;
  const key = computeWorkloadIdempotencyKey({ resource, operation, ordinal });
  if (
    previous?.key === key &&
    previous.outcome === "known_failure" &&
    resource.status?.failure?.retryable === false &&
    !(allowOrphanRiskReplay && resource.status.failure.reason === "OrphanRisk")
  )
    return;
  const retryCount = previous?.key === key ? previous.retryCount + 1 : 0;
  if (retryCount >= MAX_MUTATION_RETRIES) {
    const now = deps.now().toISOString();
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        phase: "Failed",
        ...(resource.status?.resource
          ? { resource: resource.status.resource }
          : {}),
        ...(previous ? { attempt: previous } : {}),
        recoveryCount: resource.status?.recoveryCount ?? 0,
        failure: {
          reason: "RetryLimitExceeded",
          message: safeMessage("RetryLimitExceeded"),
          retryable: false,
        },
        conditions: [condition(resource, now, "False", "RetryLimitExceeded")],
      },
    });
    return;
  }

  const attempt = await beginAttempt(
    deps,
    resource,
    operation,
    ordinal,
    retryCount
  );
  if (!attempt) return;
  if (!(await deps.assertLeadership(attempt.leaderEpoch))) {
    await writeUnknown(deps, resource, "MutationOutcomeUnknown", attempt);
    return;
  }

  let allocated: ComputeWorkloadStatus["resource"] | undefined;
  let activeAttempt = attempt;
  const walletMutation = operation !== "update";
  if (walletMutation) {
    const wallet = await deps.state.claimWalletAllocation({
      attemptKey: attempt.key,
      workloadUid: resource.metadata.uid,
    });
    if (wallet.state === "blocked") {
      const now = deps.now().toISOString();
      await deps.state.patchStatus({
        resource,
        status: {
          ...baseStatus(resource),
          phase: "Progressing",
          attempt,
          recoveryCount: resource.status?.recoveryCount ?? 0,
          failure: {
            reason: "WalletAllocationBlocked",
            message: safeMessage("WalletAllocationBlocked"),
            retryable: true,
          },
          conditions: [
            condition(resource, now, "False", "WalletAllocationBlocked"),
          ],
        },
      });
      return;
    }
    if (wallet.allocationCursor) {
      activeAttempt = {
        ...activeAttempt,
        outcome: "prepared",
        allocationCursor: wallet.allocationCursor,
      };
      await patchReceipt(deps, resource, attemptReceipt(activeAttempt));
      await recoverUncertainAllocation(
        deps,
        resource,
        attemptReceipt(activeAttempt)
      );
      return;
    }
  }
  try {
    const spec = await toProvisionSpec(deps, resource);
    const output =
      operation === "update"
        ? await deps.lifecycle.update({
            resourceId: resource.status?.resource?.id ?? "",
            environment: resource.spec.environment,
            spec,
            expectedSourceSha: resource.spec.bundle.source.sha,
            idempotencyKey: attempt.key,
          })
        : await deps.lifecycle.create({
            environment: resource.spec.environment,
            spec,
            expectedSourceSha: resource.spec.bundle.source.sha,
            idempotencyKey: attempt.key,
            onPrepared: async (allocationCursor) => {
              activeAttempt = {
                ...activeAttempt,
                outcome: "prepared",
                allocationCursor,
              };
              await patchReceipt(deps, resource, attemptReceipt(activeAttempt));
              await deps.state.prepareWalletAllocation({
                attemptKey: activeAttempt.key,
                allocationCursor,
              });
              await deps.state.patchStatus({
                resource,
                status: {
                  ...baseStatus(resource),
                  phase: "Progressing",
                  attempt: activeAttempt,
                  recoveryCount: resource.status?.recoveryCount ?? 0,
                  conditions: [
                    condition(
                      resource,
                      deps.now().toISOString(),
                      "False",
                      "CreateInProgress"
                    ),
                  ],
                },
              });
            },
            onAllocated: async (output) => {
              allocated = resourceStatus(output);
              const allocatedAttempt: ComputeWorkloadAttempt = {
                ...activeAttempt,
                outcome: "allocated",
              };
              activeAttempt = allocatedAttempt;
              await patchReceipt(
                deps,
                resource,
                attemptReceipt(allocatedAttempt, {
                  provider: output.provider,
                  id: output.leaseId,
                })
              );
              await deps.state.patchStatus({
                resource,
                status: {
                  ...baseStatus(resource),
                  phase: "Progressing",
                  resource: allocated,
                  attempt: allocatedAttempt,
                  recoveryCount: resource.status?.recoveryCount ?? 0,
                  conditions: [
                    condition(
                      resource,
                      deps.now().toISOString(),
                      "False",
                      "CreateInProgress"
                    ),
                  ],
                },
              });
              await deps.state.completeWalletAllocation({
                attemptKey: allocatedAttempt.key,
              });
            },
          });
    const completedAt = deps.now().toISOString();
    const completedAttempt: ComputeWorkloadAttempt = {
      ...activeAttempt,
      outcome: "succeeded",
      completedAt,
    };
    await patchReceipt(
      deps,
      resource,
      attemptReceipt(completedAttempt, {
        provider: output.provider,
        id: output.leaseId,
      })
    );
    if (walletMutation) {
      await deps.state.completeWalletAllocation({
        attemptKey: completedAttempt.key,
      });
    }
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        ...observedIdentity(resource),
        phase: "Progressing",
        observedGeneration: resource.metadata.generation,
        resource: resourceStatus(output),
        attempt: completedAttempt,
        recoveryCount:
          operation === "recover"
            ? ordinal
            : (resource.status?.recoveryCount ?? 0),
        conditions: [
          condition(
            resource,
            completedAt,
            "False",
            "ServingVerificationPending"
          ),
        ],
      },
    });
    await emit(
      deps,
      resource,
      "Normal",
      operation === "update" ? "Updated" : "Created"
    );
  } catch (error) {
    const failure = lifecycleError(error, true);
    const completedAt = deps.now().toISOString();
    const outcome =
      failure.kind === "unknown_outcome" ? "unknown" : "known_failure";
    const failedAttempt: ComputeWorkloadAttempt = {
      ...activeAttempt,
      outcome,
      completedAt,
    };
    await patchReceipt(
      deps,
      resource,
      attemptReceipt(
        failedAttempt,
        allocated
          ? { provider: allocated.provider, id: allocated.id }
          : undefined
      )
    );
    if (failure.kind === "unknown_outcome") {
      await writeUnknown(
        deps,
        resource,
        failure.reason,
        failedAttempt,
        allocated
      );
      return;
    }
    if (walletMutation) {
      await deps.state.completeWalletAllocation({
        attemptKey: failedAttempt.key,
      });
    }
    const terminal = !failure.retryable;
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        phase: terminal ? "Failed" : "Progressing",
        ...(resource.status?.observedGeneration !== undefined
          ? { observedGeneration: resource.status.observedGeneration }
          : {}),
        ...(allocated
          ? { resource: allocated }
          : resource.status?.resource
            ? { resource: resource.status.resource }
            : {}),
        attempt: failedAttempt,
        recoveryCount:
          operation === "recover"
            ? ordinal
            : (resource.status?.recoveryCount ?? 0),
        failure: {
          reason: failure.reason,
          message: safeMessage(failure.reason),
          retryable: failure.retryable,
        },
        conditions: [condition(resource, completedAt, "False", failure.reason)],
      },
    });
    const failureFields = {
      nodeId: resource.spec.nodeId,
      environment: resource.spec.environment,
      sourceSha: resource.spec.bundle.source.sha,
      leaseId: allocated?.id ?? resource.status?.resource?.id ?? "unallocated",
      operation,
      outcomeCode: failure.reason,
    };
    deps.recordMutationFailure(failureFields);
    await emit(deps, resource, "Warning", failure.reason);
  }
}

async function closeKnown(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  current: NonNullable<ComputeWorkloadStatus["resource"]>,
  preservedFailure?: ComputeWorkloadStatus["failure"]
): Promise<boolean> {
  const attempt = await beginAttempt(
    deps,
    resource,
    "delete",
    resource.status?.recoveryCount ?? 0,
    0,
    preservedFailure
  );
  if (!attempt) return false;
  if (!(await deps.assertLeadership(attempt.leaderEpoch))) {
    await writeUnknown(
      deps,
      resource,
      "MutationOutcomeUnknown",
      attempt,
      current
    );
    return false;
  }
  try {
    await deps.lifecycle.delete({ resourceId: current.id });
    const completed: ComputeWorkloadAttempt = {
      ...attempt,
      outcome: "succeeded",
      completedAt: deps.now().toISOString(),
    };
    await patchReceipt(
      deps,
      resource,
      attemptReceipt(completed, { provider: current.provider, id: current.id })
    );
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        phase: preservedFailure ? "Failed" : "Progressing",
        resource: { ...current, state: "closed", endpoints: [] },
        attempt: completed,
        recoveryCount: resource.status?.recoveryCount ?? 0,
        ...(preservedFailure ? { failure: preservedFailure } : {}),
        conditions: [
          condition(
            resource,
            completed.completedAt ?? deps.now().toISOString(),
            "False",
            preservedFailure?.reason ?? "ServingVerificationPending"
          ),
        ],
      },
    });
    return true;
  } catch (error) {
    const failure = lifecycleError(error, true);
    await writeUnknown(deps, resource, failure.reason, attempt, current);
    return false;
  }
}

async function finalize(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  current: ComputeWorkloadStatus["resource"] | undefined
): Promise<void> {
  const finalizers = resource.metadata.finalizers ?? [];
  if (!finalizers.includes(COMPUTE_WORKLOAD_FINALIZER)) return;
  if (resource.status?.dns) {
    try {
      await deps.dns.deleteOwned({
        hostname: resource.status.dns.hostname,
        expectedTarget: resource.status.dns.target,
      });
    } catch (error) {
      const failure = lifecycleError(error, false);
      await writeUnknown(
        deps,
        resource,
        failure.reason === "DnsOwnershipChanged"
          ? failure.reason
          : "FinalizationBlocked",
        resource.status?.attempt,
        current
      );
      return;
    }
  }
  if (!current) {
    if (resource.metadata.annotations?.[COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]) {
      await writeUnknown(deps, resource, "OrphanRisk");
      return;
    }
  } else {
    try {
      const observed = await deps.lifecycle.observe({ resourceId: current.id });
      if (
        observed.state !== "closed" &&
        !(await closeKnown(deps, resource, current))
      )
        return;
    } catch (error) {
      const failure = lifecycleError(error, false);
      if (failure.kind !== "not_found") {
        await writeUnknown(
          deps,
          resource,
          "FinalizationBlocked",
          resource.status?.attempt,
          current
        );
        return;
      }
    }
  }
  await deps.state.patchMetadata({
    resource,
    finalizers: finalizers.filter(
      (value) => value !== COMPUTE_WORKLOAD_FINALIZER
    ),
  });
  await emit(deps, resource, "Normal", "Finalized");
}

async function observeAndReport(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  current: NonNullable<ComputeWorkloadStatus["resource"]>,
  attempt = resource.status?.attempt
): Promise<"active" | "pending" | "closed" | "missing" | "error"> {
  let observed: ProvisionOutput;
  try {
    observed = await deps.lifecycle.observe({ resourceId: current.id });
  } catch (error) {
    const failure = lifecycleError(error, false);
    if (failure.kind === "not_found") {
      const generationBlockingFailure = blocksSameGenerationRecovery(resource)
        ? resource.status?.failure
        : undefined;
      await deps.state.patchStatus({
        resource,
        status: {
          ...baseStatus(resource),
          ...observedIdentity(resource),
          phase: generationBlockingFailure ? "Failed" : "Progressing",
          observedGeneration: resource.metadata.generation,
          resource: { ...current, state: "closed", endpoints: [] },
          ...(attempt ? { attempt } : {}),
          recoveryCount: resource.status?.recoveryCount ?? 0,
          ...(generationBlockingFailure
            ? { failure: generationBlockingFailure }
            : {}),
          conditions: [
            condition(
              resource,
              deps.now().toISOString(),
              "False",
              generationBlockingFailure?.reason ?? "ResourceMissing"
            ),
          ],
        },
      });
      return "missing";
    }
    if (blocksSameGenerationRecovery(resource)) return "error";
    const now = deps.now().toISOString();
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        phase:
          failure.reason === "ProviderCredentialMissing"
            ? "Failed"
            : "Progressing",
        resource: current,
        ...(attempt ? { attempt } : {}),
        recoveryCount: resource.status?.recoveryCount ?? 0,
        failure: {
          reason: failure.reason,
          message: safeMessage(failure.reason),
          retryable: failure.retryable,
        },
        conditions: [condition(resource, now, "False", failure.reason)],
      },
    });
    return "error";
  }
  const generationBlockingFailure = blocksSameGenerationRecovery(resource)
    ? resource.status?.failure
    : undefined;
  if (generationBlockingFailure) {
    if (observed.state !== "closed") {
      await closeKnown(
        deps,
        resource,
        resourceStatus(observed),
        generationBlockingFailure
      );
      return "active";
    }
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        ...observedIdentity(resource),
        phase: "Failed",
        observedGeneration: resource.metadata.generation,
        resource: resourceStatus(observed),
        ...(attempt ? { attempt } : {}),
        recoveryCount: resource.status?.recoveryCount ?? 0,
        failure: generationBlockingFailure,
        conditions: [
          condition(
            resource,
            deps.now().toISOString(),
            "False",
            generationBlockingFailure.reason
          ),
        ],
      },
    });
    return observed.state === "closed"
      ? "closed"
      : observed.state === "active"
        ? "active"
        : "pending";
  }
  if (observed.state === "closed") {
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        ...observedIdentity(resource),
        phase: "Progressing",
        observedGeneration: resource.metadata.generation,
        resource: resourceStatus(observed),
        ...(attempt ? { attempt } : {}),
        recoveryCount: resource.status?.recoveryCount ?? 0,
        conditions: [
          condition(
            resource,
            deps.now().toISOString(),
            "False",
            "ResourceClosed"
          ),
        ],
      },
    });
    return "closed";
  }
  if (observed.state !== "active") return "pending";
  let dnsTarget: string | undefined;
  try {
    dnsTarget = endpointHostname(observed.endpoints);
    // Persist exact cleanup ownership before the DNS write. A crash can leave a
    // record behind, but never an untracked record the finalizer would ignore.
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        ...observedIdentity(resource),
        phase: "Progressing",
        observedGeneration: resource.metadata.generation,
        resource: resourceStatus(observed),
        ...(dnsTarget
          ? {
              dns: {
                hostname: resource.spec.workload.publicHost,
                target: dnsTarget,
              },
            }
          : {}),
        ...(attempt ? { attempt } : {}),
        recoveryCount: resource.status?.recoveryCount ?? 0,
        conditions: [
          condition(
            resource,
            deps.now().toISOString(),
            "False",
            "ServingVerificationPending"
          ),
        ],
      },
    });
    await deps.dns.reconcile({
      hostname: resource.spec.workload.publicHost,
      target: dnsTarget,
    });
  } catch (error) {
    const failure = lifecycleError(error, false);
    const now = deps.now().toISOString();
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        ...observedIdentity(resource),
        phase: failure.retryable ? "Progressing" : "Failed",
        observedGeneration: resource.metadata.generation,
        resource: resourceStatus(observed),
        ...(dnsTarget
          ? {
              dns: {
                hostname: resource.spec.workload.publicHost,
                target: dnsTarget,
              },
            }
          : {}),
        ...(attempt ? { attempt } : {}),
        recoveryCount: resource.status?.recoveryCount ?? 0,
        failure: {
          reason: failure.reason,
          message: safeMessage(failure.reason),
          retryable: failure.retryable,
        },
        conditions: [condition(resource, now, "False", failure.reason)],
      },
    });
    return "error";
  }
  if (!dnsTarget) return "error";
  const ready = await deps.lifecycle.verifySource({
    endpoints: [`https://${resource.spec.workload.publicHost}`],
    expectedSourceSha: resource.spec.bundle.source.sha,
  });
  const readinessOutcome = ready ? "ReadinessPassed" : "ReadinessFailed";
  const now = deps.now().toISOString();
  await deps.state.patchStatus({
    resource,
    status: {
      ...baseStatus(resource),
      ...observedIdentity(resource),
      phase: ready ? "Ready" : "Progressing",
      observedGeneration: resource.metadata.generation,
      resource: resourceStatus(observed),
      dns: {
        hostname: resource.spec.workload.publicHost,
        target: dnsTarget,
      },
      ...(attempt
        ? {
            attempt: ready
              ? { ...attempt, outcome: "succeeded", completedAt: now }
              : attempt,
          }
        : {}),
      recoveryCount: resource.status?.recoveryCount ?? 0,
      conditions: [
        condition(resource, now, ready ? "True" : "False", readinessOutcome),
      ],
    },
  });
  await emitReadinessTransition(
    deps,
    resource,
    observed.leaseId,
    readinessOutcome
  );
  return "active";
}

function endpointHostname(endpoints: readonly string[]): string {
  for (const endpoint of endpoints) {
    try {
      const value = endpoint.includes("://") ? endpoint : `http://${endpoint}`;
      const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
      if (hostname && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname))
        return hostname;
    } catch {
      // Try the next provider-reported endpoint.
    }
  }
  throw new ComputeLifecycleError("transient", "DnsReconcileFailed", true);
}

function attemptFromReceipt(
  receipt: ComputeWorkloadAttemptReceipt
): ComputeWorkloadAttempt {
  return {
    key: receipt.key,
    operation: receipt.operation,
    ordinal: receipt.ordinal,
    outcome: receipt.outcome,
    retryCount: receipt.retryCount,
    leaderEpoch: receipt.leaderEpoch,
    ...(receipt.allocationCursor
      ? { allocationCursor: receipt.allocationCursor }
      : {}),
    startedAt: receipt.startedAt,
  };
}

function isReplaySafeKnownFailure(
  receipt: ComputeWorkloadAttemptReceipt | undefined
): receipt is ComputeWorkloadAttemptReceipt & {
  readonly operation: "create" | "recover";
  readonly outcome: "known_failure";
  readonly resource?: undefined;
} {
  return (
    receipt?.outcome === "known_failure" &&
    receipt.resource === undefined &&
    (receipt.operation === "create" || receipt.operation === "recover")
  );
}

async function holdWalletBlocked(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  attempt: ComputeWorkloadAttempt
): Promise<void> {
  const now = deps.now().toISOString();
  await deps.state.patchStatus({
    resource,
    status: {
      ...baseStatus(resource),
      phase: "Progressing",
      attempt,
      recoveryCount: resource.status?.recoveryCount ?? 0,
      failure: {
        reason: "WalletAllocationBlocked",
        message: safeMessage("WalletAllocationBlocked"),
        retryable: true,
      },
      conditions: [
        condition(resource, now, "False", "WalletAllocationBlocked"),
      ],
    },
  });
}

async function recoverUncertainAllocation(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  receipt: ComputeWorkloadAttemptReceipt
): Promise<void> {
  if (!receipt.allocationCursor) {
    await writeUnknown(
      deps,
      resource,
      "OrphanRisk",
      attemptFromReceipt(receipt)
    );
    return;
  }
  const wallet = await deps.state.claimWalletAllocation({
    attemptKey: receipt.key,
    workloadUid: resource.metadata.uid,
  });
  if (wallet.state === "blocked") {
    await holdWalletBlocked(deps, resource, attemptFromReceipt(receipt));
    return;
  }
  if (
    wallet.allocationCursor &&
    wallet.allocationCursor !== receipt.allocationCursor
  ) {
    await writeUnknown(
      deps,
      resource,
      "ProviderOutcomeUnknown",
      attemptFromReceipt(receipt)
    );
    return;
  }
  if (!wallet.allocationCursor) {
    await deps.state.prepareWalletAllocation({
      attemptKey: receipt.key,
      allocationCursor: receipt.allocationCursor,
    });
  }
  let adopted: ProvisionOutput | null;
  try {
    adopted = await deps.lifecycle.recoverCreate({
      allocationCursor: receipt.allocationCursor,
    });
  } catch (error) {
    const failure = lifecycleError(error, false);
    await writeUnknown(
      deps,
      resource,
      failure.kind === "not_found" ? "ProviderOutcomeUnknown" : failure.reason,
      attemptFromReceipt(receipt)
    );
    return;
  }
  // Zero candidates cannot distinguish "POST never sent" from delayed provider commit.
  if (!adopted) {
    await writeUnknown(
      deps,
      resource,
      "ProviderOutcomeUnknown",
      attemptFromReceipt(receipt)
    );
    return;
  }
  const adoptedAttempt: ComputeWorkloadAttempt = {
    ...attemptFromReceipt(receipt),
    outcome: "allocated",
  };
  await patchReceipt(
    deps,
    resource,
    attemptReceipt(adoptedAttempt, {
      provider: adopted.provider,
      id: adopted.leaseId,
    })
  );
  await deps.state.patchStatus({
    resource,
    status: {
      ...baseStatus(resource),
      phase: "Progressing",
      resource: resourceStatus(adopted),
      attempt: adoptedAttempt,
      recoveryCount: resource.status?.recoveryCount ?? 0,
      conditions: [
        condition(
          resource,
          deps.now().toISOString(),
          "False",
          "CreateInProgress"
        ),
      ],
    },
  });
  await deps.state.completeWalletAllocation({ attemptKey: adoptedAttempt.key });
  if (adopted.state === "active") {
    await observeAndReport(
      deps,
      resource,
      resourceStatus(adopted),
      adoptedAttempt
    );
  }
  // Pending/closed adoption is handled from the durable handle on the next level pass.
}

/**
 * A claimed receipt abandoned by a dead leader epoch (bug.5108). The epoch changes
 * on every controller restart, so a non-live claimant is provably gone and can
 * never settle its own outcome; blind same-key replay only burns the mutation
 * budget into a terminal RetryLimitExceeded loop. Fail closed (Axiom 26): observe
 * the dead attempt's durable trace — its wallet slot — before any new mutation. A
 * persisted cursor means provider I/O may have happened, so the only legal move is
 * the existing adopt-or-hold observation path; no cursor anywhere proves the
 * pre-POST baseline was never written, so the abandoned slot is settled and the
 * exhausted key escalates through the bounded recovery ladder. Callers must never
 * route a live-epoch claim here — a concurrent in-process attempt stays blocked.
 */
async function recoverAbandonedClaim(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload,
  receipt: ComputeWorkloadAttemptReceipt
): Promise<void> {
  if (generationRecoveryCount(resource) >= MAX_RECOVERY_ATTEMPTS) {
    // Budget already burned: write the terminal RecoveryLimitExceeded record
    // without touching the wallet ledger.
    await recoverBounded(deps, resource);
    return;
  }
  const wallet = await deps.state.claimWalletAllocation({
    attemptKey: receipt.key,
    workloadUid: resource.metadata.uid,
  });
  if (wallet.state === "blocked") {
    // A different attempt owns the wallet slot; only its owner may settle it.
    await holdWalletBlocked(deps, resource, attemptFromReceipt(receipt));
    return;
  }
  if (wallet.allocationCursor) {
    // The dead claimant reached the pre-POST baseline: a provider resource may
    // exist. Adopt it if the provider confirms one; never re-create.
    const prepared: ComputeWorkloadAttempt = {
      ...attemptFromReceipt(receipt),
      outcome: "prepared",
      allocationCursor: wallet.allocationCursor,
    };
    await patchReceipt(deps, resource, attemptReceipt(prepared));
    await recoverUncertainAllocation(deps, resource, attemptReceipt(prepared));
    return;
  }
  // The cursor is persisted (receipt first, then ledger) before any POST, so no
  // cursor in either place proves provider I/O never started under this claim.
  await deps.state.completeWalletAllocation({ attemptKey: receipt.key });
  await recoverBounded(deps, resource);
}

export async function reconcileComputeWorkload(
  deps: ComputeWorkloadReconcileDeps,
  resource: ComputeWorkload
): Promise<void> {
  const rawMarker =
    resource.metadata.annotations?.[COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION];
  const receipt = decodeAttemptReceipt(rawMarker);
  const receiptResource = receipt?.resource
    ? {
        ...receipt.resource,
        state: "unknown" as const,
        endpoints: [] as string[],
      }
    : undefined;
  const current = resource.status?.resource ?? receiptResource;
  if (current && receipt?.resource) {
    // Handle persistence is the wallet-wide commit point. Clear a stale slot left by a
    // crash after the per-resource receipt but before ledger completion.
    await deps.state.completeWalletAllocation({ attemptKey: receipt.key });
  }

  if (resource.metadata.deletionTimestamp) {
    await finalize(deps, resource, current);
    return;
  }
  if (ownershipFailure(resource, deps.environment)) {
    const now = deps.now().toISOString();
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        phase: "Failed",
        failure: {
          reason: "OwnershipMismatch",
          message: safeMessage("OwnershipMismatch"),
          retryable: false,
        },
        conditions: [condition(resource, now, "False", "OwnershipMismatch")],
      },
    });
    return;
  }
  if (
    resource.spec.workload.publicHost !==
    computeWorkloadPublicHost(
      resource.spec.workload.name,
      deps.deploymentDomain
    )
  ) {
    const now = deps.now().toISOString();
    await deps.state.patchStatus({
      resource,
      status: {
        ...baseStatus(resource),
        phase: "Failed",
        failure: {
          reason: "PublicHostOwnershipMismatch",
          message: safeMessage("PublicHostOwnershipMismatch"),
          retryable: false,
        },
        conditions: [
          condition(resource, now, "False", "PublicHostOwnershipMismatch"),
        ],
      },
    });
    await emit(deps, resource, "Warning", "PublicHostOwnershipMismatch");
    return;
  }

  const finalizers = resource.metadata.finalizers ?? [];
  if (!finalizers.includes(COMPUTE_WORKLOAD_FINALIZER)) {
    await deps.state.patchMetadata({
      resource,
      finalizers: [...finalizers, COMPUTE_WORKLOAD_FINALIZER],
    });
    return;
  }

  if ((await migrationGate(deps, resource)) === "blocked") return;

  if (!current) {
    if (
      receipt &&
      (receipt.operation === "create" || receipt.operation === "recover") &&
      (receipt.outcome === "prepared" || receipt.outcome === "unknown")
    ) {
      await recoverUncertainAllocation(deps, resource, receipt);
      return;
    }
    if (
      receipt &&
      (receipt.operation === "create" || receipt.operation === "recover") &&
      receipt.outcome === "claimed" &&
      !receipt.allocationCursor
    ) {
      if (receipt.leaderEpoch !== deps.leaderEpoch) {
        // The claimant died with the mutation outcome unsettled (bug.5108);
        // observe-and-adopt instead of blindly replaying its key.
        await recoverAbandonedClaim(deps, resource, receipt);
        return;
      }
      // The cursor is persisted before POST, so this state proves provider I/O did not start.
      await mutate(deps, resource, receipt.operation, receipt.ordinal);
      return;
    }
    if (isReplaySafeKnownFailure(receipt)) {
      // Replaying the exhausted key is a guaranteed no-op; escalate the ordinal instead.
      if (exhaustedRetryBudgetNeedsRecovery(resource, deps.leaderEpoch)) {
        await recoverBounded(deps, resource);
        return;
      }
      await mutate(deps, resource, receipt.operation, receipt.ordinal, true);
      return;
    }
    if (rawMarker) {
      await writeUnknown(
        deps,
        resource,
        "OrphanRisk",
        resource.status?.attempt ??
          (receipt ? attemptFromReceipt(receipt) : undefined)
      );
      return;
    }
    if (exhaustedRetryBudgetNeedsRecovery(resource, deps.leaderEpoch)) {
      await recoverBounded(deps, resource);
      return;
    }
    await mutate(deps, resource, "create", 0);
    return;
  }

  const priorAttempt =
    resource.status?.attempt ??
    (receipt ? attemptFromReceipt(receipt) : undefined);
  if (current.state === "closed" && blocksSameGenerationRecovery(resource)) {
    return;
  }
  if (
    !resource.status &&
    receipt?.resource &&
    receipt.outcome === "succeeded"
  ) {
    await observeAndReport(deps, resource, current, priorAttempt);
    return;
  }
  if (
    priorAttempt &&
    (priorAttempt.operation === "create" ||
      priorAttempt.operation === "recover") &&
    priorAttempt.outcome !== "succeeded"
  ) {
    if (current.state === "closed") {
      await recoverBounded(deps, resource);
      return;
    }
    const state = await observeAndReport(deps, resource, current, priorAttempt);
    if (state === "pending") {
      await closeKnown(deps, resource, current);
    }
    return;
  }

  if (current.state === "closed") {
    await recoverBounded(deps, resource);
    return;
  }

  if (resource.status?.observedGeneration !== resource.metadata.generation) {
    if (
      receipt?.operation === "update" &&
      (receipt.outcome === "claimed" || receipt.outcome === "unknown")
    ) {
      await writeUnknown(
        deps,
        resource,
        "MutationOutcomeUnknown",
        priorAttempt,
        current
      );
      return;
    }
    await mutate(deps, resource, "update", 0);
    return;
  }

  await observeAndReport(deps, resource, current);
}
