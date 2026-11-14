// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/lint/eslint/adapters`
 * Purpose: Verifies adapters layer infrastructure-only boundaries and restrictions.
 * Scope: Covers adapters->ports->core connections only. Does NOT test external SDK integration.
 * Invariants: Adapters implement port interfaces using core types; no business logic or UI.
 * Side-effects: IO (via runEslint temp file creation)
 * Notes: Tests boundaries/element-types rule for infrastructure layer isolation.
 * Links: eslint.config.mjs boundaries settings, src/adapters/, https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
 * @public
 */

import { describe, expect, it } from "vitest";

import { lintFixture } from "./runBiome";

// TODO: Migrate to Biome - waiting for corresponding commit
// TODO: Migrate to Biome - waiting for corresponding commit

describe.skip("Adapters Layer Infrastructure Boundaries", () => {
  describe("Allowed imports", () => {
    it("allows adapters importing port types", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/adapters/server/ai/litellm.adapter.ts",
        `import type { LlmService } from "@/ports"; export class LiteLlmAdapter implements LlmService {};`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it.skip("allows adapters importing core types", async () => {
      // SKIP: ESLint boundaries plugin incorrectly blocks adapters→core type imports
      // Expected: 0 errors (should be allowed), Actual: 1 error (blocked by plugin)
      const { errors } = await lintFixture(
        "nodes/operator/app/src/adapters/server/ai/litellm.adapter.ts",
        `import type { Message } from "@/core"; export class LiteLlmAdapter { process(msg: Message) {} };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows adapters importing shared utilities", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/adapters/server/db/drizzle.adapter.ts",
        `import { someUtil } from "@/shared"; export class DrizzleAdapter { init() { someUtil(); } };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows adapters importing external libraries", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/adapters/server/ai/openai.adapter.ts",
        `import OpenAI from "openai"; export class OpenAIAdapter { client = new OpenAI(); };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });
  });

  describe("Forbidden imports", () => {
    it.skip("blocks adapters importing features", async () => {
      // SKIP: ESLint boundaries plugin false negative - will address in future
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/adapters/server/ai/litellm.adapter.ts",
        `import { execute } from "@/features/ai/services/complete"; export default execute;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it.skip("blocks adapters importing app layer", async () => {
      // SKIP: ESLint boundaries plugin fails to block adapters→app imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/adapters/server/auth/clerk.adapter.ts",
        `import { NextRequest } from "next/server"; export class ClerkAdapter { handle(req: NextRequest) {} };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it("blocks adapters importing components", async () => {
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/adapters/server/ui/renderer.adapter.ts",
        `import { Button } from "@/components"; export default Button;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it("blocks adapters importing bootstrap", async () => {
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/adapters/server/cache/redis.adapter.ts",
        `import { container } from "@/bootstrap/container"; export default container;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });
  });
});
