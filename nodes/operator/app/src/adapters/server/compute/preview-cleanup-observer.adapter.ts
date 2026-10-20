// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/preview-cleanup-observer.adapter`
 * Purpose: Prove per-admission Kubernetes resources are absent before state-pair reuse.
 * Scope: Read-only TEST namespace observations; does not read secrets or delete pool projections.
 * Invariants: Truncated/unreadable lists are unknown; sibling and shared-pool resources are excluded.
 * Side-effects: IO (Kubernetes GET/list)
 * Links: ports/preview-flight.port.ts, kubernetes-migration-job.adapter.ts
 * @internal
 */
import type {
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
} from "@kubernetes/client-node";
import type { PreviewCleanupObserverPort } from "@/ports";
import { migrationJobName } from "./kubernetes-migration-job.adapter";

export class KubernetesPreviewCleanupObserver
  implements PreviewCleanupObserverPort
{
  constructor(
    private readonly custom: CustomObjectsApi,
    private readonly batch: BatchV1Api,
    private readonly pods: CoreV1Api,
    private readonly workloadName: (
      nodeId: string,
      deploymentId: string
    ) => string
  ) {}
  async absent(input: {
    deploymentId: string;
    nodeId: string;
    bundleRef: string;
    resetGeneration?: string;
  }) {
    try {
      const namespace = "cogni-candidate-a",
        name = this.workloadName(input.nodeId, input.deploymentId);
      try {
        await this.custom.getNamespacedCustomObject(
          "compute.cogni.io",
          "v1alpha1",
          namespace,
          "xcomputeworkloads",
          name
        );
        return false;
      } catch (error) {
        const failure = error as {
          statusCode?: number;
          response?: { statusCode?: number };
        };
        if ((failure.statusCode ?? failure.response?.statusCode) !== 404)
          return false;
      }
      const requests = await this.custom.listNamespacedCustomObject(
        "http.m.crossplane.io",
        "v1alpha2",
        namespace,
        "requests",
        undefined,
        undefined,
        undefined,
        undefined,
        `crossplane.io/composite=${name}`
      );
      for (const response of [requests]) {
        const body = response.body as {
          items?: unknown[];
          metadata?: { continue?: string };
        };
        if (
          !Array.isArray(body.items) ||
          body.items.length ||
          body.metadata?.continue
        )
          return false;
      }
      if (!input.resetGeneration) return true;
      const digest = input.bundleRef.split("@")[1];
      if (!digest) return false;
      const job = migrationJobName("spawny-boi", digest, input.resetGeneration);
      const jobs = await this.batch.listNamespacedJob(
        namespace,
        undefined,
        undefined,
        undefined,
        `metadata.name=${job}`
      );
      const pods = await this.pods.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `job-name=${job}`
      );
      if (!Array.isArray(jobs.body.items) || !Array.isArray(pods.body.items))
        return false;
      return !(
        jobs.body.metadata?._continue ||
        pods.body.metadata?._continue ||
        (jobs.body.items ?? []).length ||
        (pods.body.items ?? []).length
      );
    } catch {
      return false;
    }
  }
}
