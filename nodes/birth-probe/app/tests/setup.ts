// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/setup`
 * Purpose: Global test environment setup with HTTP dispatcher configuration for SSL certificate handling and test isolation.
 * Scope: Configures minimal test environment and undici HTTP agents. Does not set DATABASE_URL, allowing individual tests to control DB config.
 * Invariants: Tests run in isolation; HTTP agents handle localhost SSL correctly; minimal env pollution.
 * Side-effects: process.env, global (HTTP dispatcher)
 * Notes: Creates dual HTTP agents (strict external, relaxed localhost); no explicit agent cleanup to prevent suite failures.
 * Links: vitest.config.mts, stack test setup
 * @public
 */

import "@testing-library/jest-dom/vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type Dispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeAll, vi } from "vitest";

import { initOtelSdk } from "@/instrumentation";

const DEFAULT_COGNI_REPO_PATH = existsSync(
  resolve(process.cwd(), ".cogni", "repo-spec.yaml")
)
  ? process.cwd()
  : resolve(process.cwd(), "..");

// Set test tooling environment IMMEDIATELY at module load time
// (before test file imports resolve - needed for contract tests that import route handlers)
// Do NOT set APP_ENV here - let test suites control it for adapter wiring tests
// Do NOT set DATABASE_URL or DB_* here - stack tests use .env.test values
Object.assign(process.env, {
  NODE_ENV: "test",
  VITEST: "true", // Canonical test-runner signal - silences makeLogger() regardless of APP_ENV
  // Disable external service calls for unit tests
  DISABLE_TELEMETRY: "true",
  DISABLE_EXTERNAL_CALLS: "true",
  // Temporal vars required by container - provide defaults for unit/contract tests
  // Stack tests override these via .env.test
  TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE ?? "test-namespace",
  // Repo access: integration tests use real RepoCapability, default to repo checkout
  COGNI_REPO_PATH: process.env.COGNI_REPO_PATH ?? DEFAULT_COGNI_REPO_PATH,
});

// server-only throws at import time outside Next.js server context; stub it for Vitest
vi.mock("server-only", () => ({}));

// Minimal RainbowKit mock to prevent browser-only dependencies from loading in Node
vi.mock("@rainbow-me/rainbowkit", () => ({
  getDefaultConfig: vi.fn(() => ({
    chains: [],
    transports: {},
    connectors: [],
  })),
  RainbowKitProvider: ({ children }: { children: React.ReactNode }) => children,
  RainbowKitSiweNextAuthProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => children,
  darkTheme: vi.fn(() => ({})),
  lightTheme: vi.fn(() => ({})),
}));

/**
 * Global test setup for deterministic, isolated testing.
 *
 * Following architecture principles:
 * - Unit tests: no I/O, no time, no RNG (use _fakes)
 * - Integration tests: real infra with clean setup/teardown
 * - Contract tests: port compliance verification
 */

// Global agents for cleanup
let strictAgent: Agent;
let localhostAgent: Agent;
let dispatcher: Dispatcher;

beforeAll(async () => {
  // Initialize OTel SDK for stack tests that assert trace_id
  // Uses same codepath as production (instrumentation.ts) per AI_SETUP_SPEC.md
  // failOnError: false allows graceful degradation in test environment
  await initOtelSdk({ failOnError: false });

  // Create two agents: strict for external, relaxed for localhost
  strictAgent = new Agent({
    connect: {
      rejectUnauthorized: true,
    },
  });

  localhostAgent = new Agent({
    connect: {
      rejectUnauthorized: false, // Accept self-signed certs for localhost only
    },
  });

  // Custom dispatcher as plain object implementing Dispatcher interface
  dispatcher = {
    dispatch(
      opts: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler
    ) {
      const origin = String(opts.origin ?? "");
      const isLocalhost =
        origin.startsWith("https://localhost") ||
        origin.startsWith("https://127.0.0.1");

      const agent = isLocalhost ? localhostAgent : strictAgent;
      return agent.dispatch(opts, handler);
    },
    close() {
      return Promise.all([strictAgent.close(), localhostAgent.close()]).then(
        () => undefined
      );
    },
    destroy(err?: Error | null) {
      if (err) {
        strictAgent.destroy(err);
        localhostAgent.destroy(err);
      } else {
        strictAgent.destroy();
        localhostAgent.destroy();
      }
      return Promise.resolve();
    },
  } as Dispatcher;

  // Set the global dispatcher for all fetch requests
  setGlobalDispatcher(dispatcher);
});

afterEach(() => {
  // Clean up test state between tests
  // Reset any global mocks or state
});
