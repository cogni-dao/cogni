// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/lint/eslint/boundaries`
 * Purpose: Verifies hexagonal architecture boundaries via eslint-plugin-boundaries.
 * Scope: Covers core/ports/app/shared layer isolation. Does NOT test import resolution.
 * Invariants: Layers must respect dependency direction; no circular references.
 * Side-effects: IO (via runEslint temp file creation)
 * Notes: Tests boundaries/element-types rule enforcement across architecture layers.
 * Links: eslint.config.mjs boundaries settings, https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
 * @public
 */

import { describe, expect, it } from "vitest";

import { lintFixture } from "./runBiome";

// TODO: Migrate to Biome - waiting for corresponding commit
// TODO: Migrate to Biome - waiting for corresponding commit

describe.skip("Hexagonal Layer Boundaries", () => {
  describe("Core layer", () => {
    it("allows core importing core", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/core/auth/session.ts",
        `import { other } from "@/core/other/model"; export default other;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("blocks core importing features", async () => {
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/core/auth/session.ts",
        `import { Terminal } from "@/features/home/components/Terminal"; export default Terminal;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it("blocks core importing ports", async () => {
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/core/auth/session.ts",
        `import { LlmService } from "@/ports/llm.port"; export default LlmService;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it.skip("blocks core importing adapters", async () => {
      // SKIP: ESLint boundaries plugin fails to block core→adapters imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/core/auth/session.ts",
        `import { DbClient } from "@/adapters/server/db"; export default DbClient;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });
  });

  describe("Ports layer", () => {
    it("allows ports importing core", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/ports/auth.port.ts",
        `import { AuthSession } from "@/core/auth/session"; export type AuthPort = { session: AuthSession };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows ports importing core types via canonical entry", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/ports/user.port.ts",
        `import type { User } from "@/core"; export interface UserPort { getUser(): User; };`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it.skip("blocks ports importing adapters", async () => {
      // SKIP: ESLint boundaries plugin fails to block ports→adapters imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/ports/auth.port.ts",
        `import { DbClient } from "@/adapters/server/db"; export default DbClient;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it.skip("blocks ports importing features", async () => {
      // SKIP: ESLint boundaries plugin fails to block ports→features imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/ports/auth.port.ts",
        `import { authAction } from "@/features/auth/actions"; export default authAction;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });
  });

  describe("App layer", () => {
    it("allows app importing features", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/app/api/auth/route.ts",
        `import { authAction } from "@/features/auth/actions"; export default authAction;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows app importing features components", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/app/home/page.tsx",
        `import { Terminal } from "@/features/home/components/Terminal"; export default () => <Terminal />;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows app importing bootstrap container", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/app/api/ai/route.ts",
        `import { resolveAiDeps } from "@/bootstrap/container"; export const deps = resolveAiDeps();`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows app importing contracts", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/app/api/ai/complete/route.ts",
        `import { aiCompleteOperation } from "@/contracts/ai.complete.v1.contract"; export default aiCompleteOperation;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it("allows app importing components barrel", async () => {
      const { errors } = await lintFixture(
        "nodes/operator/app/src/app/layout.tsx",
        `import { Button } from "@/components"; export default () => <Button />;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBe(0);
    });

    it.skip("blocks app importing core directly", async () => {
      // SKIP: ESLint boundaries plugin fails to block app→core direct imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/app/api/auth/route.ts",
        `import { AuthService } from "@/core/auth/service"; export default AuthService;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });

    it.skip("blocks app importing adapters directly", async () => {
      // SKIP: ESLint boundaries plugin fails to block app→adapters direct imports
      // Expected: >0 errors (should be blocked), Actual: 0 errors (allowed by plugin)
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/app/api/data/route.ts",
        `import { LiteLlmAdapter } from "@/adapters/server/ai"; export default LiteLlmAdapter;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });
  });

  describe("Shared layer", () => {
    it("blocks shared importing features", async () => {
      const { errors, messages } = await lintFixture(
        "nodes/operator/app/src/shared/util/bad.ts",
        `import { Terminal } from "@/features/home/components/Terminal"; export default Terminal;`,
        { focusRulePrefixes: ["boundaries/"] }
      );
      expect(errors).toBeGreaterThan(0);
      expect(
        messages.some((m) => m.ruleId === "boundaries/element-types")
      ).toBe(true);
    });
  });
});
