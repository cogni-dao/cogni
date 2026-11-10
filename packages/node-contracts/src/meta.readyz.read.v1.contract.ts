// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/meta.readyz.read.v1.contract`
 * Purpose: Contract for readiness probe endpoint (strict validation).
 * Scope: Readiness check - validates env, secrets, and runtime requirements. MVP: env+secrets only. Does not include DB connectivity check yet.
 * Invariants: Binary readiness for MVP; HTTP status is primary truth: 200 = ready, 503 = not ready.
 * Side-effects: none
 * Notes: Used by Docker HEALTHCHECK, deployment validation, and K8s readiness probes.
 *        K8s health consumers rely on HTTP status codes, not response body.
 * Links: /readyz endpoint
 * @internal
 */

import { z } from "zod";

// MVP: Binary readiness (ready or not ready)
export const readyzStatusSchema = z.enum(["healthy"]);

export const metaReadyzOutputSchema = z.object({
  status: readyzStatusSchema,
  timestamp: z.string(), // RFC3339/ISO-8601 format
  version: z.string().optional(),
  // Canonical source: APP_BUILD_SHA from serverEnv()
  // Aligns buildSha across /metrics, /readyz, and agent.json per BUILD_SHA_IN_METRICS invariant
  buildSha: z.string().optional(),
  // `?deep=1` only: each probed dependency's status (@cogni-dao/substrate-health
  // DeepChecks). Absent on the default path.
  checks: z
    .record(
      z.string(),
      z.object({
        status: z.enum(["ok", "failed"]),
        durationMs: z.number(),
      })
    )
    .optional(),
});

// Protocol-neutral operation metadata.
export const metaReadyzOperation = {
  id: "meta.readyz.read.v1",
  summary: "Readiness probe - full validation",
  description:
    "Readiness check validating environment, secrets, and runtime requirements. Used for deployment gates and container orchestration. HTTP status: 200 = ready, 503 = not ready.",
  input: null,
  output: metaReadyzOutputSchema,
} as const;
