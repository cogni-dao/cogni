// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/definitions/preview-retirement.job`
 * Purpose: Repeat bounded preview retirement through the existing durable Temporal scheduler.
 * Scope: Opt-in job definition; does not add a workflow, worker or provider credential.
 * Invariants: Unknown cleanup remains occupied and is retried by the next scheduled fire.
 * Side-effects: global (job registration); IO (injected lifecycle)
 * Links: capabilities/preview-flight.ts, bootstrap/jobs/scheduledJobs.ts
 * @internal
 */
import { createPreviewFlight } from "@/bootstrap/capabilities/preview-flight";
import { serverEnv } from "@/shared/env/server-env";
import { defineScheduledJob } from "@/shared/node-app-scaffold/scheduled-jobs";

export const previewRetirement = defineScheduledJob({
  id: "preview-retirement",
  cron: "* * * * *",
  run: async () => {
    const env = serverEnv();
    // Existing paid requests keep their lifecycle when new admission is disabled.
    await createPreviewFlight(env, true).sweep();
  },
});
