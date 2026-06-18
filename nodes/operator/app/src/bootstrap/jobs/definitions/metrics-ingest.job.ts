// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/definitions/metrics-ingest.job`
 * Purpose: The canonical worked example of the `defineScheduledJob` node-dev API —
 *   the ENTIRE surface a node dev writes for recurring work. No route, no auth check,
 *   no idempotency check, no createSchedule call, no NodeTaskWorkflow, no queue, no
 *   HTTP. node-template + forks inherit the scaffold and copy a file like this.
 * Scope: One job definition; the work goes inline in `run`. Lives in bootstrap so the
 *   inline body may reach the container (ports / graph executor) via `ctx.deps`.
 * Invariants:
 *   - SINGLE_FUNCTION: a node dev touches ONLY this file shape to add recurring work.
 *   - AI_VIA_GRAPH_EXECUTOR: any AI work in `run` goes through ctx.deps (the existing
 *     graph executor / container), never workflow code.
 * Side-effects: registers the job in the in-process registry at import time.
 * Links: nodes/operator/app/src/shared/node-app-scaffold/scheduled-jobs (the API),
 *   ../scheduledJobs (registration + lifecycle), ../scheduled-jobs.registry (import barrel)
 * @public
 */

import type { Container } from "@/bootstrap/container";
import { defineScheduledJob } from "@/shared/node-app-scaffold/scheduled-jobs";

/**
 * Example: ingest metrics every 15 minutes. Replace the body of `run` with real
 * work. Typed over `Container` so the inline body can reach ports (DB, graph
 * executor) via `ctx.deps`; a self-contained job can omit the type argument.
 */
export const metricsIngest = defineScheduledJob<Container>({
  id: "metrics-ingest",
  cron: "*/15 * * * *",
  run: async (ctx) => {
    // The work, inline. `ctx.deps` is the operator container — reach the existing
    // graph executor / ports here for any AI or DB work. This stub proves the
    // dispatch arrives under the node principal with the idempotency key.
    ctx.logger.info(
      {
        jobId: ctx.jobId,
        nodeId: ctx.nodeId,
        scheduledFor: ctx.scheduledFor,
      },
      "metrics-ingest tick"
    );
  },
});
