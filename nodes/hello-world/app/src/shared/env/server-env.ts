// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/env/server-env`
 * Purpose: Server-side environment variable validation and type-safe configuration schema using Zod.
 * Scope: Validates process.env for server runtime; provides lazy server environment access. Does not handle client-side env vars.
 * Invariants: All required env vars validated on first access; provides boolean flags for runtime and test modes; fails fast on invalid env.
 * Side-effects: process.env
 * Notes: Extracted from server.ts so that bootstrap/job code can import without pulling in "server-only".
 *        APP_ENV for adapter wiring; SERVICE_NAME for observability; LLM config; DATABASE_URL required (no component-piece fallback).
 *        Lazy init prevents build-time access. Per DATABASE_RLS_SPEC.md design decision 7: no DSN construction in runtime code.
 * Links: Environment configuration specification
 * @public
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { ZodError, z } from "zod";

import { assertEnvInvariants } from "./invariants";

// Env vars are strings - empty string "" should be treated as "not set" for optional fields.
// Docker-compose passes through empty strings from shell even when .env file omits the var.
// Note: whitespace-only strings are kept as-is (will fail validation, not silently accepted).
const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && v === "" ? undefined : v;
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalString = z.preprocess(
  emptyToUndefined,
  z.string().min(1).optional()
);

export interface EnvValidationMeta {
  code: "INVALID_ENV";
  missing: string[];
  invalid: string[];
}

export class EnvValidationError extends Error {
  readonly meta: EnvValidationMeta;

  constructor(meta: EnvValidationMeta) {
    super(`Invalid server env: ${JSON.stringify(meta)}`);
    this.name = "EnvValidationError";
    this.meta = meta;
  }
}

