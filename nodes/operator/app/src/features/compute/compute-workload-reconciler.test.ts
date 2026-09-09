// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION,
  COMPUTE_WORKLOAD_FINALIZER,
  ComputeLifecycleError,
  type ComputeWorkload,
  type ComputeWorkloadAttemptReceipt,
  type ComputeWorkloadDnsPort,
  type ComputeWorkloadLifecyclePort,
  type ComputeWorkloadSecretResolverPort,
  type ComputeWorkloadStatePort,
  type ComputeWorkloadStatus,
  computeWorkloadIdempotencyKey,
  decodeAttemptReceipt,
  encodeAttemptReceipt,
} from "@/ports";
import {
  type ComputeWorkloadReconcileDeps,
  reconcileComputeWorkload,
} from "./compute-workload-reconciler";

const NODE_ID = "123e4567-e89b-12d3-a456-426614174001";
const SHA = "a".repeat(40);
const IMAGE = `ghcr.io/cogni-dao/sample-node@sha256:${"b".repeat(64)}`;
const NOW = new Date("2026-09-01T12:00:00.000Z");
const BOOTABLE_APP_ENV = {
  AUTH_SECRET: "auth-secret",
  DATABASE_URL: "postgresql://app@candidate.vm.example/app",
  DATABASE_SERVICE_URL: "postgresql://service@candidate.vm.example/app",
  LITELLM_VIRTUAL_KEY: "sk-virtual",
  SCHEDULER_API_TOKEN: "scheduler-token",
  BILLING_INGEST_TOKEN: "billing-token",
};

function workload(overrides: Partial<ComputeWorkload> = {}): ComputeWorkload {
  const base: ComputeWorkload = {
    apiVersion: "compute.cogni.io/v1alpha1",
    kind: "ComputeWorkload",
    metadata: {
      name: NODE_ID,
      namespace: "cogni-candidate-a",
      uid: "123e4567-e89b-12d3-a456-426614174000",
      generation: 1,
      resourceVersion: "1",
      labels: {
        "cogni.io/node-id": NODE_ID,
        "cogni.io/environment": "candidate-a",
        "cogni.io/node": "sample-node",
      },
      finalizers: [COMPUTE_WORKLOAD_FINALIZER],
    },
    spec: {
      nodeId: NODE_ID,
      environment: "candidate-a",
      bundle: {
        ref: `ghcr.io/cogni-dao/sample-node-bundle@sha256:${"c".repeat(64)}`,
        source: { repository: "cogni-dao/sample-node", sha: SHA },
        artifacts: [{ name: "app", image: IMAGE }],
      },
      workload: {
        name: "sample-node",
        publicHost: "sample-node-test.cognidao.org",
        services: [
          {
            name: "app",
            artifact: "app",
            runtimeProfile: "cogni-node-app-v1",
            port: 3000,
            visibility: "public",
            bindings: {},
            bindHost: "0.0.0.0",
            secretRefs: [
              { key: "AUTH_SECRET" },
              { key: "DATABASE_URL" },
              { key: "DATABASE_SERVICE_URL" },
              { key: "LITELLM_VIRTUAL_KEY" },
              { key: "SCHEDULER_API_TOKEN" },
              { key: "BILLING_INGEST_TOKEN" },
            ],
            cpuUnits: 0.5,
            memoryMi: 512,
            storageMi: 1024,
          },
        ],
      },
    },
  };
  return {
    ...base,
    ...overrides,
    metadata: { ...base.metadata, ...overrides.metadata },
    spec: { ...base.spec, ...overrides.spec },
  };
}

function status(
  generation = 1,
  state: "pending" | "active" | "closed" | "unknown" = "active"
): ComputeWorkloadStatus {
  return {
    phase: "Progressing",
    desiredGeneration: generation,
    observedGeneration: generation,
    observedBundle: {
      ref: `ghcr.io/cogni-dao/sample-node-bundle@sha256:${"c".repeat(64)}`,
      source: { repository: "cogni-dao/sample-node", sha: SHA },
      artifacts: [{ name: "app", image: IMAGE }],
    },
    resource: {
      provider: "external",
      id: "lease-42",
      state,
      endpoints: ["https://sample-node.example"],
    },
    recoveryCount: 0,
    conditions: [],
  };
}

class MemoryState implements ComputeWorkloadStatePort {
  readonly events: { type: string; reason: string; message: string }[] = [];
  claimResult = true;
  wallet?: {
    attemptKey: string;
    workloadUid: string;
    allocationCursor?: string;
  };
  constructor(public current: ComputeWorkload) {}

  async list(): Promise<readonly ComputeWorkload[]> {
    return [this.current];
  }
  async claimAttempt(input: {
    resource: ComputeWorkload;
    receipt: string;
  }): Promise<boolean> {
    if (
      !this.claimResult ||
      input.resource.metadata.resourceVersion !==
        this.current.metadata.resourceVersion
    )
      return false;
    await this.patchMetadata({
      resource: input.resource,
      annotations: { [COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]: input.receipt },
    });
    return true;
  }
  async claimWalletAllocation(input: {
    attemptKey: string;
    workloadUid: string;
  }): Promise<
    | { state: "claimed"; allocationCursor?: string }
    | { state: "owned"; allocationCursor?: string }
    | { state: "blocked"; ownerAttemptKey: string }
  > {
    if (!this.wallet) {
      this.wallet = input;
      return { state: "claimed" };
    }
    if (this.wallet.attemptKey !== input.attemptKey) {
      return { state: "blocked", ownerAttemptKey: this.wallet.attemptKey };
    }
    return {
      state: "owned",
      ...(this.wallet.allocationCursor
        ? { allocationCursor: this.wallet.allocationCursor }
        : {}),
    };
  }
  async prepareWalletAllocation(input: {
    attemptKey: string;
    allocationCursor: string;
  }): Promise<void> {
    if (!this.wallet || this.wallet.attemptKey !== input.attemptKey)
      throw new Error("wallet owner mismatch");
    this.wallet = { ...this.wallet, allocationCursor: input.allocationCursor };
  }
  async completeWalletAllocation(input: { attemptKey: string }): Promise<void> {
    if (this.wallet?.attemptKey === input.attemptKey) delete this.wallet;
  }
  async patchMetadata(input: {
    resource: ComputeWorkload;
    annotations?: Readonly<Record<string, string | null>>;
    finalizers?: readonly string[];
  }): Promise<void> {
    const annotations = { ...(this.current.metadata.annotations ?? {}) };
    for (const [key, value] of Object.entries(input.annotations ?? {})) {
      if (value === null) delete annotations[key];
      else annotations[key] = value;
    }
    this.current = {
      ...this.current,
      metadata: {
        ...this.current.metadata,
        annotations,
        resourceVersion: String(
          Number(this.current.metadata.resourceVersion ?? "0") + 1
        ),
        ...(input.finalizers ? { finalizers: input.finalizers } : {}),
      },
    };
  }
  async patchStatus(input: {
    resource: ComputeWorkload;
    status: ComputeWorkloadStatus;
  }): Promise<void> {
    this.current = { ...this.current, status: input.status };
  }
  async event(input: {
    resource: ComputeWorkload;
    type: "Normal" | "Warning";
    reason: string;
    message: string;
  }): Promise<void> {
    this.events.push(input);
  }
}

