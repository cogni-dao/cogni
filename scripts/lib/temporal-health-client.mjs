// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/lib/temporal-health-client`
 * Purpose: Resolve node targets and perform bounded shared Temporal health reads.
 * Scope: Provides reusable CLI client primitives. Does not print output or mutate remote state.
 * Invariants: Only an HTTP-success healthy payload passes; errors have stable reason codes.
 * Side-effects: IO (reads repo spec and performs injected or global HTTP fetch)
 * Links: task.5238, scripts/temporal-health.mjs
 * @public
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

export const TEMPORAL_HEALTH_CLI_REASON = Object.freeze({
  AUTH_MISSING: "auth_missing",
  CLI_INVALID: "cli_invalid",
  TARGET_INVALID: "target_invalid",
  REQUEST_TIMEOUT: "request_timeout",
  REQUEST_FAILED: "request_failed",
  RESPONSE_MALFORMED: "response_malformed",
  APP_SHA_MISMATCH: "app_sha_mismatch",
  WORKER_ARTIFACT_MIXED: "worker_artifact_mixed",
  REGISTRATION_FAILED: "registration_failed",
  CHAT_TERMINAL_MISSING: "chat_terminal_missing",
  PROOF_CONFIGURATION_INVALID: "proof_configuration_invalid",
  LOKI_EVIDENCE_MISSING: "loki_evidence_missing",
  EXECUTION_FAILED: "execution_failed",
  // Shared vocabulary for the scheduled-probe stage (task.5239).
  SCHEDULE_DRIFT: "schedule_drift",
  EXECUTION_STALE: "execution_stale",
  RECENT_TERMINAL_MISSING: "recent_terminal_missing",
});

export function readNodeSlug(repoRoot) {
  const operatorSpec = path.join(
    repoRoot,
    "nodes",
    "operator",
    ".cogni",
    "repo-spec.yaml"
  );
  const rootSpec = path.join(repoRoot, ".cogni", "repo-spec.yaml");
  const specPath = fs.existsSync(operatorSpec) ? operatorSpec : rootSpec;
  const parsed = parseYaml(fs.readFileSync(specPath, "utf8"));
  const slug = parsed?.intent?.name;
  if (
    typeof slug !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)
  ) {
    throw new Error(`invalid intent.name in ${specPath}`);
  }
  return slug;
}

export function defaultBaseUrl(slug, env) {
  if (slug === "operator") {
    if (env === "production") return "https://cognidao.org";
    if (env === "preview") return "https://preview.cognidao.org";
    return "https://test.cognidao.org";
  }
  if (env === "production") return `https://${slug}.cognidao.org`;
  if (env === "preview") return `https://${slug}-preview.cognidao.org`;
  return `https://${slug}-test.cognidao.org`;
}

export function defaultWorkerHealthUrl(env) {
  if (env === "production") return "http://cogni.vm.cognidao.org:30900";
  return `http://cogni-${env}.vm.cognidao.org:30900`;
}

export function resolveTemporalHealthTarget({ repoRoot, env, url }) {
  const baseUrl = url ?? defaultBaseUrl(readNodeSlug(repoRoot), env);
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("target URL must use http or https");
  }
  return parsed.origin;
}

export async function readTemporalHealth({
  baseUrl,
  apiKey,
  workerBaseUrl,
  nodeId,
  namespace,
  taskQueue,
  fetchImpl = globalThis.fetch,
  timeoutMs = 4_500,
}) {
  try {
    if (workerBaseUrl) {
      const [appResponse, workerResponse] = await Promise.all([
        fetchImpl(`${baseUrl}/version`, {
          signal: AbortSignal.timeout(timeoutMs),
        }),
        fetchImpl(`${workerBaseUrl}/readyz?deep=1`, {
          signal: AbortSignal.timeout(timeoutMs),
        }),
      ]);
      const [app, workerHealth] = await Promise.all([
        appResponse.json().catch(() => null),
        workerResponse.json().catch(() => null),
      ]);
      if (
        !appResponse.ok ||
        !workerResponse.ok ||
        !app ||
        !workerHealth ||
        workerHealth.status !== "healthy" ||
        !Array.isArray(workerHealth.checks)
      ) {
        return {
          exitCode: 1,
          body: {
            status: "unhealthy",
            reason: workerHealth?.reason ?? "response_malformed",
          },
        };
      }
      const workflow = workerHealth.checks.find(
        (check) =>
          check.namespace === namespace &&
          check.taskQueue === taskQueue &&
          check.taskType === "workflow"
      );
      const activity = workerHealth.checks.find(
        (check) =>
          check.namespace === namespace &&
          check.taskQueue === taskQueue &&
          check.taskType === "activity"
      );
      if (workflow?.status !== "fresh" || activity?.status !== "fresh") {
        return {
          exitCode: 1,
          body: { status: "unhealthy", reason: "poller_missing" },
        };
      }
      return {
        exitCode: 0,
        body: {
          status: "healthy",
          reason: "ok",
          nodeId,
          namespace,
          taskQueue,
          app,
          worker: workerHealth.worker,
          pollers: { workflow, activity },
          checkedAt: workerHealth.checkedAt,
        },
      };
    }
    const response = await fetchImpl(`${baseUrl}/api/v1/temporal/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return {
        exitCode: 1,
        body: {
          status: "error",
          reason: TEMPORAL_HEALTH_CLI_REASON.RESPONSE_MALFORMED,
          httpStatus: response.status,
        },
      };
    }
    return {
      exitCode: response.ok && body.status === "healthy" ? 0 : 1,
      body,
    };
  } catch (error) {
    return {
      exitCode: 1,
      body: {
        status: "error",
        reason:
          error?.name === "TimeoutError"
            ? TEMPORAL_HEALTH_CLI_REASON.REQUEST_TIMEOUT
            : TEMPORAL_HEALTH_CLI_REASON.REQUEST_FAILED,
        message: error instanceof Error ? error.message : "request failed",
      },
    };
  }
}
