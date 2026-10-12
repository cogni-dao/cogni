// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/bootstrap/env`
 * Purpose: Environment configuration with Zod validation and lazy singleton.
 * Scope: Config parsing only — no client construction, no side-effects beyond process.env read.
 * Invariants:
 * - DATABASE_URL optional: only the attribution/ledger container consumes it. The scheduler (runs + grants) path is HTTP-delegated to the owning node per task.0280 and holds no DB credentials.
 * - TEMPORAL_* vars required for Temporal connection
 * - SCHEDULER_API_TOKEN required for internal API calls (treat as secret)
 * - Fails fast with clear errors on invalid config
 * Side-effects: Reads process.env
 * Links: services/scheduler-worker/Dockerfile, docs/spec/scheduler.md
 * @internal
 */

import { z } from "zod";

const EnvSchema = z.object({
  /** PostgreSQL connection string. Optional — consumed ONLY by the attribution/ledger container (a shared ledger, not per-node). The scheduler path (runs + grants) holds no DB credentials; writes go through each node's internal HTTP API. Follow-up: rename to LEDGER_DATABASE_URL and drop the generic name. */
  DATABASE_URL: z
    .string()
    .min(1)
    .optional()
    .or(z.literal("").transform(() => undefined)),

  /** Temporal server address (required) */
  TEMPORAL_ADDRESS: z.string().min(1, "TEMPORAL_ADDRESS is required"),

  /** Temporal namespace (required) - format: cogni-{APP_ENV} */
  TEMPORAL_NAMESPACE: z.string().min(1, "TEMPORAL_NAMESPACE is required"),
  /**
   * Namespaces this worker serves IN ADDITION to its own (bug.5212). A foreign-custodied lane
   * — an akash node's non-production lane, reconciled and paid for by the production cluster —
   * submits its workflows to the CONTROL cluster's Temporal under `cogni-<lane>`. That is the
   * server this worker is already connected to, and the SCHEDULER_API_TOKEN the lane inherits
   * is already this env's, so serving the lane needs one more Worker per namespace and nothing
   * else. Empty (the default) means byte-identical behaviour to before.
   */
  TEMPORAL_CUSTODIED_NAMESPACES: z.string().optional().default(""),

  /** Temporal task queue (required) */
  TEMPORAL_TASK_QUEUE: z.string().min(1, "TEMPORAL_TASK_QUEUE is required"),

  /** Scheduler API token for internal API calls (required, treat as secret - never log) */
  SCHEDULER_API_TOKEN: z
    .string()
    .min(32, "SCHEDULER_API_TOKEN must be at least 32 characters"),

  /** Per-node API endpoints for graph execution routing (required).
   * Format: "operator=http://operator-app:3000,poly=http://poly-app:3000,resy=http://resy-app:3000" */
  COGNI_NODE_ENDPOINTS: z.string().min(1, "COGNI_NODE_ENDPOINTS is required"),

  /** GitHub App ID (optional — required only when GitHub ingestion is enabled) */
  GH_REVIEW_APP_ID: z
    .string()
    .min(1)
    .optional()
    .or(z.literal("").transform(() => undefined)),

  /** GitHub App private key, base64-encoded PEM (optional — required only when GitHub ingestion is enabled) */
  GH_REVIEW_APP_PRIVATE_KEY_BASE64: z
    .string()
    .min(1)
    .optional()
    .or(z.literal("").transform(() => undefined)),

  /** Comma-separated repos for GitHub activity collection (e.g., "Cogni-DAO/cogni") */
  GH_REPOS: z
    .string()
    .min(1)
    .optional()
    .or(z.literal("").transform(() => undefined)),

  /**
   * Deployment environment (patched per-env into the worker configmap; overlays set
   * `production`/`candidate-*`/`preview`). Read by the bug.5020 execute-guard: any value
   * other than `production` (including absent) is treated as non-production, fail-closed —
   * a non-production worker must never build a distribution against the production DAO.
   */
  DEPLOY_ENVIRONMENT: z
    .string()
    .min(1)
    .optional()
    .or(z.literal("").transform(() => undefined)),

  /** Log level (default: info) */
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** Service name for logging (default: scheduler-worker) */
  SERVICE_NAME: z.string().default("scheduler-worker"),

  /** Health endpoint port (default: 9000) */
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
});

export type Env = z.infer<typeof EnvSchema>;

/** @deprecated Use env() instead */
export type Config = Env;

let _env: Env | null = null;

/**
 * Returns validated environment singleton.
 * Parses process.env on first call, caches result.
 * Throws on invalid config with clear error messages.
 */
export function env(): Env {
  if (!_env) {
    const result = EnvSchema.safeParse(process.env);
    if (!result.success) {
      const errors = result.error.errors
        .map((e) => `  ${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new Error(`Invalid environment configuration:\n${errors}`);
    }
    _env = result.data;
  }
  return _env;
}

/** @deprecated Use env() instead */
export function loadConfig(): Env {
  return env();
}
