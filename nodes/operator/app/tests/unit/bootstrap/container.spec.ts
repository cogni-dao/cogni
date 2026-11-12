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
    it("refuses missing EVM configuration before constructing providers", async () => {
      Object.assign(process.env, PRODUCTION_VALID_ENV);
      delete process.env.EVM_RPC_URL;
      const adapters = await import("@/adapters/server");
      const db = vi.spyOn(adapters, "getAppDb");
      const { getContainer } = await import("@/bootstrap/container");

      expect(() => getContainer()).toThrow(/EVM_RPC_URL/);
      expect(db).not.toHaveBeenCalled();
      db.mockRestore();
    });
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

    it("starts own-charter (self) governance sync immediately and the full (all) sync only after the catalog projection succeeds", async () => {
      let resolveCatalog: (() => void) | undefined;
      const catalogReady = new Promise<void>((resolve) => {
        resolveCatalog = resolve;
      });
      const startCatalogRegistryReconcileOnBoot = vi.fn(() => catalogReady);
      const startGovernanceSyncOnBoot = vi.fn();
      vi.doMock("@/bootstrap/catalog-registry-reconcile", () => ({
        startCatalogRegistryReconcileOnBoot,
      }));
      vi.doMock("@/bootstrap/startup-reconcile", () => ({
        startGovernanceSyncOnBoot,
      }));

      const { getContainer } = await import("@/bootstrap/container");
      getContainer();

      expect(startCatalogRegistryReconcileOnBoot).toHaveBeenCalledOnce();
      // SELF_FIRST: the operator's own charters never wait on the fleet registry.
      expect(startGovernanceSyncOnBoot).toHaveBeenCalledTimes(1);
      expect(startGovernanceSyncOnBoot).toHaveBeenCalledWith("self");

      resolveCatalog?.();
      await vi.waitFor(() => {
        expect(startGovernanceSyncOnBoot).toHaveBeenCalledTimes(2);
      });
      expect(startGovernanceSyncOnBoot).toHaveBeenLastCalledWith("all");

      vi.doUnmock("@/bootstrap/catalog-registry-reconcile");
      vi.doUnmock("@/bootstrap/startup-reconcile");
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
      expect(container.llmService.completionStream).toBeTypeOf("function");
    });
  });
});

describe("native startup local preflight", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      ...PRODUCTION_VALID_ENV,
      NEXT_RUNTIME: "nodejs",
    };
    delete process.env.LITELLM_BASE_URL;
    vi.doMock("@opentelemetry/sdk-node", () => ({
      NodeSDK: class {
        start() {}
      },
      tracing: { NoopSpanProcessor: class {} },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@opentelemetry/sdk-node");
    process.env = ORIGINAL_ENV;
  });

  it("invokes preflight and allows typed configuration refusal for diagnostics", async () => {
    delete process.env.EVM_RPC_URL;
    const preflight = await import("@/shared/env/local-readiness-preflight");
    const assertion = vi.spyOn(preflight, "localReadinessPreflight");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const { register } = await import("@/instrumentation.node");
    await expect(register()).resolves.toBeUndefined();
    expect(assertion).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it("treats a typed SDK failure as fatal, outside local preflight", async () => {
    const { RuntimeSecretError } = await import("@/shared/env/invariants");
    const failure = new RuntimeSecretError("SDK failure");
    vi.doMock("@opentelemetry/sdk-node", () => ({
      NodeSDK: class {
        start() {
          throw failure;
        }
      },
      tracing: { NoopSpanProcessor: class {} },
    }));
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const { register } = await import("@/instrumentation.node");
    await expect(register()).rejects.toBe(failure);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it.each([
    "tls",
    "path",
  ] as const)("exits and retains the original %s invariant error", async (kind) => {
    if (kind === "tls")
      process.env.DATABASE_URL =
        "postgresql://app_user:password@remote.example:5432/test_db";
    else process.env.COGNI_REPO_PATH = "/nonexistent/readiness-preflight-test";
    const preflight = await import("@/shared/env/local-readiness-preflight");
    let original: unknown;
    try {
      preflight.localReadinessPreflight();
    } catch (error) {
      original = error;
    }
    expect(original).toBeInstanceOf(Error);
    const assertion = vi
      .spyOn(preflight, "localReadinessPreflight")
      .mockImplementation(() => {
        throw original;
      });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const { register } = await import("@/instrumentation.node");
    await expect(register()).rejects.toBe(original);
    expect(assertion).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
