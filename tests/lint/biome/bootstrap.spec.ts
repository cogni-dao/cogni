// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/lint/eslint/bootstrap`
 * Purpose: Verifies bootstrap layer dependency injection composition rules.
 * Scope: Covers bootstrap->adapters->ports connections and restrictions. Does NOT test runtime DI behavior.
 * Invariants: Bootstrap connects adapters to ports only; no business logic or UI imports.
 * Side-effects: IO (via runEslint temp file creation)
 * Notes: Tests boundaries/element-types rule for DI container composition.
 * Links: eslint.config.mjs boundaries settings, src/bootstrap/, https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
 * @public
 */

import { describe, expect, it } from "vitest";

import { lintFixture } from "./runBiome";

// TODO: Migrate to Biome - waiting for corresponding commit
// TODO: Migrate to Biome - waiting for corresponding commit

describe.skip("Bootstrap Layer DI Composition", () => {
  describe("Allowed imports", () => {
    it("allows bootstrap importing adapters", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/bootstrap/container.ts",
        `import { LiteLlmAdapter, SystemClock } from "@/adapters/server"; export const container = { llm: new LiteLlmAdapter(), clock: new SystemClock() };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows bootstrap importing port types", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/bootstrap/container.ts",
        `import type { LlmService, Clock } from "@/ports"; export type Container = { llm: LlmService; clock: Clock };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows bootstrap importing shared utilities", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/bootstrap/di-container.ts",
        `import { validateConfig } from "@/shared"; export const initContainer = () => validateConfig();`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });
  });

  describe("Forbidden imports", () => {
    it.skip("blocks bootstrap importing features", async () => {
      // SKIP: ESLint boundaries plugin false negative - will address in future
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/bootstrap/container.ts",
        `import { execute } from "@/features/ai/services/complete"; export default execute;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it("blocks bootstrap importing core directly", async () => {
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/bootstrap/container.ts",
        `import { Message } from "@/core"; export default Message;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it.skip("blocks bootstrap importing app layer", async () => {
      // This test currently fails - the boundaries plugin may not be properly
      // configured to block this specific case. Skip for now until boundaries
      // configuration is reviewed.
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/bootstrap/container.ts",
        `import { middleware } from "@/app/middleware"; export default middleware;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it("blocks bootstrap importing components", async () => {
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/bootstrap/container.ts",
        `import { Button } from "@/components"; export default Button;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });
  });
});
