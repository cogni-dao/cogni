// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@_fixtures/env/base-env`
 * Purpose: Shared base environment variables for unit and contract tests.
 * Scope: Provides minimal valid env object for tests that trigger serverEnv() validation. Does not load .env files.
 * Invariants: All required env vars present; values are test-safe (no real credentials)
 * Side-effects: none (pure data export)
 * Links: tests/unit/shared/env.*.spec.ts, tests/unit/bootstrap/container.spec.ts
 * @public
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_COGNI_REPO_PATH = existsSync(
  resolve(process.cwd(), ".cogni", "repo-spec.yaml")
)
  ? process.cwd()
  : resolve(process.cwd(), "..");

/**
 * Core env vars required by serverEnv() validation.
 * Does NOT include APP_ENV - let test suites control adapter wiring.
 * Used by tests/setup.ts for global test environment.
 *
 * Per DATABASE_RLS_SPEC.md design decision 7: both DSNs required with distinct users.
 */
export const CORE_TEST_ENV = {
  NODE_ENV: "test",
  // Database connections — both required, distinct users for RLS enforcement
  // Per DATABASE_RLS_SPEC.md: no component-piece fallback in runtime
  DATABASE_URL: "postgresql://app_user:password@localhost:5432/test_db",
  DATABASE_SERVICE_URL: "postgresql://app_service:svc@localhost:5432/test_db",
  // Auth
  AUTH_SECRET: "x".repeat(32),
  // LiteLLM
  LITELLM_MASTER_KEY: "test-key",
  // Scheduler
  SCHEDULER_API_TOKEN: "x".repeat(32),
  // Billing ingest (LiteLLM callback auth)
  BILLING_INGEST_TOKEN: "x".repeat(32),
  // Temporal (required infrastructure)
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "test-namespace",
  // OpenClaw gateway auth (min 32 chars)
  OPENCLAW_GATEWAY_TOKEN: "x".repeat(32),
  // OpenClaw git relay token (host-side push)
  OPENCLAW_GITHUB_RW_TOKEN: "ghp_test_token",
  // Repo access (required in all envs — no cwd fallback)
  COGNI_REPO_PATH: DEFAULT_COGNI_REPO_PATH,
  // PostHog product analytics (required — test values, events silently dropped)
  POSTHOG_API_KEY: "phc_test_key",
  POSTHOG_HOST: "http://localhost:18000",
} as const;

/**
 * Base valid environment for unit/contract tests.
 * Contains all required env vars with test-safe values.
 * Tests can spread this and override specific vars as needed.
 *
 * @example
 * ```ts
 * Object.assign(process.env, {
 *   ...BASE_VALID_ENV,
 *   APP_ENV: "production", // Override specific var
 * });
 * ```
 */
export const BASE_VALID_ENV = {
  ...CORE_TEST_ENV,
  APP_ENV: "test",
} as const;

/**
 * Production-like environment for testing production adapter wiring.
 * Includes additional vars required in production mode.
 */
export const PRODUCTION_VALID_ENV = {
  ...BASE_VALID_ENV,
  NODE_ENV: "test", // Keep test for logging silence
  APP_ENV: "production",
  // DSNs inherited from CORE_TEST_ENV (already have distinct users)
  EVM_RPC_URL: "https://eth-sepolia.example.com/v2/test-key",
  // COGNI_REPO_PATH inherited from CORE_TEST_ENV
} as const;

/**
 * Mock serverEnv() return value for contract tests.
 * Use this when mocking @/shared/env to ensure all required fields are present.
 *
 * IMPORTANT: APP_ENV="test" and isTestMode=true are required to wire fake adapters
 * (FakeEvmOnchainClient, FakeMetricsAdapter, etc.) instead of real ones.
 * LLM always uses LiteLlmAdapter (test stacks use mock-openai-api backend).
 *
 * @example
 * ```ts
 * vi.mock("@/shared/env", () => ({
 *   serverEnv: () => MOCK_SERVER_ENV,
 * }));
 * ```
 */
export const MOCK_SERVER_ENV = {
  ...BASE_VALID_ENV,
  // Computed fields that serverEnv() adds (DATABASE_URL already in BASE_VALID_ENV)
  COGNI_REPO_ROOT: DEFAULT_COGNI_REPO_PATH,
  isDev: false,
  isTest: true,
  isProd: false,
  isTestMode: true, // Controls fake adapter wiring in container.ts
} as const;
