// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/checkSharedTemporalHealth`
 * Purpose: Compose the current node's read-only shared Temporal diagnostic.
 * Scope: Resolves node/env identity, invokes the adapter, and records low-cardinality metrics.
 * Invariants: Uses the same per-node task queue derivation as application workflow clients.
 * Side-effects: IO (Temporal, scheduler-worker HTTP, Prometheus metrics)
 * Links: task.5238, docs/spec/temporal-patterns.md
 * @public
 */

import {
  inspectSharedTemporalHealth,
  type SharedTemporalHealth,
} from "@/adapters/server";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env/server-env";
import {
  temporalSubstrateCheckDurationMs,
  temporalSubstrateChecksTotal,
  temporalSubstrateLastSuccessTimestampSeconds,
  temporalSubstratePollerFresh,
} from "@/shared/observability/server/metrics";

export async function checkSharedTemporalHealth(): Promise<SharedTemporalHealth> {
  const env = serverEnv();
  const nodeId = getNodeId();
  const result = await inspectSharedTemporalHealth({
    nodeId,
    temporalAddress: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: `${env.TEMPORAL_TASK_QUEUE}-${nodeId}`,
    schedulerWorkerHealthUrl: env.SCHEDULER_WORKER_HEALTH_URL,
    app: {
      // These are the exact sources returned by GET /version.
      // biome-ignore lint/style/noProcessEnv: build-time package identity
      version: process.env.npm_package_version || "unknown",
      buildSha: env.APP_BUILD_SHA || "unknown",
      // biome-ignore lint/style/noProcessEnv: build-time image identity
      buildTime: process.env.BUILD_TIME || null,
    },
  });

  const metricLabels = { result: result.status, reason: result.reason };
  temporalSubstrateChecksTotal.labels(metricLabels).inc();
  temporalSubstrateCheckDurationMs
    .labels(metricLabels)
    .observe(result.durationMs);
  temporalSubstratePollerFresh
    .labels({ task_type: "workflow" })
    .set(result.pollers.workflow.status === "fresh" ? 1 : 0);
  temporalSubstratePollerFresh
    .labels({ task_type: "activity" })
    .set(result.pollers.activity.status === "fresh" ? 1 : 0);
  if (result.status === "healthy") {
    temporalSubstrateLastSuccessTimestampSeconds.set(Date.now() / 1_000);
  }

  return result;
}
