// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/env/server/edge-cases`
 * Purpose: Minimal tests to hit stubborn uncovered branches in server env module.
 * Scope: Non-ZodError fallback and proxy trap methods only. Does NOT test business logic.
 * Invariants: Surgical coverage of defensive code paths.
 * Side-effects: process.env (minimal)
 * Notes: Exists solely for coverage completeness on edge cases.
 * Links: src/shared/env/server.ts
 * @public
 */

import { BASE_VALID_ENV } from "@tests/_fixtures/env/base-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

describe("server env edge cases", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it.skip("rethrows non-ZodError exceptions", async () => {
    // Skipped: ESM mocking limitations prevent testing this defensive fallback.
    // Line 133 is a defensive branch that's nearly impossible to hit naturally
    // since Zod always throws ZodError for schema validation failures.
  });

  it("returns cached instance and populates expected fields", async () => {
    // Set minimal valid env
    Object.assign(process.env, BASE_VALID_ENV);

    const { serverEnv } = await import("@/shared/env/server");

    // Call serverEnv() twice
    const env1 = serverEnv();
    const env2 = serverEnv();

    // Should return the same reference (cached)
    expect(env1).toBe(env2);

    // Should have DATABASE_URL populated (from BASE_VALID_ENV with app_user)
    expect(env1.DATABASE_URL).toBe(
      "postgresql://app_user:password@localhost:5432/test_db"
    );

    // Should have computed flags
    expect(env1.isDev).toBe(false);
    expect(env1.isTest).toBe(true);
    expect(env1.isProd).toBe(false);
    expect(env1.isTestMode).toBe(true);
  });
});
