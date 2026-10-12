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
  APP_IDENTITY_DRIFT: "app_identity_drift",
  WORKER_IDENTITY_DRIFT: "worker_identity_drift",
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
  expectedAppSha,
  expectedWorkerSha,
  expectedWorkerDigest,
  fetchImpl = globalThis.fetch,
  timeoutMs = 4_500,
}) {
  try {
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
    if (response.ok && body.status === "healthy") {
      if (
        typeof body.app?.buildSha !== "string" ||
        !/^[0-9a-f]{40}$/i.test(body.app.buildSha) ||
        typeof body.worker?.sha !== "string" ||
        !/^[0-9a-f]{40}$/i.test(body.worker.sha) ||
        typeof body.worker?.imageDigest !== "string" ||
        !/(?:^|@)sha256:[0-9a-f]{64}$/i.test(body.worker.imageDigest)
      ) {
        return {
          exitCode: 1,
          body: {
            status: "error",
            reason: TEMPORAL_HEALTH_CLI_REASON.RESPONSE_MALFORMED,
          },
        };
      }
      if (
        expectedAppSha &&
        body.app.buildSha.toLowerCase() !== expectedAppSha.toLowerCase()
      ) {
        return {
          exitCode: 1,
          body: {
            status: "unhealthy",
            reason: TEMPORAL_HEALTH_CLI_REASON.APP_IDENTITY_DRIFT,
            expected: expectedAppSha,
            observed: body.app.buildSha,
          },
        };
      }
      const observedDigest = body.worker.imageDigest.match(
        /sha256:[0-9a-f]{64}$/i
      )?.[0];
      if (
        (expectedWorkerSha &&
          body.worker.sha.toLowerCase() !== expectedWorkerSha.toLowerCase()) ||
        (expectedWorkerDigest &&
          observedDigest?.toLowerCase() !== expectedWorkerDigest.toLowerCase())
      ) {
        return {
          exitCode: 1,
          body: {
            status: "unhealthy",
            reason: TEMPORAL_HEALTH_CLI_REASON.WORKER_IDENTITY_DRIFT,
            expected: {
              sha: expectedWorkerSha,
              imageDigest: expectedWorkerDigest,
            },
            observed: {
              sha: body.worker.sha,
              imageDigest: observedDigest,
            },
          },
        };
      }
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
