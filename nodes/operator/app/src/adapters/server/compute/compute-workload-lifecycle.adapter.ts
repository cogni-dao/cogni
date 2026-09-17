// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type {
  ComputeResourcePort,
  ProvisionOutput,
  ProvisionSpec,
} from "@cogni/ai-tools";
import {
  ComputeLifecycleError,
  type ComputeWorkloadLifecyclePort,
} from "@/ports";

import {
  type AkashAllocationProbe,
  AkashComputeError,
} from "./akash-compute.adapter";
import { safeReadyzProbe, safeVersionProbe } from "./safe-version-probe";

interface UpdatableComputeResourcePort extends ComputeResourcePort {
  allocationCursor?(): Promise<string>;
  findAllocationSince?(cursor: string): Promise<AkashAllocationProbe>;
  provisionWithAllocation?(
    input: {
      env: string;
      spec: ProvisionSpec;
      expectedSourceSha: string;
      idempotencyKey: string;
    },
    onAllocated: (resource: ProvisionOutput) => Promise<void>
  ): Promise<ProvisionOutput>;
  update?(input: {
    resourceId: string;
    env: string;
    spec: ProvisionSpec;
    expectedSourceSha: string;
    idempotencyKey: string;
  }): Promise<ProvisionOutput>;
}

function mapError(error: unknown, mutating: boolean): ComputeLifecycleError {
  if (error instanceof ComputeLifecycleError) return error;
  if (error instanceof AkashComputeError) {
    if (error.code === "HTTP_ERROR" && error.httpStatus === 404) {
      return new ComputeLifecycleError("not_found", "ProviderNotFound", false);
    }
    if (error.code === "TIMEOUT" || error.code === "NETWORK_ERROR") {
      return new ComputeLifecycleError(
        mutating ? "unknown_outcome" : "transient",
        mutating ? "ProviderOutcomeUnknown" : "ProviderTransient",
        !mutating
      );
    }
    if (error.code === "AMBIGUOUS_ADOPTION") {
      return new ComputeLifecycleError(
        "unknown_outcome",
        "ProviderOutcomeUnknown",
        false
      );
    }
    if (error.code === "BOOT_SLO_TIMEOUT" && error.bootFailureStage) {
      const reason = {
        no_endpoint: "BootEndpointUnavailable",
        status_unavailable: "BootStatusUnavailable",
        version_unavailable: "BootVersionUnavailable",
        source_mismatch: "BootSourceMismatch",
        readiness_unavailable: "BootReadinessUnavailable",
      } as const;
      const retryable =
        error.bootFailureStage !== "source_mismatch" &&
        error.bootFailureStage !== "readiness_unavailable";
      return new ComputeLifecycleError(
        retryable ? "transient" : "terminal",
        reason[error.bootFailureStage],
        retryable
      );
    }
    const retryable =
      error.code === "NO_BIDS" || error.code === "NO_ELIGIBLE_BIDS";
    return new ComputeLifecycleError(
      retryable ? "transient" : "terminal",
      retryable ? "ProviderTransient" : "ProviderRejected",
      retryable
    );
  }
  return new ComputeLifecycleError(
    mutating ? "unknown_outcome" : "transient",
    mutating ? "ProviderOutcomeUnknown" : "ProviderTransient",
    !mutating
  );
}

