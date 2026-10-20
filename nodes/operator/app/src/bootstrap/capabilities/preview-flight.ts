// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/preview-flight`
 * Purpose: Wire the explicitly enabled TEST preview pilot without a provider credential.
 * Scope: Existing App Git writes, operator-local admission and read-only cluster observations; does not hold a wallet bearer.
 * Invariants: Server-owned ready generations cannot be reused; absent configuration fails closed.
 * Side-effects: IO (deferred port calls; optional kubeconfig read)
 * Links: features/compute/preview-flight.ts, jobs/definitions/preview-retirement.job.ts
 * @internal
 */
import {
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";
import { z } from "zod";
import {
  DrizzleAkashTxAllocationLedger,
  GhcrNodeBundleReader,
  KubernetesPreviewCleanupObserver,
} from "@/adapters/server";
import { resolveServiceDb } from "@/bootstrap/container";
import { createNodeProber } from "@/bootstrap/node-flight.factory";
import { accountWalletScope } from "@/features/compute/akash-tx/akash-tx-wallet";
import { previewComputeWorkloadName } from "@/features/compute/compute-workload-manifest";
import {
  PreviewFlight,
  previewDeploymentId,
} from "@/features/compute/preview-flight";
import type { PreviewFlightPort } from "@/ports";
import { PreviewFlightError } from "@/ports";
import { type ServerEnv, serverEnv } from "@/shared/env/server-env";
import { createOperatorDeployPlane } from "./operator-deploy-plane";

let instance: PreviewFlightPort | undefined;
let retirementInstance: PreviewFlightPort | undefined;
/** Nonsecret metadata is written by trusted operations only AFTER native fenced reset proof. */
export function parsePreviewReadyGenerations(
  value: string | undefined
): Readonly<{ 0: string; 1: string }> {
  if (!value)
    throw new PreviewFlightError(
      "unavailable",
      "preview state-pair preparation metadata is missing"
    );
  const result = z
    .object({ "0": z.string().uuid(), "1": z.string().uuid() })
    .strict()
    .parse(JSON.parse(value));
  if (result[0] === result[1])
    throw new PreviewFlightError(
      "unavailable",
      "preview pairs cannot share a reset generation"
    );
  return result;
}
export function createPreviewFlight(
  env: ServerEnv = serverEnv(),
  retirementOnly = false
): PreviewFlightPort {
  if (!retirementOnly && env.PREVIEW_FLIGHTS_ENABLED !== "true")
    throw new PreviewFlightError("disabled", "build previews are not enabled");
  if (retirementOnly && retirementInstance) return retirementInstance;
  if (!retirementOnly && instance) return instance;
  if (
    env.NODE_SUBMODULE_PARENT_OWNER?.toLowerCase() !== "cogni-test-org" ||
    !env.NODE_SUBMODULE_PARENT_REPO ||
    !env.AKASH_ACTUATOR_ACCOUNT_ID ||
    (!retirementOnly &&
      (!env.PREVIEW_DNS_ZONE_ID || !env.PREVIEW_SUBSTRATE_HOST))
  )
    throw new PreviewFlightError(
      "unavailable",
      "TEST preview control configuration is incomplete"
    );
  if (!retirementOnly)
    z.string()
      .regex(/^[0-9a-f]{32}$/)
      .parse(env.PREVIEW_DNS_ZONE_ID);
  const ready = retirementOnly
    ? undefined
    : parsePreviewReadyGenerations(env.PREVIEW_READY_STATE_GENERATIONS);
  const ledger = new DrizzleAkashTxAllocationLedger(
    async () => resolveServiceDb(),
    accountWalletScope(env.AKASH_ACTUATOR_ACCOUNT_ID)
  );
  const admission = ledger.preview;
  const plane = createOperatorDeployPlane(env);
  const parent = {
    parentOwner: env.NODE_SUBMODULE_PARENT_OWNER,
    parentRepo: env.NODE_SUBMODULE_PARENT_REPO,
  };
  if (
    !plane.readPreviewSource ||
    !plane.writePreviewDesiredState ||
    !plane.previewDesiredStateAbsent
  )
    throw new PreviewFlightError(
      "unavailable",
      "preview Git capability is unavailable"
    );
  const kube = new KubeConfig();
  if (env.PREVIEW_KUBECONFIG) kube.loadFromFile(env.PREVIEW_KUBECONFIG);
  else kube.loadFromCluster();
  const cleanup = new KubernetesPreviewCleanupObserver(
    kube.makeApiClient(CustomObjectsApi),
    kube.makeApiClient(BatchV1Api),
    kube.makeApiClient(CoreV1Api),
    previewComputeWorkloadName
  );
  const prober = createNodeProber();
  const service = new PreviewFlight({
    admission,
    sources: {
      read: (input) =>
        plane.readPreviewSource?.({ ...parent, ...input }) ??
        Promise.reject(new Error("preview_source_unavailable")),
    },
    bundles: new GhcrNodeBundleReader(),
    git: {
      publish: (input) =>
        plane.writePreviewDesiredState?.({ ...parent, ...input }) ??
        Promise.reject(new Error("preview_git_unavailable")),
      remove: (deploymentId) =>
        plane.writePreviewDesiredState?.({ ...parent, deploymentId }) ??
        Promise.reject(new Error("preview_git_unavailable")),
      absent: (deploymentId) =>
        plane.previewDesiredStateAbsent?.({ ...parent, deploymentId }) ??
        Promise.resolve(false),
    },
    state: {
      prepare: async ({ stateSlot }) => {
        if (!ready)
          throw new PreviewFlightError(
            "disabled",
            "preview admission disabled"
          );
        return { resetGeneration: ready[stateSlot] };
      },
    },
    cleanup,
    registerExpiry: async () => {
      const { registerScheduledJob } = await import(
        "@/bootstrap/jobs/scheduledJobs"
      );
      const schedule = await registerScheduledJob("preview-retirement");
      if (!schedule.enabled)
        throw new PreviewFlightError(
          "unavailable",
          "preview retirement schedule is paused"
        );
    },
    serving: async (url, sha) => {
      try {
        const result = await prober.serving(new URL(url).host);
        return result.status === "pass" && result.buildSha === sha;
      } catch {
        return false;
      }
    },
    dnsZoneId: env.PREVIEW_DNS_ZONE_ID ?? "0".repeat(32),
    substrateHost: env.PREVIEW_SUBSTRATE_HOST ?? "retirement.invalid",
    now: () => new Date(),
  });
  if (retirementOnly) retirementInstance = service;
  else instance = service;
  return service;
}
export { previewDeploymentId };