// Server schema with all environment variables
export const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Application environment (controls adapter wiring)
  APP_ENV: z.enum(["test", "production"]),
  APP_BASE_URL: z.string().url().optional(),
  DOMAIN: z.string().optional(),

  // Deployment environment (for observability labels and analytics filtering)
  DEPLOY_ENVIRONMENT: z.string().optional(),

  // Build SHA for observability (canonical source for /metrics, /readyz, agent.json)
  APP_BUILD_SHA: z.string().optional(),

  // Service identity for observability (multi-service deployments)
  SERVICE_NAME: z.string().default("app"),

  // LLM (Stage 8) - App only needs proxy access, not provider keys
  LITELLM_BASE_URL: z
    .string()
    .url()
    .default(
      process.env.NODE_ENV === "production"
        ? "http://litellm:4000"
        : "http://localhost:4000"
    ),
  LITELLM_MASTER_KEY: z.string().min(1),

  // TODO: Remove when proper wallet→key registry exists (MVP crutch)
  // Wallet link MVP - single API key for all wallets (temporary)
  LITELLM_MVP_API_KEY: z.string().default("test-mvp-api-key"),

  // Billing (Stage 6.5)
  USER_PRICE_MARKUP_FACTOR: z.coerce.number().min(1.0).default(2.0),

  // System tenant revenue share — fraction of user credits minted as bonus to system tenant
  // 0 = disabled, 0.75 = 75% bonus (default). Per docs/spec/system-tenant.md
  SYSTEM_TENANT_REVENUE_SHARE: z.coerce.number().min(0).max(1).default(0.75),

  // Database connections — both required, no component-piece fallback.
  // Per DATABASE_RLS_SPEC.md design decision 7: runtime app consumes explicit DSNs only.
  // app_user role (RLS enforced) — used by Next.js request paths
  DATABASE_URL: z.string().url(),
  // app_service role (BYPASSRLS) — used by auth, workers, bootstrap
  DATABASE_SERVICE_URL: z.string().url(),

  // NextAuth secret (required for JWT signing)
  AUTH_SECRET: z.string().min(32),

  // Optional
  PORT: z.coerce.number().default(3000),
  PINO_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),

  // Metrics (Stage 9) - Prometheus scraping (min 32 chars to reduce weak-token risk)
  // Note: PROMETHEUS_* vars are Alloy-only (infra); app only needs the scrape token.
  METRICS_TOKEN: z.string().min(32).optional(),

  // Scheduler API token - Bearer auth for scheduler-worker → internal graph execution API
  // Per SCHEDULER_SPEC.md: scheduler worker authenticates via shared secret to call
  // POST /api/internal/graphs/{graphId}/runs. Min 32 chars to reduce weak-token risk.
  // Required: Internal execution API will not function without this token.
  SCHEDULER_API_TOKEN: z.string().min(32),

  // Internal ops token - Bearer auth for deploy-time internal operations endpoints
  // Optional in schema to avoid breaking environments that do not use ops endpoints.
  INTERNAL_OPS_TOKEN: z.string().min(32).optional(),

  // Governance schedules - Deploy-time schedule sync control
  // When false, governance schedule sync job is skipped (prevents duplicate ops in preview)
  // Default: true (enabled in production/staging)
  GOVERNANCE_SCHEDULES_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // GitHub webhook secret - HMAC-SHA256 verification for incoming GitHub webhook payloads.
  // Required when GitHub webhook ingestion is enabled. Per WEBHOOK_SECRET_NOT_IN_CODE.
  GH_WEBHOOK_SECRET: optionalString,

  // Alchemy webhook secret - HMAC-SHA256 verification for incoming Alchemy webhook payloads.
  // Required when on-chain governance signal execution is enabled.
  ALCHEMY_WEBHOOK_SECRET: optionalString,

  // GitHub Review App credentials - for PR review Check Runs + comments.
  // Optional: PR review feature is disabled when not configured.
  // These are the same env vars used by scheduler-worker for ingestion.
  GH_REVIEW_APP_ID: optionalString,
  GH_REVIEW_APP_PRIVATE_KEY_BASE64: optionalString,

  // Billing ingest token - Bearer auth for LiteLLM generic_api callback → billing ingest endpoint
  // Per billing-ingest-spec: CALLBACK_AUTHENTICATED invariant. Min 32 chars to reduce weak-token risk.
  // Required: Billing ingest endpoint will reject all callbacks without this token.
  BILLING_INGEST_TOKEN: z.string().min(32),

  // Prometheus Query (Grafana Cloud) - READ path for app metrics queries
  // Query URL derived from PROMETHEUS_REMOTE_WRITE_URL (must end with /api/prom/push)
  // Or set PROMETHEUS_QUERY_URL explicitly for non-standard endpoints
  // Security: Use read-only token, separate from Alloy's write token
  PROMETHEUS_REMOTE_WRITE_URL: optionalUrl,
  PROMETHEUS_QUERY_URL: optionalUrl,
  PROMETHEUS_READ_USERNAME: optionalString,
  PROMETHEUS_READ_PASSWORD: optionalString,
  ANALYTICS_K_THRESHOLD: z.coerce.number().int().positive().default(50),
  ANALYTICS_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // EVM RPC - On-chain verification (Phase 3)
  // Required for production/preview/dev; not used in test mode (FakeEvmOnchainClient)
  EVM_RPC_URL: optionalUrl,

  // Langfuse (AI observability) - Optional
  // Only required when Langfuse tracing is enabled
  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
  LANGFUSE_BASE_URL: optionalUrl,

  // AI Telemetry - Router policy version for reproducibility
  // Per AI_SETUP_SPEC.md: semver or git SHA identifying model routing policy
  ROUTER_POLICY_VERSION: z.string().default("1.0.0"),

  // LangGraph Dev Server - Optional
  // When set, graph execution uses langgraph dev server instead of in-process
  // Per LANGGRAPH_SERVER.md MVP: default port 2024 for langgraph dev
  LANGGRAPH_DEV_URL: z.string().url().optional(),

  // Doltgres (Knowledge Data Plane) - Optional
  // Per knowledge-data-plane spec: versioned knowledge store for agent domain expertise.
  // Writer URL used by knowledge tools (auto-commit on write). Reader URL for read-only agents.
  DOLTGRES_URL: optionalUrl,

  // DoltHub credentials — service-side push of knowledge hubs to DoltHub
  // remote (cogni-dao/knowledge-<node>). v0 push uses DoltHub Dolt creds
  // (keypair, see docs/runbooks/dolthub-remote-bootstrap.md). DOLTHUB_REMOTE_URL
  // gates the push job — when unset, merges still succeed locally and never
  // attempt a push. DOLTHUB_API_TOKEN (PAT) is for the REST/SQL HTTP API only
  // (future librarian/x402 reads). DoltHub OAuth pair is reserved for v1
  // per-user identity (task.5070, blocked on DoltHub app approval). Per
  // proj.knowledge-syntropy (W0c tier) + task.5069.
  DOLTHUB_REMOTE_URL: optionalString,
  DOLTHUB_API_TOKEN: optionalString,
  DOLTHUB_OAUTH_CLIENT_ID: optionalString,
  DOLTHUB_OAUTH_CLIENT_SECRET: optionalString,

  // Tavily Web Search - Optional
  // Required for research graph web search capability
  TAVILY_API_KEY: optionalString,

  // Market Provider: Kalshi - Optional
  // Required for Kalshi market data in poly-brain. Polymarket works without credentials.
  KALSHI_API_KEY: optionalString,
  KALSHI_API_SECRET: optionalString,

  // Redis (stream plane — ephemeral only)
  // Per unified-graph-launch spec: REDIS_IS_STREAM_PLANE
  // Default: localhost for host-mode dev; docker-compose overrides to redis://redis:6379
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // Temporal (Schedule orchestration) - Required
  // Per SCHEDULER_SPEC.md: Temporal is required infrastructure, no fallback
  // Start Temporal with: pnpm dev:infra
  TEMPORAL_ADDRESS: z.string().min(1), // e.g., "localhost:7233" or "temporal:7233"
  TEMPORAL_NAMESPACE: z.string().min(1), // e.g., "cogni-test" or "cogni-production"
  TEMPORAL_TASK_QUEUE: z.string().default("scheduler-tasks"),

  // Scheduler-worker health check URL
  // Used by /readyz to verify scheduler-worker is ready before stack tests
  // Default: http://scheduler-worker:9000 (Docker network)
  // Override: http://localhost:9001 for test:stack:dev (app on host)
  SCHEDULER_WORKER_HEALTH_URL: z
    .string()
    .url()
    .default("http://scheduler-worker:9000"),

  // Repo access (in-process ripgrep) — required, no default
  // Must be explicitly set in every environment (.env.local, CI, compose)
  // to prevent green-CI / broken-prod blind spots from silent cwd() fallback
  COGNI_REPO_PATH: optionalString,
  // SHA override for mounts without .git (e.g., git-sync worktree)
  COGNI_REPO_SHA: optionalString,

  // TigerBeetle (Financial Ledger) - Optional
  // Required only when double-entry ledger is enabled.
  // Per financial-ledger-spec: address of TigerBeetle cluster.
  TIGERBEETLE_ADDRESS: optionalString,

  // Privy (Operator Wallet) - Optional
  // Required only when operator wallet features are enabled.
  // Per operator-wallet.md: KEY_NEVER_IN_APP — Privy HSM holds signing keys.
  PRIVY_APP_ID: optionalString,
  PRIVY_APP_SECRET: optionalString,
  PRIVY_SIGNING_KEY: optionalString,

  // Operator wallet top-up cap (USD)
  // Per operator-wallet.md: MAX_TOPUP_CAP — per-tx ceiling for OpenRouter top-ups.
  OPERATOR_MAX_TOPUP_USD: z.coerce.number().positive().default(500),

  // OpenRouter API key — optional. Provider funding disabled when not set.
  OPENROUTER_API_KEY: optionalString,

  // OpenRouter crypto payment fee (0–1, default 0.05 = 5%)
  // Per web3-openrouter-payments spec: Coinbase Commerce protocol fee.
  OPENROUTER_CRYPTO_FEE: z.coerce.number().min(0).max(1).default(0.05),

  // BYO-AI: AEAD encryption key for connections table (hex-encoded 32 bytes)
  // Optional — BYO-AI features disabled when not set.
  CONNECTIONS_ENCRYPTION_KEY: optionalString,

  // PostHog product analytics — required
  // See docs/guides/posthog-setup.md for setup
  // PostHog Cloud free tier: 1M events/month at https://us.i.posthog.com
  POSTHOG_API_KEY: optionalString,
  POSTHOG_HOST: optionalUrl,
  POSTHOG_PROJECT_ID: optionalString,
});