function lifecycle(): ComputeWorkloadLifecyclePort &
  Record<
    | "observe"
    | "create"
    | "recoverCreate"
    | "update"
    | "delete"
    | "verifySource",
    ReturnType<typeof vi.fn>
  > {
  return {
    observe: vi.fn(async () => ({
      provider: "external",
      leaseId: "lease-42",
      state: "active" as const,
      endpoints: ["https://sample-node.example"],
    })),
    create: vi.fn(
      async (input: Parameters<ComputeWorkloadLifecyclePort["create"]>[0]) => {
        await input.onPrepared("41");
        const output = {
          provider: "external",
          leaseId: "lease-42",
          state: "active" as const,
          endpoints: ["https://sample-node.example"],
        };
        await input.onAllocated(output);
        return output;
      }
    ),
    recoverCreate: vi.fn(async () => null),
    update: vi.fn(async () => ({
      provider: "external",
      leaseId: "lease-42",
      state: "active" as const,
      endpoints: ["https://sample-node.example"],
    })),
    delete: vi.fn(async () => {}),
    verifySource: vi.fn(async () => true),
  };
}

async function run(
  state: MemoryState,
  port: ComputeWorkloadLifecyclePort,
  overrides: {
    dns?: ComputeWorkloadDnsPort;
    secretResolver?: ComputeWorkloadSecretResolverPort;
    recordReadinessTransition?: ComputeWorkloadReconcileDeps["recordReadinessTransition"];
    recordRecoveryLimit?: ComputeWorkloadReconcileDeps["recordRecoveryLimit"];
    recordMutationFailure?: ComputeWorkloadReconcileDeps["recordMutationFailure"];
  } = {}
) {
  const dns = overrides.dns ?? {
    reconcile: vi.fn<ComputeWorkloadDnsPort["reconcile"]>(async () => {}),
    deleteOwned: vi.fn<ComputeWorkloadDnsPort["deleteOwned"]>(
      async () => "deleted" as const
    ),
  };
  const secretResolver = overrides.secretResolver ?? {
    resolve: vi.fn<ComputeWorkloadSecretResolverPort["resolve"]>(
      async (input) => (input.serviceName === "app" ? BOOTABLE_APP_ENV : {})
    ),
  };
  const recordReadinessTransition =
    overrides.recordReadinessTransition ?? vi.fn();
  await reconcileComputeWorkload(
    {
      lifecycle: port,
      state,
      dns,
      secretResolver,
      environment: "candidate-a",
      deploymentDomain: "test.cognidao.org",
      leaderEpoch: "7:test-controller",
      assertLeadership: async (epoch) => epoch === "7:test-controller",
      now: () => NOW,
      recordReadinessTransition,
      recordRecoveryLimit: overrides.recordRecoveryLimit ?? vi.fn(),
      recordMutationFailure: overrides.recordMutationFailure ?? vi.fn(),
    },
    state.current
  );
  return { dns, secretResolver, recordReadinessTransition };
}

