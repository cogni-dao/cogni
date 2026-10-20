// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/preview-flight`
 * Purpose: Publish one explicitly requested immutable TEST build through existing GitOps.
 * Scope: Bounded admission, publication and retirement passes; does not create provider leases.
 * Invariants: Stable request identity; retirement fences publication before sibling-preserving removal.
 * Side-effects: IO (injected ports only)
 * Links: compute-workload-manifest.ts, ports/preview-flight.port.ts, akash-tx/akash-tx-actuator.ts
 * @internal
 */
import { createHash } from "node:crypto";
import {
  parseRepoSpec,
  resolveNodeArtifactBundle,
  resolveNodeArtifactBundleForEnvironment,
} from "@cogni/repo-spec";
import { parse as parseYaml, stringify } from "yaml";
import type {
  AkashPreviewAdmission,
  AkashPreviewAdmissionPort,
  NodeBundleReaderPort,
  PreviewCleanupObserverPort,
  PreviewFlightPort,
  PreviewFlightRequest,
  PreviewFlightStatus,
  PreviewGitPort,
  PreviewSourcePort,
  PreviewStatePairPort,
} from "@/ports";
import { PreviewFlightError } from "@/ports";
import {
  buildComputeWorkloadManifest,
  previewComputePublicHost,
  previewComputeWorkloadDirectory,
  resolveNodeDatabasePoolLimits,
} from "./compute-workload-manifest";
import { buildComputeSecretResources } from "./compute-workload-secret-manifests";
import { resolveNodeRequiredPlacement } from "./node-required-placement";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Caller carries requestKey before its first dispatch; lost HTTP responses reuse this identity. */
export function previewDeploymentId(
  nodeId: string,
  requestKey: string
): string {
  const bytes = createHash("sha256")
    .update(`cogni-test-preview:${nodeId}:${requestKey}`)
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export interface PreviewFlightDeps {
  readonly admission: AkashPreviewAdmissionPort;
  readonly sources: PreviewSourcePort;
  readonly bundles: NodeBundleReaderPort;
  readonly git: PreviewGitPort;
  readonly state: PreviewStatePairPort;
  readonly cleanup: PreviewCleanupObserverPort;
  readonly registerExpiry: () => Promise<void>;
  readonly serving: (url: string, sourceSha: string) => Promise<boolean>;
  readonly dnsZoneId: string;
  readonly substrateHost: string;
  readonly now: () => Date;
}
/** TEST-only trusted pilot. Existing flight behavior remains outside this opt-in service. */
export class PreviewFlight implements PreviewFlightPort {
  constructor(private readonly deps: PreviewFlightDeps) {}
  async request(input: PreviewFlightRequest) {
    return this.prepareRequest(input, false);
  }
  async cancelRequest(input: PreviewFlightRequest) {
    return this.prepareRequest(input, true);
  }
  private async prepareRequest(
    input: PreviewFlightRequest,
    cancel: boolean
  ): Promise<PreviewFlightStatus> {
    if (
      input.slug !== "spawny-boi" ||
      !/^[0-9a-f]{40}$/.test(input.sourceSha) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestKey)
    )
      throw new PreviewFlightError(
        "invalid_request",
        "preview request is not allowlisted"
      );
    const ttl = input.ttlSeconds ?? 7200;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 7200)
      throw new PreviewFlightError(
        "invalid_request",
        "preview lifetime must be 30–7200 seconds"
      );
    const deploymentId = previewDeploymentId(input.nodeId, input.requestKey);
    const previous = await this.deps.admission.read(deploymentId);
    if (previous && previous.sourceSha !== input.sourceSha)
      throw new PreviewFlightError(
        "conflict",
        "requestKey already binds another source SHA"
      );
    if (cancel && previous)
      return this.release({ nodeId: input.nodeId, deploymentId });
    const source = await this.deps.sources.read(input);
    if (
      source.sourceRepo.toLowerCase() !==
        "https://github.com/cogni-test-org/spawny-boi" ||
      source.imageRepository !== "ghcr.io/cogni-test-org/spawny-boi"
    )
      throw new PreviewFlightError(
        "invalid_request",
        "preview source is outside the TEST boundary"
      );
    const spec = parseRepoSpec(source.repoSpecText);
    const artifact = await this.deps.bundles.read({
      repository: source.imageRepository,
      sourceSha: input.sourceSha,
    });
    const bundle = resolveNodeArtifactBundle(spec, artifact.payload, {
      repository: "cogni-test-org/spawny-boi",
      sourceSha: input.sourceSha,
    });
    if (bundle.nodeId !== input.nodeId)
      throw new PreviewFlightError(
        "invalid_request",
        "preview node identity mismatch"
      );
    const enabled = resolveNodeArtifactBundleForEnvironment(
      bundle,
      "candidate-a"
    );
    const app = enabled.services[0];
    if (
      enabled.services.length !== 1 ||
      !app ||
      app.service.name !== "app" ||
      app.service.runtimeProfile !== "cogni-node-app-v1" ||
      app.service.resources.cpuUnits > 2 ||
      app.service.resources.memoryMi > 2048 ||
      app.service.resources.storageMi > 4096
    )
      throw new PreviewFlightError(
        "invalid_request",
        "preview requires one app within 2 CPU, 2048Mi memory and 4096Mi storage"
      );
    const publicHost = previewComputePublicHost(input.nodeId, deploymentId);
    const payloadHash = hash({
      nodeId: input.nodeId,
      slug: input.slug,
      sourceSha: input.sourceSha,
      requestKey: input.requestKey,
      ttl,
      bundleRef: artifact.bundleRef,
      artifactRef: app.image,
      repoSpecHash: hash(source.repoSpecText),
      catalogHash: hash(source.catalogText),
      publicHost,
      dnsZoneId: this.deps.dnsZoneId,
      substrateHost: this.deps.substrateHost,
    });
    // A durable, repeating existing Temporal job exists BEFORE any desired state can rent compute.
    await this.deps.registerExpiry();
    let admission = await this.deps.admission[cancel ? "cancel" : "admit"]({
      deploymentId,
      nodeId: input.nodeId,
      environment: "candidate-a",
      requestKey: input.requestKey,
      payloadHash,
      sourceSha: input.sourceSha,
      artifactRef: app.image,
      bundleRef: artifact.bundleRef,
      expiresAt:
        previous?.expiresAt ?? new Date(this.deps.now().getTime() + ttl * 1000),
    });
    if (cancel) {
      await this.deps.git.remove(deploymentId);
      await this.tryFinish(deploymentId);
      return this.render(
        (await this.deps.admission.read(deploymentId)) ?? admission
      );
    }
    if (admission.revokedAt || admission.closureObservedAt)
      return this.render(admission);
    if (!admission.resetGeneration) {
      await this.deps.admission.withUnallocatedStateReservation(
        deploymentId,
        admission.stateSlot,
        () =>
          this.deps.state.prepare({
            deploymentId,
            stateSlot: admission.stateSlot,
          })
      );
      admission = (await this.deps.admission.read(deploymentId)) ?? admission;
    }
    if (!admission.resetGeneration)
      throw new PreviewFlightError(
        "unavailable",
        "preview pair generation is not prepared"
      );
    const catalog: unknown = parseYaml(source.catalogText);
    // Disposable A/B apps share existing role caps. Each app opens at most one
    // connection per existing pool; ordinary deployments retain catalog defaults.
    resolveNodeDatabasePoolLimits({ catalog, environment: "candidate-a" });
    const databasePoolLimits = {
      replicaCount: 1 as const,
      app: 1,
      service: 1,
      read: 1,
    };
    const manifest = buildComputeWorkloadManifest({
      slug: input.slug,
      environment: "candidate-a",
      bundleRef: artifact.bundleRef,
      bundle,
      publicHost,
      computeApi: "crossplane",
      leaseGeneration: 0,
      bootRecovery: "hold",
      requiredPlacementCountries: resolveNodeRequiredPlacement({
        catalog,
        environment: "candidate-a",
      }),
      dns: { provider: "cloudflare", zoneId: this.deps.dnsZoneId },
      runtime: {
        substrateHost: this.deps.substrateHost,
        ...(databasePoolLimits ? { databasePoolLimits } : {}),
      },
      preview: {
        deploymentId,
        stateSlot: admission.stateSlot,
        resetGeneration: admission.resetGeneration,
      },
    });
    const resources = buildComputeSecretResources({
      slug: input.slug,
      environment: "candidate-a",
      previewStateSlot: admission.stateSlot,
      secretRefs: manifest.spec.workload.services.flatMap(
        (s) => s.secretRefs ?? []
      ),
    });
    const directory = previewComputeWorkloadDirectory(deploymentId);
    const files = [
      {
        path: `${directory}/xcomputeworkload.yaml`,
        content: stringify(manifest),
      },
      ...resources.map((resource) => ({
        path: `infra/k8s/preview-deployments/candidate-a/state-${admission.stateSlot}/${resource.file}`,
        content: stringify(resource.manifest),
      })),
    ];
    await this.deps.admission.withActiveState(
      {
        deploymentId,
        stateSlot: admission.stateSlot,
        resetGeneration: admission.resetGeneration,
      },
      () => this.deps.git.publish({ deploymentId, files })
    );
    return this.render(admission);
  }
  async status(input: { nodeId: string; deploymentId: string }) {
    const admission = await this.owned(input);
    return this.render(admission);
  }
  async release(input: { nodeId: string; deploymentId: string }) {
    const admission = await this.owned(input);
    if (admission.closureObservedAt) return this.render(admission);
    await this.deps.admission.revoke(input.deploymentId);
    // Even absence must advance HEAD: a timed-out older publication cannot fast-forward it later.
    await this.deps.git.remove(input.deploymentId);
    await this.tryFinish(input.deploymentId);
    return this.render(
      (await this.deps.admission.read(input.deploymentId)) ?? admission
    );
  }
  async sweep() {
    const failures: unknown[] = [];
    for (const admission of await this.deps.admission.listDue()) {
      try {
        await this.release({
          nodeId: admission.nodeId,
          deploymentId: admission.deploymentId,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new PreviewFlightError(
        "unavailable",
        "preview retirement remains pending"
      );
  }
  private async owned(input: { nodeId: string; deploymentId: string }) {
    const row = await this.deps.admission.read(input.deploymentId);
    if (!row || row.nodeId !== input.nodeId)
      throw new PreviewFlightError("not_found", "preview not found");
    return row;
  }
  private async tryFinish(deploymentId: string) {
    const admission = await this.deps.admission.read(deploymentId);
    if (!admission?.revokedAt) return;
    if (
      !(await this.deps.git.absent(deploymentId)) ||
      !(await this.deps.cleanup.absent({
        deploymentId,
        nodeId: admission.nodeId,
        bundleRef: admission.bundleRef,
        ...(admission.resetGeneration
          ? { resetGeneration: admission.resetGeneration }
          : {}),
      }))
    )
      return;
    const receipts = await this.deps.admission.receipts(deploymentId);
    // Preview `released` is written ONLY after the private actuator positively observes closed.
    if (
      receipts.some((r) =>
        r.externalName
          ? r.state !== "released"
          : Boolean(r.previewSubmittedAt) || r.state !== "failed"
      )
    )
      return;
    await this.deps.admission.finishRetirement({
      deploymentId,
      observedClosedReceiptIds: receipts
        .filter((r) => r.externalName && r.state === "released")
        .map((r) => r.receiptId),
    });
  }
  private async render(
    row: AkashPreviewAdmission
  ): Promise<PreviewFlightStatus> {
    const url = `https://${previewComputePublicHost(row.nodeId, row.deploymentId)}`;
    const state = row.closureObservedAt
      ? "closed"
      : row.revokedAt
        ? "retiring"
        : (await this.deps.serving(url, row.sourceSha))
          ? "running"
          : "pending";
    return {
      deploymentId: row.deploymentId,
      nodeId: row.nodeId,
      sourceSha: row.sourceSha,
      url,
      expiresAt: row.expiresAt.toISOString(),
      state,
    };
  }
}
