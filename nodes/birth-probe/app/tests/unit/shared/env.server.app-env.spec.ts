// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/env/server`
 * Purpose: Verifies APP_ENV validation - required field with specific enum values.
 * Scope: Tests APP_ENV requirement and valid values. Does NOT test other env validation.
 * Invariants: Module cache reset between tests; clean env state; validation errors for missing/invalid APP_ENV.
 * Side-effects: process.env
 * Notes: Uses vi.resetModules() to force re-evaluation; minimal required env to isolate APP_ENV validation.
 * Links: src/shared/env/server.ts
 * @public
 */

import {
  BASE_VALID_ENV,
  PRODUCTION_VALID_ENV,
} from "@tests/_fixtures/env/base-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

describe("serverEnv APP_ENV validation", () => {
  beforeEach(() => {
    vi.resetModules(); // ensure we re-evaluate the module each test
    process.env = { ...ORIGINAL_ENV }; // fresh copy
    delete process.env.AUTH_SECRET;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV; // restore
  });

  it("allows APP_ENV=test", async () => {
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      NODE_ENV: "development",
    });

    const { serverEnv } = await import("@/shared/env/server");

    expect(() => serverEnv()).not.toThrow();
  });

  it("allows APP_ENV=production", async () => {
    Object.assign(process.env, {
      ...PRODUCTION_VALID_ENV,
      NODE_ENV: "production",
    });

    const { serverEnv } = await import("@/shared/env/server");

    expect(() => serverEnv()).not.toThrow();
  });

  it("throws EnvValidationError when APP_ENV is missing", async () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      // APP_ENV intentionally missing
      DATABASE_URL: "postgres://test",
      LITELLM_MASTER_KEY: "test-key",
    });

    // Ensure APP_ENV is truly missing (global setup might have set it)
    delete process.env.APP_ENV;

    const { serverEnv, EnvValidationError } = await import(
      "@/shared/env/server"
    );

    expect(() => serverEnv()).toThrow(EnvValidationError);

    try {
      serverEnv();
      expect.fail("Expected serverEnv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const envError = error as InstanceType<typeof EnvValidationError>;
      expect(envError.meta.invalid).toContain("APP_ENV");
    }
  });
});