/** Adapts the existing compute capability into the controller's lifecycle contract. */
export class ComputeWorkloadLifecycleAdapter
  implements ComputeWorkloadLifecyclePort
{
  private createQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly compute: UpdatableComputeResourcePort,
    private readonly fetchImpl?: typeof fetch
  ) {}

  async observe(input: { resourceId: string }): Promise<ProvisionOutput> {
    if (!this.compute.status) {
      throw new ComputeLifecycleError("terminal", "ProviderRejected", false);
    }
    try {
      return await this.compute.status({ leaseId: input.resourceId });
    } catch (error) {
      throw mapError(error, false);
    }
  }

  async create(input: {
    environment: string;
    spec: ProvisionSpec;
    expectedSourceSha: string;
    idempotencyKey: string;
    onPrepared(allocationCursor: string): Promise<void>;
    onAllocated(resource: ProvisionOutput): Promise<void>;
  }): Promise<ProvisionOutput> {
    if (
      !this.compute.provisionWithAllocation ||
      !this.compute.allocationCursor
    ) {
      throw new ComputeLifecycleError("terminal", "ProviderRejected", false);
    }
    const run = this.createQueue.then(async () => {
      try {
        const cursor = await this.compute.allocationCursor?.();
        if (cursor === undefined) {
          throw new ComputeLifecycleError(
            "terminal",
            "ProviderRejected",
            false
          );
        }
        await input.onPrepared(cursor);
        return await this.compute.provisionWithAllocation?.(
          {
            env: input.environment,
            spec: input.spec,
            expectedSourceSha: input.expectedSourceSha,
            idempotencyKey: input.idempotencyKey,
          },
          input.onAllocated
        );
      } catch (error) {
        throw mapError(error, true);
      }
    });
    this.createQueue = run.then(
      () => undefined,
      () => undefined
    );
    const output = await run;
    if (!output) {
      throw new ComputeLifecycleError("terminal", "ProviderRejected", false);
    }
    return output;
  }

  async recoverCreate(input: {
    allocationCursor: string;
  }): Promise<ProvisionOutput | null> {
    if (!this.compute.findAllocationSince) {
      throw new ComputeLifecycleError("terminal", "ProviderRejected", false);
    }
    try {
      const probe = await this.compute.findAllocationSince(
        input.allocationCursor
      );
      if (probe.outcome === "adopted") return probe.output;
      if (probe.outcome === "settled") return null;
      // The probe now REPORTS ambiguity instead of throwing it; the retired legacy lane keeps
      // its original fail-closed contract by raising the same error it always saw.
      throw new AkashComputeError(
        "AMBIGUOUS_ADOPTION",
        "multiple post-baseline deployments prevent deterministic adoption"
      );
    } catch (error) {
      throw mapError(error, false);
    }
  }

  async update(input: {
    resourceId: string;
    environment: string;
    spec: ProvisionSpec;
    expectedSourceSha: string;
    idempotencyKey: string;
  }): Promise<ProvisionOutput> {
    if (!this.compute.update) {
      throw new ComputeLifecycleError("terminal", "ProviderRejected", false);
    }
    try {
      return await this.compute.update({
        resourceId: input.resourceId,
        env: input.environment,
        spec: input.spec,
        expectedSourceSha: input.expectedSourceSha,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      throw mapError(error, true);
    }
  }

  async delete(input: { resourceId: string }): Promise<void> {
    if (!this.compute.release) {
      throw new ComputeLifecycleError("terminal", "ProviderRejected", false);
    }
    try {
      await this.compute.release({ leaseId: input.resourceId });
    } catch (error) {
      const mapped = mapError(error, true);
      if (mapped.kind !== "not_found") throw mapped;
    }
  }

  async verifySource(input: {
    endpoints: readonly string[];
    expectedSourceSha: string;
  }): Promise<boolean> {
    for (const endpoint of input.endpoints) {
      if (!this.fetchImpl) {
        if (
          (await safeVersionProbe(endpoint, input.expectedSourceSha)) &&
          (await safeReadyzProbe(endpoint))
        )
          return true;
        continue;
      }
      const base = endpoint.startsWith("http")
        ? endpoint
        : `http://${endpoint}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await this.fetchImpl(
          `${base.replace(/\/$/, "")}/version`,
          { signal: controller.signal }
        );
        if (!response.ok) continue;
        const version = (await response.json()) as { buildSha?: unknown };
        if (version.buildSha !== input.expectedSourceSha) continue;
        const ready = await this.fetchImpl(
          `${base.replace(/\/$/, "")}/readyz`,
          { signal: controller.signal }
        );
        if (ready.ok) return true;
      } catch {
        // A probe is recomputable observed state; the next reconcile retries.
      } finally {
        clearTimeout(timeout);
      }
    }
    return false;
  }
}

/** Healthy dormant runtime used when the catalog-optional provider credential is absent. */
export class DormantComputeWorkloadLifecycleAdapter
  implements ComputeWorkloadLifecyclePort
{
  private unavailable(): never {
    throw new ComputeLifecycleError(
      "terminal",
      "ProviderCredentialMissing",
      false
    );
  }

  observe(): Promise<ProvisionOutput> {
    return this.unavailable();
  }
  create(): Promise<ProvisionOutput> {
    return this.unavailable();
  }
  recoverCreate(): Promise<ProvisionOutput | null> {
    return this.unavailable();
  }
  update(): Promise<ProvisionOutput> {
    return this.unavailable();
  }
  delete(): Promise<void> {
    return this.unavailable();
  }
  verifySource(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
