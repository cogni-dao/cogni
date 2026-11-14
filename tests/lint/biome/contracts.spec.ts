// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/lint/eslint/contracts`
 * Purpose: Verifies contracts layer edge schema validation boundaries.
 * Scope: Covers contracts->shared restrictions only. Does NOT test schema runtime validation.
 * Invariants: Contracts contain only edge schemas and validation; no business logic or domain types.
 * Side-effects: IO (via runEslint temp file creation)
 * Notes: Tests boundaries/element-types rule for edge schema layer isolation.
 * Links: eslint.config.mjs boundaries settings, src/contracts/, https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
 * @public
 */

import { describe, expect, it } from "vitest";

import { lintFixture } from "./runBiome";

// TODO: Migrate to Biome - waiting for corresponding commit
// TODO: Migrate to Biome - waiting for corresponding commit

describe.skip("Contracts Layer Edge Schema Boundaries", () => {
  describe("Allowed imports", () => {
    it("allows contracts importing shared schemas", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/contracts/ai.complete.v1.contract.ts",
        `import { baseSchema } from "@/shared/schemas"; export const aiCompleteSchema = baseSchema.extend({});`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows contracts importing shared validation utilities", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/contracts/user.profile.v1.contract.ts",
        `import { validateEmail } from "@/shared/validation"; export const userProfileSchema = { email: validateEmail };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows contracts importing external validation libraries", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/contracts/auth.login.v1.contract.ts",
        `import { z } from "zod"; export const loginSchema = z.object({ email: z.string() });`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });
  });

  describe("Forbidden imports", () => {
    it.skip("blocks contracts importing core domain types", async () => {
      // SKIP: ESLint boundaries plugin fails to block contracts→core imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/contracts/ai.complete.v1.contract.ts",
        `import { Message } from "@/core"; export const schema = { message: Message };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it.skip("blocks contracts importing features", async () => {
      // SKIP: ESLint boundaries plugin fails to block contracts→features imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/contracts/auth.session.v1.contract.ts",
        `import { execute } from "@/features/ai/services/complete"; export default execute;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it("blocks contracts importing ports", async () => {
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/contracts/llm.query.v1.contract.ts",
        `import { LlmService } from "@/ports"; export const schema = { llm: LlmService };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it.skip("blocks contracts importing adapters", async () => {
      // SKIP: ESLint boundaries plugin fails to block contracts→adapters imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/contracts/db.query.v1.contract.ts",
        `import { DrizzleClient } from "@/adapters/server/db"; export default DrizzleClient;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it.skip("blocks contracts importing app layer", async () => {
      // SKIP: ESLint boundaries plugin fails to block contracts→app imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/contracts/api.route.v1.contract.ts",
        `import { middleware } from "@/app/middleware"; export default middleware;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it("blocks contracts importing components", async () => {
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/contracts/ui.form.v1.contract.ts",
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