describe("reconcileComputeWorkload", () => {
  it("persists the finalizer before provider mutation", async () => {
    const state = new MemoryState(
      workload({ metadata: { ...workload().metadata, finalizers: [] } })
    );
    const port = lifecycle();
    await run(state, port);
    expect(state.current.metadata.finalizers).toEqual([
      COMPUTE_WORKLOAD_FINALIZER,
    ]);
    expect(port.create).not.toHaveBeenCalled();
  });

  it("persists pre-POST baseline then dseq before convergence and becomes Ready", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    const deps = await run(state, port);
    const receipt = decodeAttemptReceipt(
      state.current.metadata.annotations?.[COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]
    );
    expect(receipt).toMatchObject({
      allocationCursor: "41",
      resource: { id: "lease-42" },
      outcome: "succeeded",
    });
    expect(state.current.status?.resource?.id).toBe("lease-42");
    await run(state, port, deps);
    expect(state.current.status?.phase).toBe("Ready");
    expect(deps.dns.reconcile).toHaveBeenCalledWith({
      hostname: "sample-node-test.cognidao.org",
      target: "sample-node.example",
    });
    expect(port.verifySource).toHaveBeenCalledWith({
      endpoints: ["https://sample-node-test.cognidao.org"],
      expectedSourceSha: SHA,
    });
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(port.create.mock.calls[0]?.[0].expectedSourceSha).toBe(SHA);
    const env = port.create.mock.calls[0]?.[0].spec.services[0]?.env;
    expect(env).toMatchObject({
      SCHEDULER_API_TOKEN: "scheduler-token",
      BILLING_INGEST_TOKEN: "billing-token",
    });
    expect(env).not.toHaveProperty("DOLTGRES_URL");
  });

  it("aborts before provider IO when the resourceVersion CAS loses", async () => {
    const state = new MemoryState(workload());
    state.claimResult = false;
    const port = lifecycle();
    await run(state, port);
    expect(port.create).not.toHaveBeenCalled();
  });

  it("keeps provider-active distinct from app Ready and records redacted readiness transitions", async () => {
    const state = new MemoryState(workload({ status: status(1, "active") }));
    const port = lifecycle();
    port.verifySource.mockResolvedValue(false);
    const recordReadinessTransition = vi.fn();

    await run(state, port, { recordReadinessTransition });
    expect(state.current.status?.resource?.state).toBe("active");
    expect(state.current.status?.phase).toBe("Progressing");
    expect(state.current.status?.conditions[0]).toMatchObject({
      status: "False",
      reason: "ReadinessFailed",
      observedGeneration: 1,
    });
    expect(recordReadinessTransition).toHaveBeenCalledWith({
      nodeId: NODE_ID,
      environment: "candidate-a",
      sourceSha: SHA,
      leaseId: "lease-42",
      healthEndpoint: "/readyz",
      outcomeCode: "ReadinessFailed",
    });
    expect(state.events.at(-1)).toMatchObject({
      type: "Warning",
      reason: "ReadinessFailed",
    });
    expect(state.events.at(-1)?.message).toContain(
      "healthEndpoint=/readyz outcomeCode=ReadinessFailed"
    );

    await run(state, port, { recordReadinessTransition });
    expect(recordReadinessTransition).toHaveBeenCalledTimes(1);

    port.verifySource.mockResolvedValue(true);
    await run(state, port, { recordReadinessTransition });
    expect(state.current.status?.phase).toBe("Ready");
    expect(state.current.status?.conditions[0]).toMatchObject({
      status: "True",
      reason: "ReadinessPassed",
      observedGeneration: 1,
    });
    expect(recordReadinessTransition).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcomeCode: "ReadinessPassed" })
    );
    expect(state.events.at(-1)).toMatchObject({
      type: "Normal",
      reason: "ReadinessPassed",
    });
  });

  it("adopts exactly one post-baseline dseq after an unknown POST outcome", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    port.create.mockImplementationOnce(
      async (input: Parameters<ComputeWorkloadLifecyclePort["create"]>[0]) => {
        await input.onPrepared("41");
        throw new ComputeLifecycleError(
          "unknown_outcome",
          "ProviderOutcomeUnknown",
          false
        );
      }
    );
    port.recoverCreate.mockResolvedValueOnce({
      provider: "external",
      leaseId: "42",
      state: "active",
      endpoints: ["https://sample-node.example"],
    });
    port.observe.mockResolvedValueOnce({
      provider: "external",
      leaseId: "42",
      state: "active",
      endpoints: ["https://sample-node.example"],
    });
    await run(state, port);
    await run(state, port);
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(port.recoverCreate).toHaveBeenCalledWith({ allocationCursor: "41" });
    expect(state.current.status?.resource?.id).toBe("42");
  });

  it("does not retry when a prepared POST has zero adoption candidates", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    port.create.mockImplementationOnce(
      async (input: Parameters<ComputeWorkloadLifecyclePort["create"]>[0]) => {
        await input.onPrepared("41");
        throw new ComputeLifecycleError(
          "unknown_outcome",
          "ProviderOutcomeUnknown",
          false
        );
      }
    );
    await run(state, port);
    await run(state, port);
    await run(state, port);
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(state.current.status?.phase).toBe("Unknown");
    expect(state.current.status?.failure?.message).not.toContain("POST");
  });

  it("persists a closed known handle before a fresh recovery allocation can start", async () => {
    const state = new MemoryState(workload());
    const firstProcess = lifecycle();
    firstProcess.create.mockImplementationOnce(
      async (input: Parameters<ComputeWorkloadLifecyclePort["create"]>[0]) => {
        await input.onPrepared("41");
        await input.onAllocated({
          provider: "external",
          leaseId: "lease-41",
          state: "pending",
          endpoints: [],
        });
        throw new ComputeLifecycleError("transient", "ProviderTransient", true);
      }
    );

    await run(state, firstProcess);
    expect(firstProcess.create).toHaveBeenCalledTimes(1);
    expect(state.current.status?.resource?.id).toBe("lease-41");

    firstProcess.observe.mockResolvedValueOnce({
      provider: "external",
      leaseId: "lease-41",
      state: "closed",
      endpoints: [],
    });
    await run(state, firstProcess);
    expect(firstProcess.create).toHaveBeenCalledTimes(1);
    expect(state.current.status?.resource).toMatchObject({
      id: "lease-41",
      state: "closed",
    });
    expect(state.current.status?.conditions[0]?.reason).toBe("ResourceClosed");

    const restartedProcess = lifecycle();
    await run(state, restartedProcess);
    expect(restartedProcess.create).toHaveBeenCalledTimes(1);
    expect(state.current.status?.attempt?.operation).toBe("recover");
  });

  it("uses the current generation recovery ordinal instead of an inherited counter", async () => {
    const generation2 = workload({
      metadata: { ...workload().metadata, generation: 2 },
    });
    const state = new MemoryState(
      workload({
        metadata: generation2.metadata,
        status: {
          ...status(2, "closed"),
          recoveryCount: 3,
          attempt: {
            key: computeWorkloadIdempotencyKey({
              resource: generation2,
              operation: "recover",
              ordinal: 1,
            }),
            operation: "recover",
            ordinal: 1,
            outcome: "known_failure",
            retryCount: 0,
            leaderEpoch: "7:test-controller",
            startedAt: NOW.toISOString(),
            completedAt: NOW.toISOString(),
          },
          failure: {
            reason: "RecoveryLimitExceeded",
            message: "generation recovery limit was reached",
            retryable: false,
          },
        },
      })
    );
    const port = lifecycle();
    const recordRecoveryLimit = vi.fn();

    await run(state, port, { recordRecoveryLimit });

    expect(port.create).toHaveBeenCalledTimes(1);
    expect(state.current.status?.attempt).toMatchObject({
      operation: "recover",
      ordinal: 2,
      outcome: "succeeded",
    });
    expect(state.current.status?.recoveryCount).toBe(2);
    expect(state.current.status?.failure).toBeUndefined();
    expect(recordRecoveryLimit).not.toHaveBeenCalled();
  });

  it("stops provider creates after three generation-scoped recovery allocations", async () => {
    const capped = status(1, "closed");
    const state = new MemoryState(
      workload({
        status: {
          ...capped,
          recoveryCount: 3,
          attempt: {
            key: "recover-3",
            operation: "recover",
            ordinal: 3,
            outcome: "known_failure",
            retryCount: 0,
            leaderEpoch: "7:test-controller",
            startedAt: NOW.toISOString(),
            completedAt: NOW.toISOString(),
          },
        },
      })
    );
    const port = lifecycle();
    const recordRecoveryLimit = vi.fn();

    await run(state, port, { recordRecoveryLimit });

    expect(port.create).not.toHaveBeenCalled();
    expect(port.observe).not.toHaveBeenCalled();
    expect(state.current.status?.phase).toBe("Failed");
    expect(state.current.status?.resource).toMatchObject({
      id: "lease-42",
      state: "closed",
    });
    expect(state.current.status?.failure?.reason).toBe("RecoveryLimitExceeded");
    expect(recordRecoveryLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: "lease-42",
        recoveryCount: 3,
        outcomeCode: "RecoveryLimitExceeded",
      })
    );
    expect(state.events.at(-1)?.reason).toBe("RecoveryLimitExceeded");

    await run(state, port, { recordRecoveryLimit });
    expect(port.create).not.toHaveBeenCalled();
    expect(recordRecoveryLimit).toHaveBeenCalledTimes(1);
  });

  it("blocks every other workload create behind a durable unknown wallet allocation across restart ordering", async () => {
    const state = new MemoryState(workload());
    const firstPort = lifecycle();
    firstPort.create.mockImplementationOnce(
      async (input: Parameters<ComputeWorkloadLifecyclePort["create"]>[0]) => {
        await input.onPrepared("41");
        throw new ComputeLifecycleError(
          "unknown_outcome",
          "ProviderOutcomeUnknown",
          false
        );
      }
    );
    await run(state, firstPort);
    const firstAfterCrash = state.current;
    expect(state.wallet).toMatchObject({ allocationCursor: "41" });

    const secondId = "223e4567-e89b-12d3-a456-426614174002";
    state.current = workload({
      metadata: {
        ...workload().metadata,
        name: secondId,
        uid: "223e4567-e89b-12d3-a456-426614174000",
        labels: {
          "cogni.io/node-id": secondId,
          "cogni.io/environment": "candidate-a",
          "cogni.io/node": "sample-node",
        },
      },
      spec: { ...workload().spec, nodeId: secondId },
    });
    const secondPort = lifecycle();
    await run(state, secondPort);
    expect(secondPort.create).not.toHaveBeenCalled();
    expect(state.current.status?.failure?.reason).toBe(
      "WalletAllocationBlocked"
    );
    const secondBlocked = state.current;

    // Reconcile the original owner first: unique adoption is the wallet commit point.
    state.current = firstAfterCrash;
    firstPort.recoverCreate.mockResolvedValueOnce({
      provider: "external",
      leaseId: "42",
      state: "active",
      endpoints: ["https://sample-node.example"],
    });
    firstPort.observe.mockResolvedValueOnce({
      provider: "external",
      leaseId: "42",
      state: "active",
      endpoints: ["https://sample-node.example"],
    });
    await run(state, firstPort);
    expect(state.wallet).toBeUndefined();

    state.current = secondBlocked;
    await run(state, secondPort);
    expect(secondPort.create).toHaveBeenCalledTimes(1);
  });

  it("reconstructs a known handle from the durable receipt after status loss", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    await run(state, port);
    const { status: _lostStatus, ...withoutStatus } = state.current;
    state.current = withoutStatus;
    await run(state, port);
    expect(port.observe).toHaveBeenCalledWith({ resourceId: "lease-42" });
    expect(port.create).toHaveBeenCalledTimes(1);
  });

  it("surfaces missing optional credential without crashing or leaking provider text", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    port.create.mockRejectedValueOnce(
      new ComputeLifecycleError("terminal", "ProviderCredentialMissing", false)
    );
    await run(state, port);
    expect(state.current.status?.failure).toEqual({
      reason: "ProviderCredentialMissing",
      message: "external compute provider credential is not configured",
      retryable: false,
    });

    await run(state, port);

    expect(port.create).toHaveBeenCalledTimes(1);
    expect(state.current.status?.failure).toEqual({
      reason: "ProviderCredentialMissing",
      message: "external compute provider credential is not configured",
      retryable: false,
    });
  });

  it("persists and emits a safe known boot failure", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    port.create.mockRejectedValueOnce(
      new ComputeLifecycleError("terminal", "BootSourceMismatch", false)
    );
    const recordMutationFailure = vi.fn();

    await run(state, port, { recordMutationFailure });

    expect(state.current.status?.failure).toEqual({
      reason: "BootSourceMismatch",
      message: "external workload did not serve the declared source revision",
      retryable: false,
    });
    expect(state.events.at(-1)).toMatchObject({
      type: "Warning",
      reason: "BootSourceMismatch",
    });
    expect(recordMutationFailure).toHaveBeenCalledWith({
      nodeId: NODE_ID,
      environment: "candidate-a",
      sourceSha: SHA,
      leaseId: "unallocated",
      operation: "create",
      outcomeCode: "BootSourceMismatch",
    });
  });

  it.each([
    ["BootSourceMismatch", "active"],
    ["BootSourceMismatch", "pending"],
    ["BootReadinessUnavailable", "active"],
    ["BootReadinessUnavailable", "pending"],
  ] as const)("closes the existing lease after same-generation %s observes %s", async (reason, observedState) => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    port.create.mockImplementationOnce(
      async (input: Parameters<ComputeWorkloadLifecyclePort["create"]>[0]) => {
        await input.onPrepared("41");
        await input.onAllocated({
          provider: "external",
          leaseId: "lease-41",
          state: "pending",
          endpoints: [],
        });
        throw new ComputeLifecycleError("terminal", reason, false);
      }
    );

    await run(state, port);
    port.observe.mockResolvedValueOnce({
      provider: "external",
      leaseId: "lease-41",
      state: observedState,
      endpoints:
        observedState === "active" ? ["https://sample-node.example"] : [],
    });
    await run(state, port);
    expect(state.current.status?.failure?.reason).toBe(reason);
    expect(port.create).toHaveBeenCalledTimes(1);
    await run(state, port);

    expect(state.current.status).toMatchObject({
      phase: "Failed",
      desiredGeneration: 1,
      resource: { id: "lease-41", state: "closed" },
      failure: { reason, retryable: false },
    });
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(port.observe).toHaveBeenCalledTimes(1);
    expect(port.delete).toHaveBeenCalledTimes(1);
    expect(port.delete).toHaveBeenCalledWith({ resourceId: "lease-41" });

    const nextSha = "d".repeat(40);
    state.current = {
      ...state.current,
      metadata: { ...state.current.metadata, generation: 2 },
      spec: {
        ...state.current.spec,
        bundle: {
          ...state.current.spec.bundle,
          source: { ...state.current.spec.bundle.source, sha: nextSha },
        },
      },
    };
    await run(state, port);

    expect(port.create).toHaveBeenCalledTimes(2);
    expect(port.create.mock.calls[1]?.[0].expectedSourceSha).toBe(nextSha);
  });

  it("retains a deterministic failure when its provider handle is missing", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    port.create.mockImplementationOnce(
      async (input: Parameters<ComputeWorkloadLifecyclePort["create"]>[0]) => {
        await input.onPrepared("41");
        await input.onAllocated({
          provider: "external",
          leaseId: "lease-41",
          state: "pending",
          endpoints: [],
        });
        throw new ComputeLifecycleError(
          "terminal",
          "BootSourceMismatch",
          false
        );
      }
    );

    await run(state, port);
    port.observe.mockRejectedValueOnce(
      new ComputeLifecycleError("not_found", "ProviderNotFound", false)
    );
    await run(state, port);
    await run(state, port);

    expect(state.current.status).toMatchObject({
      phase: "Failed",
      desiredGeneration: 1,
      resource: { id: "lease-41", state: "closed" },
      failure: { reason: "BootSourceMismatch", retryable: false },
      conditions: [{ reason: "BootSourceMismatch", status: "False" }],
    });
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(port.delete).not.toHaveBeenCalled();

    state.current = {
      ...state.current,
      metadata: { ...state.current.metadata, generation: 2 },
    };
    await run(state, port);
    expect(port.create).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsafe secret before provider IO and releases the wallet slot", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    await run(state, port, {
      secretResolver: {
        resolve: vi.fn(async () => {
          throw new ComputeLifecycleError(
            "terminal",
            "SecretPolicyRejected",
            false
          );
        }),
      },
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(state.wallet).toBeUndefined();
    expect(state.current.status?.failure?.reason).toBe("SecretPolicyRejected");
  });

  it("retries missing ESO materialization before provider IO", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    await run(state, port, {
      secretResolver: {
        resolve: vi.fn(async () => {
          throw new ComputeLifecycleError(
            "transient",
            "SecretResolverUnavailable",
            true
          );
        }),
      },
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(state.wallet).toBeUndefined();
    expect(state.current.status?.failure).toMatchObject({
      reason: "SecretResolverUnavailable",
      retryable: true,
    });
  });

  it("retries a definitive pre-allocation failure after its prerequisite recovers", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    await run(state, port, {
      secretResolver: {
        resolve: vi.fn(async () => {
          throw new ComputeLifecycleError(
            "transient",
            "SecretResolverUnavailable",
            true
          );
        }),
      },
    });

    expect(port.create).not.toHaveBeenCalled();
    expect(
      decodeAttemptReceipt(
        state.current.metadata.annotations?.[
          COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION
        ]
      )
    ).toMatchObject({
      operation: "create",
      outcome: "known_failure",
      retryCount: 0,
    });

    await run(state, port);

    expect(port.create).toHaveBeenCalledTimes(1);
    expect(state.current.status).toMatchObject({
      phase: "Progressing",
      resource: { id: "lease-42" },
      attempt: {
        operation: "create",
        outcome: "succeeded",
        retryCount: 1,
      },
    });
    const completedReceipt = decodeAttemptReceipt(
      state.current.metadata.annotations?.[COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]
    );
    expect(completedReceipt).toMatchObject({
      key: state.current.status?.attempt?.key,
      operation: "create",
      outcome: "succeeded",
      resource: { id: "lease-42" },
    });
    expect(state.current.status?.failure).toBeUndefined();
  });

  it("retries a definitive pre-allocation failure already wedged behind OrphanRisk", async () => {
    const resource = workload();
    const receipt: ComputeWorkloadAttemptReceipt = {
      key: computeWorkloadIdempotencyKey({
        resource,
        operation: "create",
        ordinal: 0,
      }),
      operation: "create",
      ordinal: 0,
      outcome: "known_failure",
      leaderEpoch: "6:previous-controller",
      retryCount: 0,
      startedAt: NOW.toISOString(),
    };
    const state = new MemoryState(
      workload({
        metadata: {
          ...resource.metadata,
          annotations: {
            [COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]:
              encodeAttemptReceipt(receipt),
          },
        },
        status: {
          phase: "Unknown",
          desiredGeneration: resource.metadata.generation,
          attempt: { ...receipt, completedAt: NOW.toISOString() },
          recoveryCount: 0,
          failure: {
            reason: "OrphanRisk",
            message:
              "a mutation receipt exists without a durable resource handle; automatic create is blocked",
            retryable: false,
          },
          conditions: [
            {
              type: "Ready",
              status: "Unknown",
              observedGeneration: resource.metadata.generation,
              reason: "OrphanRisk",
              message:
                "a mutation receipt exists without a durable resource handle; automatic create is blocked",
              lastTransitionTime: NOW.toISOString(),
            },
          ],
        },
      })
    );
    const port = lifecycle();

    await run(state, port);

    expect(port.create).toHaveBeenCalledTimes(1);
    expect(state.current.status).toMatchObject({
      phase: "Progressing",
      resource: { id: "lease-42" },
      attempt: {
        key: receipt.key,
        operation: "create",
        outcome: "succeeded",
        retryCount: 1,
      },
    });
    expect(state.current.status?.failure).toBeUndefined();
  });

  it("keeps OrphanRisk blocked without a durable replay-safe receipt", async () => {
    const resource = workload();
    const attempt: ComputeWorkloadAttemptReceipt = {
      key: computeWorkloadIdempotencyKey({
        resource,
        operation: "create",
        ordinal: 0,
      }),
      operation: "create",
      ordinal: 0,
      outcome: "known_failure",
      leaderEpoch: "6:previous-controller",
      retryCount: 0,
      startedAt: NOW.toISOString(),
    };
    const state = new MemoryState(
      workload({
        status: {
          phase: "Unknown",
          desiredGeneration: resource.metadata.generation,
          attempt: { ...attempt, completedAt: NOW.toISOString() },
          recoveryCount: 0,
          failure: {
            reason: "OrphanRisk",
            message:
              "a mutation receipt exists without a durable resource handle; automatic create is blocked",
            retryable: false,
          },
          conditions: [
            {
              type: "Ready",
              status: "Unknown",
              observedGeneration: resource.metadata.generation,
              reason: "OrphanRisk",
              message:
                "a mutation receipt exists without a durable resource handle; automatic create is blocked",
              lastTransitionTime: NOW.toISOString(),
            },
          ],
        },
      })
    );
    const port = lifecycle();

    await run(state, port);

    expect(port.create).not.toHaveBeenCalled();
    expect(state.current.status?.failure).toMatchObject({
      reason: "OrphanRisk",
      retryable: false,
    });
  });

  it("escalates a re-asserted generation past an exhausted create retry budget", async () => {
    const resource = workload();
    const exhaustedKey = computeWorkloadIdempotencyKey({
      resource,
      operation: "create",
      ordinal: 0,
    });
    const receipt: ComputeWorkloadAttemptReceipt = {
      key: exhaustedKey,
      operation: "create",
      ordinal: 0,
      outcome: "known_failure",
      leaderEpoch: "7:test-controller",
      retryCount: 2,
      startedAt: NOW.toISOString(),
    };
    const state = new MemoryState(
      workload({
        metadata: {
          ...resource.metadata,
          annotations: {
            [COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]:
              encodeAttemptReceipt(receipt),
          },
        },
        status: {
          phase: "Failed",
          desiredGeneration: resource.metadata.generation,
          attempt: { ...receipt, completedAt: NOW.toISOString() },
          recoveryCount: 0,
          failure: {
            reason: "RetryLimitExceeded",
            message: "known-outcome retry limit was exceeded",
            retryable: false,
          },
          conditions: [],
        },
      })
    );
    const port = lifecycle();

    await run(state, port);

    expect(port.create).toHaveBeenCalledTimes(1);
    // The exhausted budget belongs to the create key; recovery gets its own namespace.
    expect(port.create.mock.calls[0]?.[0].idempotencyKey).not.toBe(
      exhaustedKey
    );
    expect(port.create.mock.calls[0]?.[0].idempotencyKey).toBe(
      computeWorkloadIdempotencyKey({
        resource,
        operation: "recover",
        ordinal: 1,
      })
    );
    expect(state.current.status).toMatchObject({
      phase: "Progressing",
      resource: { id: "lease-42" },
      recoveryCount: 1,
      attempt: { operation: "recover", ordinal: 1, outcome: "succeeded" },
    });
    expect(state.current.status?.failure).toBeUndefined();
  });

  it("bounds handle-less retry-budget escalation at three recovery allocations", async () => {
    const resource = workload();
    const state = new MemoryState(
      workload({
        metadata: {
          ...resource.metadata,
          annotations: {
            [COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]: encodeAttemptReceipt({
              key: computeWorkloadIdempotencyKey({
                resource,
                operation: "create",
                ordinal: 0,
              }),
              operation: "create",
              ordinal: 0,
              outcome: "known_failure",
              leaderEpoch: "7:test-controller",
              retryCount: 2,
              startedAt: NOW.toISOString(),
            }),
          },
        },
        status: {
          phase: "Failed",
          desiredGeneration: resource.metadata.generation,
          attempt: {
            key: computeWorkloadIdempotencyKey({
              resource,
              operation: "create",
              ordinal: 0,
            }),
            operation: "create",
            ordinal: 0,
            outcome: "known_failure",
            retryCount: 2,
            leaderEpoch: "7:test-controller",
            startedAt: NOW.toISOString(),
            completedAt: NOW.toISOString(),
          },
          recoveryCount: 0,
          failure: {
            reason: "RetryLimitExceeded",
            message: "known-outcome retry limit was exceeded",
            retryable: false,
          },
          conditions: [],
        },
      })
    );
    const port = lifecycle();
    // A retryable known failure is exactly what burns a per-key budget in production.
    port.create.mockRejectedValue(
      new ComputeLifecycleError("terminal", "ProviderTransient", true)
    );
    const recordRecoveryLimit = vi.fn();

    for (let pass = 0; pass < 24; pass += 1) {
      await run(state, port, { recordRecoveryLimit });
    }

    const ordinals = new Set(
      port.create.mock.calls.map((call) => call[0].idempotencyKey)
    );
    expect([...ordinals]).toEqual([
      computeWorkloadIdempotencyKey({
        resource,
        operation: "recover",
        ordinal: 1,
      }),
      computeWorkloadIdempotencyKey({
        resource,
        operation: "recover",
        ordinal: 2,
      }),
      computeWorkloadIdempotencyKey({
        resource,
        operation: "recover",
        ordinal: 3,
      }),
    ]);
    expect(state.current.status?.phase).toBe("Failed");
    expect(state.current.status?.failure?.reason).toBe("RecoveryLimitExceeded");
    expect(state.current.status?.recoveryCount).toBe(3);
    expect(recordRecoveryLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryCount: 3,
        outcomeCode: "RecoveryLimitExceeded",
      })
    );

    const createsAtLimit = port.create.mock.calls.length;
    await run(state, port, { recordRecoveryLimit });
    expect(port.create.mock.calls.length).toBe(createsAtLimit);
  });

  it("keeps an exhausted retry budget blocked when the last outcome was not definitive", async () => {
    const resource = workload();
    const receipt: ComputeWorkloadAttemptReceipt = {
      key: computeWorkloadIdempotencyKey({
        resource,
        operation: "create",
        ordinal: 0,
      }),
      operation: "create",
      ordinal: 0,
      outcome: "unknown",
      leaderEpoch: "7:test-controller",
      retryCount: 2,
      startedAt: NOW.toISOString(),
    };
    const state = new MemoryState(
      workload({
        metadata: {
          ...resource.metadata,
          annotations: {
            [COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]:
              encodeAttemptReceipt(receipt),
          },
        },
        status: {
          phase: "Failed",
          desiredGeneration: resource.metadata.generation,
          attempt: { ...receipt, completedAt: NOW.toISOString() },
          recoveryCount: 0,
          failure: {
            reason: "RetryLimitExceeded",
            message: "known-outcome retry limit was exceeded",
            retryable: false,
          },
          conditions: [],
        },
      })
    );
    const port = lifecycle();

    await run(state, port);

    expect(port.create).not.toHaveBeenCalled();
    expect(state.current.status).toMatchObject({
      phase: "Unknown",
      failure: { reason: "OrphanRisk", retryable: false },
    });
  });

  it("retries a definitive recover failure when no resource handle exists", async () => {
    const receipt: ComputeWorkloadAttemptReceipt = {
      key: "recover-known-failure",
      operation: "recover",
      ordinal: 1,
      outcome: "known_failure",
      leaderEpoch: "7:test-controller",
      retryCount: 0,
      startedAt: NOW.toISOString(),
    };
    const state = new MemoryState(
      workload({
        metadata: {
          ...workload().metadata,
          annotations: {
            [COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]:
              encodeAttemptReceipt(receipt),
          },
        },
      })
    );
    const port = lifecycle();

    await run(state, port);

    expect(port.create).toHaveBeenCalledTimes(1);
    expect(state.current.status).toMatchObject({
      resource: { id: "lease-42" },
      recoveryCount: 1,
      attempt: { operation: "recover", outcome: "succeeded" },
    });
  });

  it.each([
    ["create", "unknown"],
    ["create", "prepared"],
    ["create", "allocated"],
    ["update", "known_failure"],
    ["delete", "known_failure"],
  ] as const)("keeps an ambiguous %s/%s receipt behind OrphanRisk", async (operation, outcome) => {
    const receipt: ComputeWorkloadAttemptReceipt = {
      key: `${operation}-${outcome}`,
      operation,
      ordinal: 0,
      outcome,
      leaderEpoch: "7:test-controller",
      retryCount: 0,
      startedAt: NOW.toISOString(),
    };
    const state = new MemoryState(
      workload({
        metadata: {
          ...workload().metadata,
          annotations: {
            [COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]:
              encodeAttemptReceipt(receipt),
          },
        },
      })
    );
    const port = lifecycle();

    await run(state, port);

    expect(port.create).not.toHaveBeenCalled();
    expect(port.update).not.toHaveBeenCalled();
    expect(port.delete).not.toHaveBeenCalled();
    expect(port.recoverCreate).not.toHaveBeenCalled();
    expect(state.current.status).toMatchObject({
      phase: "Unknown",
      failure: { reason: "OrphanRisk", retryable: false },
    });
  });

  it("keeps an undecodable mutation marker behind OrphanRisk", async () => {
    const state = new MemoryState(
      workload({
        metadata: {
          ...workload().metadata,
          annotations: {
            [COMPUTE_WORKLOAD_ATTEMPT_ANNOTATION]: "legacy-marker",
          },
        },
      })
    );
    const port = lifecycle();

    await run(state, port);

    expect(port.create).not.toHaveBeenCalled();
    expect(port.update).not.toHaveBeenCalled();
    expect(port.delete).not.toHaveBeenCalled();
    expect(state.current.status).toMatchObject({
      phase: "Unknown",
      failure: { reason: "OrphanRisk", retryable: false },
    });
  });

  it("fails closed when a required legacy app secret is missing", async () => {
    const state = new MemoryState(workload());
    const port = lifecycle();
    await run(state, port, {
      secretResolver: {
        resolve: vi.fn(async () => {
          const { BILLING_INGEST_TOKEN: _missing, ...incomplete } =
            BOOTABLE_APP_ENV;
          return incomplete;
        }),
      },
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(state.wallet).toBeUndefined();
    expect(state.current.status?.failure?.reason).toBe(
      "SecretReferenceMissing"
    );
  });

  it("updates the known resource in place for a new generation", async () => {
    const state = new MemoryState(
      workload({
        metadata: { ...workload().metadata, generation: 2 },
        status: status(1),
      })
    );
    const port = lifecycle();
    await run(state, port);
    expect(port.update).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "lease-42" })
    );
    expect(port.create).not.toHaveBeenCalled();
  });

  it("does not replay an update with unknown outcome", async () => {
    const state = new MemoryState(
      workload({
        metadata: { ...workload().metadata, generation: 2 },
        status: status(1),
      })
    );
    const port = lifecycle();
    port.update.mockRejectedValueOnce(
      new ComputeLifecycleError(
        "unknown_outcome",
        "ProviderOutcomeUnknown",
        false
      )
    );
    await run(state, port);
    await run(state, port);
    expect(port.update).toHaveBeenCalledTimes(1);
    expect(state.current.status?.phase).toBe("Unknown");
  });

  it("deletes the owner-bound resource before removing its finalizer", async () => {
    const state = new MemoryState(
      workload({
        metadata: {
          ...workload().metadata,
          deletionTimestamp: NOW.toISOString(),
        },
        status: {
          ...status(),
          dns: {
            hostname: "sample-node-test.cognidao.org",
            target: "sample-node.example",
          },
        },
      })
    );
    const port = lifecycle();
    const deps = await run(state, port);
    expect(deps.dns.deleteOwned).toHaveBeenCalledWith({
      hostname: "sample-node-test.cognidao.org",
      expectedTarget: "sample-node.example",
    });
    expect(port.delete).toHaveBeenCalledWith({ resourceId: "lease-42" });
    // closeKnown is durably receipted first; the next level pass observes closed and finalizes.
    port.observe.mockResolvedValueOnce({
      provider: "external",
      leaseId: "lease-42",
      state: "closed",
      endpoints: [],
    });
    await run(state, port, deps);
    expect(state.current.metadata.finalizers).not.toContain(
      COMPUTE_WORKLOAD_FINALIZER
    );
  });

  it("derives private sibling URLs and keeps resolved values outside durable state", async () => {
    const secretValue = "never-persist-this";
    const declared = workload();
    const appService = declared.spec.workload.services[0];
    if (!appService) throw new Error("app fixture missing");
    const state = new MemoryState(
      workload({
        spec: {
          ...declared.spec,
          bundle: {
            ...declared.spec.bundle,
            source: {
              ...declared.spec.bundle.source,
              repository: "cogni-dao/shared-node-runtime",
            },
            artifacts: [
              ...declared.spec.bundle.artifacts,
              {
                name: "echo-sidecar",
                image: IMAGE.replace("sample-node@", "echo-sidecar@"),
              },
            ],
          },
          workload: {
            ...declared.spec.workload,
            name: "sample-node",
            publicHost: "sample-node-test.cognidao.org",
            services: [
              {
                ...appService,
                bindings: { ECHO_SIDECAR_URL: "echo-sidecar" },
                secretRefs: [
                  { key: "AUTH_SECRET" },
                  { key: "DATABASE_URL" },
                  { key: "DATABASE_SERVICE_URL" },
                  { key: "DOLTGRES_URL" },
                  { key: "LITELLM_VIRTUAL_KEY" },
                  { key: "SCHEDULER_API_TOKEN" },
                  { key: "BILLING_INGEST_TOKEN" },
                ],
              },
              {
                name: "echo-sidecar",
                artifact: "echo-sidecar",
                port: 9100,
                visibility: "private",
                bindings: {},
                bindHost: "0.0.0.0",
                cpuUnits: 0.5,
                memoryMi: 512,
                storageMi: 1024,
              },
            ],
          },
        },
      })
    );
    const port = lifecycle();
    const resolver = {
      resolve: vi.fn(
        async (input: { serviceName: string; nodeSlug: string }) =>
          input.serviceName === "app"
            ? {
                AUTH_SECRET: secretValue,
                DATABASE_URL: "postgresql://app@candidate.vm.example/app",
                DATABASE_SERVICE_URL:
                  "postgresql://service@candidate.vm.example/app",
                DOLTGRES_URL: "postgresql://app@candidate.vm.example/knowledge",
                LITELLM_VIRTUAL_KEY: "sk-virtual",
                SCHEDULER_API_TOKEN: "scheduler-token",
                BILLING_INGEST_TOKEN: "billing-token",
              }
            : {}
      ),
    };
    await run(state, port, { secretResolver: resolver });
    const spec = port.create.mock.calls[0]?.[0].spec;
    expect(spec.services[0]?.env).toMatchObject({
      HOST: "0.0.0.0",
      ECHO_SIDECAR_URL: "http://echo-sidecar:9100",
      AUTH_SECRET: secretValue,
      DOLTGRES_URL: "postgresql://app@candidate.vm.example/knowledge",
      NODE_NAME: "sample-node",
      COGNI_REPO_PATH: "/app",
      NEXTAUTH_URL: "https://sample-node-test.cognidao.org",
      APP_BASE_URL: "https://sample-node-test.cognidao.org",
      TEMPORAL_ADDRESS: "candidate.vm.example:7233",
      LITELLM_BASE_URL: "http://candidate.vm.example:4000",
    });
    expect(spec.services[1]?.env).not.toHaveProperty("NODE_NAME");
    expect(spec.services[1]?.expose).toEqual([
      { port: 9100, as: 9100, global: false },
    ]);
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ nodeSlug: "sample-node" })
    );
    expect(JSON.stringify(state.current)).not.toContain(secretValue);
    expect(JSON.stringify(state.events)).not.toContain(secretValue);
  });

  it("does not infer Cogni compatibility behavior from a generic service named app", async () => {
    const declared = workload();
    const app = declared.spec.workload.services[0];
    if (!app) throw new Error("app fixture missing");
    const { runtimeProfile: _profile, ...genericApp } = app;
    const state = new MemoryState(
      workload({
        spec: {
          ...declared.spec,
          workload: {
            ...declared.spec.workload,
            services: [{ ...genericApp, secretRefs: [] }],
          },
        },
      })
    );
    const port = lifecycle();

    await run(state, port, {
      secretResolver: { resolve: vi.fn(async () => ({})) },
    });

    expect(port.create).toHaveBeenCalledTimes(1);
    expect(port.create.mock.calls[0]?.[0].spec.services[0]?.env).toEqual({
      HOST: "0.0.0.0",
      HOSTNAME: "0.0.0.0",
      PORT: "3000",
    });
  });

  it("rejects a sibling public hostname before provider or DNS writes", async () => {
    const declared = workload();
    const state = new MemoryState(
      workload({
        spec: {
          ...declared.spec,
          workload: {
            ...declared.spec.workload,
            publicHost: "operator-test.cognidao.org",
          },
        },
      })
    );
    const port = lifecycle();
    const dns = {
      reconcile: vi.fn<ComputeWorkloadDnsPort["reconcile"]>(async () => {}),
      deleteOwned: vi.fn<ComputeWorkloadDnsPort["deleteOwned"]>(
        async () => "deleted" as const
      ),
    };

    await run(state, port, { dns });

    expect(state.current.status?.failure?.reason).toBe(
      "PublicHostOwnershipMismatch"
    );
    expect(port.create).not.toHaveBeenCalled();
    expect(port.update).not.toHaveBeenCalled();
    expect(port.delete).not.toHaveBeenCalled();
    expect(dns.reconcile).not.toHaveBeenCalled();
    expect(dns.deleteOwned).not.toHaveBeenCalled();
  });

  it("rejects ownership drift before provider IO", async () => {
    const state = new MemoryState(
      workload({ metadata: { ...workload().metadata, name: "wrong" } })
    );
    const port = lifecycle();
    await run(state, port);
    expect(state.current.status?.failure?.reason).toBe("OwnershipMismatch");
    expect(port.create).not.toHaveBeenCalled();
  });
});