type ServerEnv = z.infer<typeof serverSchema> & {
  /** Validated repo root path (resolved from COGNI_REPO_PATH) */
  COGNI_REPO_ROOT: string | undefined;
  isDev: boolean;
  isTest: boolean;
  isProd: boolean;
  isTestMode: boolean;
};

let ENV: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (ENV === null) {
    try {
      const parsed = serverSchema.parse(process.env);
      const isDev = parsed.NODE_ENV === "development";
      const isTest = parsed.NODE_ENV === "test";
      const isProd = parsed.NODE_ENV === "production";
      const isTestMode = parsed.APP_ENV === "test";

      // Cross-field invariants (beyond Zod schema)
      // Per DATABASE_RLS_SPEC.md design decision 7: enforce role separation at boot
      assertEnvInvariants(parsed);

      // Per DATABASE_RLS_SPEC.md §SSL_REQUIRED_NON_LOCAL: reject non-localhost
      // PostgreSQL URLs without sslmode= to prevent credential sniffing.
      if (parsed.DATABASE_URL.startsWith("postgresql://")) {
        try {
          const dbUrl = new URL(parsed.DATABASE_URL);
          const host = dbUrl.hostname;
          const isLocal = host === "localhost" || host === "127.0.0.1";
          if (!isLocal && !dbUrl.searchParams.has("sslmode")) {
            throw new Error(
              `DATABASE_URL points to non-localhost host "${host}" but is missing sslmode= parameter. ` +
                "Add ?sslmode=require (or stricter) for production safety."
            );
          }
        } catch (e) {
          // URL parse failure on non-standard schemes (e.g., sqlite://) is fine
          if (e instanceof Error && e.message.includes("sslmode")) throw e;
        }
      }

      // Per DATABASE_RLS_SPEC.md §SSL_REQUIRED_NON_LOCAL: enforce sslmode on DATABASE_SERVICE_URL too.
      if (parsed.DATABASE_SERVICE_URL?.startsWith("postgresql://")) {
        try {
          const svcUrl = new URL(parsed.DATABASE_SERVICE_URL);
          const host = svcUrl.hostname;
          const isLocal = host === "localhost" || host === "127.0.0.1";
          if (!isLocal && !svcUrl.searchParams.has("sslmode")) {
            throw new Error(
              `DATABASE_SERVICE_URL points to non-localhost host "${host}" but is missing sslmode= parameter. ` +
                "Add ?sslmode=require (or stricter) for production safety."
            );
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes("sslmode")) throw e;
        }
      }

      // Resolve COGNI_REPO_ROOT from optional COGNI_REPO_PATH.
      // When unset, repo tools are disabled — no crash, no fallback.
      let COGNI_REPO_ROOT: string | undefined;
      if (parsed.COGNI_REPO_PATH) {
        COGNI_REPO_ROOT = parsed.COGNI_REPO_PATH;
        if (!existsSync(COGNI_REPO_ROOT)) {
          throw new Error(`COGNI_REPO_ROOT does not exist: ${COGNI_REPO_ROOT}`);
        }
        if (
          !existsSync(join(COGNI_REPO_ROOT, "package.json")) &&
          !existsSync(join(COGNI_REPO_ROOT, ".cogni", "repo-spec.yaml")) &&
          !existsSync(join(COGNI_REPO_ROOT, ".git"))
        ) {
          throw new Error(
            `COGNI_REPO_ROOT missing package.json, .cogni/repo-spec.yaml, and .git: ${COGNI_REPO_ROOT}`
          );
        }
      }

      ENV = {
        ...parsed,
        COGNI_REPO_ROOT,
        isDev,
        isTest,
        isProd,
        isTestMode,
      };
    } catch (error) {
      if (error instanceof ZodError) {
        const missing = new Set<string>();
        const invalid = new Set<string>();

        for (const issue of error.issues) {
          const key = issue.path[0]?.toString();
          if (!key) continue;

          /*
           * Treat all invalid_type as missing (avoids any casting)
           */
          if (issue.code === "invalid_type") {
            missing.add(key);
          } else {
            invalid.add(key);
          }
        }

        const meta: EnvValidationMeta = {
          code: "INVALID_ENV",
          missing: [...missing],
          invalid: [...invalid],
        };

        throw new EnvValidationError(meta);
      }

      throw error;
    }
  }
  return ENV;
}

export type { ServerEnv };
