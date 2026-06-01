// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/livez-isolation.contract`
 * Purpose: Verify /livez endpoint isolation - must work without AUTH_SECRET or full env.
 * Scope: Contract test ensuring liveness probe doesn't leak readiness requirements. Does not test functional behavior.
 * Invariants: Test MUST fail if /livez returns INVALID_ENV when AUTH_SECRET is missing.
 * Side-effects: none
 * Notes: Critical isolation guard - prevents /livez from importing serverEnv() or validation code.
 * Links: src/app/(infra)/livez/route.ts
 * @internal
 */

import { metaLivezOutputSchema } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("/livez isolation contract", () => {
  it("should work without AUTH_SECRET", async () => {
    // Arrange: Simulate minimal env (no AUTH_SECRET)
    const originalAuthSecret = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;

    try {
      // Act: Import and call GET handler
      // CRITICAL: If this throws INVALID_ENV, /livez has leaked env validation
      const { GET } = await import("@/app/(infra)/livez/route");
      const response = await GET();
      const json = await response.json();

      // Assert: Must return alive status (not INVALID_ENV error)
      expect(response.status).toBe(200);
      expect(json.status).toBe("alive");
      expect(json).toHaveProperty("timestamp");

      // Verify contract compliance
      const parsed = metaLivezOutputSchema.safeParse(json);
      expect(parsed.success).toBe(true);
    } finally {
      // Restore env
      if (originalAuthSecret !== undefined) {
        process.env.AUTH_SECRET = originalAuthSecret;
      }
    }
  });

  it("should respond fast (<100ms)", async () => {
    // Act
    const { GET } = await import("@/app/(infra)/livez/route");
    const start = Date.now();
    const response = await GET();
    const duration = Date.now() - start;

    // Assert: Liveness must be fast
    expect(response.status).toBe(200);
    expect(duration).toBeLessThan(100);
  });
});
