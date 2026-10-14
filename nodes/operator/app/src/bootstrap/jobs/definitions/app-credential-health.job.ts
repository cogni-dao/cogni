// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/definitions/app-credential-health.job`
 * Purpose: The RECURRING leg of subtask.5016 C3 — every 6 hours, evaluate the
 *   platform GitHub App credential (OpenBao custody vs live pod credential vs
 *   live GitHub validity) and emit the typed conclusion to Loki. This is what
 *   makes a staged-but-never-converged custody (the 2026-10-03 silent-window
 *   class) loud without anyone calling the health route.
 * Scope: Read-only — OpenBao GET + GitHub GETs; zero writes, zero mutation.
 * Invariants:
 *   - LOUD_ON_DIVERGENCE: any conclusion other than `current` logs at WARN
 *     (`invalid`/`misbound`/`failed` at ERROR) under
 *     `feature.operator_app_credential_health.complete` — alertable in Loki.
 *   - NEVER_THROWS_SECRETS: the report carries fingerprints only; an evaluation
 *     error logs a typed code, never upstream bodies.
 *   - BEST_EFFORT: an unconfigured plane (no writer role / no DEPLOY_ENVIRONMENT)
 *     logs `unconfigured`/typed-code and returns — the job never crash-loops the
 *     dispatcher.
 * Side-effects: registers the job in the in-process registry at import time.
 * Links: src/features/secrets/app-credential-rotation.service.ts,
 *   src/app/api/v1/secrets/github-app/health/route.ts (the on-demand leg),
 *   ../scheduled-jobs.registry (import barrel), subtask.5016 (C3)
 * @public
 */

import { createOperatorAppCredentialsPlane } from "@/bootstrap/capabilities/operator-app-credentials";
import {
  DeployEnvUnsetError,
  evaluateOperatorAppCredentialHealth,
} from "@/features/secrets/app-credential-rotation.service";
import { serverEnv } from "@/shared/env";
import { defineScheduledJob } from "@/shared/node-app-scaffold/scheduled-jobs";
import { EVENT_NAMES } from "@/shared/observability";

export const appCredentialHealth = defineScheduledJob({
  id: "app-credential-health",
  cron: "17 */6 * * *",
  run: async (ctx) => {
    const env = serverEnv();
    const base = {
      event: EVENT_NAMES.OPERATOR_APP_CREDENTIAL_HEALTH_COMPLETE,
      jobId: ctx.jobId,
      nodeId: ctx.nodeId,
    };
    let plane: ReturnType<typeof createOperatorAppCredentialsPlane>;
    try {
      plane = createOperatorAppCredentialsPlane(env);
    } catch {
      ctx.logger.warn(
        {
          ...base,
          conclusion: "unconfigured",
          reasons: ["secrets_plane_config_missing"],
        },
        EVENT_NAMES.OPERATOR_APP_CREDENTIAL_HEALTH_COMPLETE
      );
      return;
    }
    try {
      const report = await evaluateOperatorAppCredentialHealth({
        ...plane,
        env,
      });
      const level =
        report.conclusion === "current"
          ? "info"
          : report.conclusion === "written_not_propagated"
            ? "warn"
            : "error";
      ctx.logger[level](
        {
          ...base,
          conclusion: report.conclusion,
          reasons: report.reasons,
          env: report.env,
          storedKeyFingerprint: report.stored?.keyFingerprint,
          liveKeyFingerprint: report.liveConsumer?.keyFingerprint,
        },
        EVENT_NAMES.OPERATOR_APP_CREDENTIAL_HEALTH_COMPLETE
      );
    } catch (error) {
      const code =
        error instanceof DeployEnvUnsetError
          ? "deploy_env_unset"
          : "health_evaluation_failed";
      ctx.logger.warn(
        { ...base, conclusion: "unconfigured", reasons: [code] },
        EVENT_NAMES.OPERATOR_APP_CREDENTIAL_HEALTH_COMPLETE
      );
    }
  },
});
