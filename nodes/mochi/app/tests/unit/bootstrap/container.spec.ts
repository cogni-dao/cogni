// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/container`
 * Purpose: Unit tests for dependency injection container adapter wiring.
 * Scope: Tests LiteLlmAdapter is always wired regardless of APP_ENV; stateless container behavior; strict env validation. Does NOT test adapter implementations.
 * Invariants: Module cache reset between tests; clean env state; container wiring matches expected adapter types.
 * Side-effects: process.env
 * Notes: Uses vi.resetModules() to force fresh imports. LLM always wires LiteLlmAdapter (test stacks use mock-openai-api backend).
 * Links: src/bootstrap/container.ts
 * @public
 */

import {
  BASE_VALID_ENV,
  PRODUCTION_VALID_ENV,
} from "@tests/_fixtures/env/base-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

// Container DI tests use vi.resetModules() + dynamic imports which are slow
// in sandboxed/CI environments. Use generous timeout to prevent flaky failures.
describe("bootstrap container DI wiring", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules(); // ensure fresh module evaluation
    process.env = { ...ORIGINAL_ENV }; // clean env copy
    delete process.env.AUTH_SECRET;
  });

  afterEach(async () => {
    // Reset singleton container after each test
    const { resetContainer } = await import("@/bootstrap/container");
    resetContainer();
    process.env = ORIGINAL_ENV; // restore
  }, 30_000);

  describe("getContainer adapter selection", () => {
    it("wires LiteLlmAdapter when APP_ENV=test", async () => {
      Object.assign(process.env, BASE_VALID_ENV);

      const { getContainer } = await import("@/bootstrap/container");
      const { LiteLlmAdapter } = await import("@/adapters/server");

      const container = getContainer();

      expect(container.llmService).toBeInstanceOf(LiteLlmAdapter);
      expect(container.clock).toBeDefined();
      expect(container.log).toBeDefined();
    }, 30_000);

    it("wires LiteLlmAdapter when APP_ENV=production", async () => {
      Object.assign(process.env, {
        ...PRODUCTION_VALID_ENV,
        POSTGRES_DB: "prod_db",
        LITELLM_MASTER_KEY: "prod-key",
      });

      const { getContainer } = await import("@/bootstrap/container");
      const { LiteLlmAdapter } = await import("@/adapters/server");

      const container = getContainer();

      expect(container.llmService).toBeInstanceOf(LiteLlmAdapter);
      expect(container.clock).toBeDefined();
      expect(container.log).toBeDefined();
    }, 30_000);

    it("wires LiteLlmAdapter in development mode with APP_ENV=production", async () => {
      Object.assign(process.env, {
        ...PRODUCTION_VALID_ENV,
        POSTGRES_DB: "dev_db",
        LITELLM_MASTER_KEY: "dev-key",
      });

      const { getContainer } = await import("@/bootstrap/container");
      const { LiteLlmAdapter } = await import("@/adapters/server");

      const container = getContainer();

      expect(container.llmService).toBeInstanceOf(LiteLlmAdapter);
      expect(container.log).toBeDefined();
    }, 30_000);
  });

  describe("container behavior", () => {
    beforeEach(() => {
      // Set minimal valid env for these tests
      Object.assign(process.env, BASE_VALID_ENV);
    });

    it("returns same container instance (singleton)", async () => {
      const { getContainer } = await import("@/bootstrap/container");

      const container1 = getContainer();
      const container2 = getContainer();

      // Should be the same singleton instance
      expect(container1).toBe(container2);
      expect(container1.llmService).toBe(container2.llmService);
      expect(container1.clock).toBe(container2.clock);
      expect(container1.log).toBe(container2.log);
    });

    it("resolveAiAdapterDeps uses singleton container", async () => {
      const { getContainer, resolveAiAdapterDeps } = await import(
        "@/bootstrap/container"
      );

      const container = getContainer();
      const aiDeps = resolveAiAdapterDeps();

      // Should reference the same singleton instances
      expect(container.llmService).toBe(aiDeps.llmService);
      expect(container.clock).toBe(aiDeps.clock);
      expect(container.aiTelemetry).toBe(aiDeps.aiTelemetry);
    });

    it("provides all required container dependencies", async () => {
      const { getContainer } = await import("@/bootstrap/container");

      const container = getContainer();

      expect(container).toHaveProperty("log");
      expect(container).toHaveProperty("llmService");
      expect(container).toHaveProperty("clock");
      expect(container.llmService.completion).toBeTypeOf("function");
    });
  });
});
