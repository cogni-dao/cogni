// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/users.profile.v1.contract`
 * Purpose: Validates Zod schemas for profile update input constraints (displayName max length, avatarColor hex).
 * Scope: Pure Zod schema validation. Does not test DB constraints or HTTP transport.
 * Invariants: displayName max 50 chars; avatarColor must be 7-char hex (#RRGGBB); both nullable.
 * Side-effects: none
 * Links: src/contracts/users.profile.v1.contract.ts
 * @internal
 */

import { profileUpdateOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const parse = (input: unknown) => profileUpdateOperation.input.safeParse(input);

describe("profileUpdateOperation.input", () => {
  describe("displayName", () => {
    it("accepts a valid display name", () => {
      expect(parse({ displayName: "Alice" }).success).toBe(true);
    });

    it("accepts exactly 50 characters", () => {
      expect(parse({ displayName: "a".repeat(50) }).success).toBe(true);
    });

    it("rejects 51 characters", () => {
      expect(parse({ displayName: "a".repeat(51) }).success).toBe(false);
    });

    it("accepts null (clears display name)", () => {
      expect(parse({ displayName: null }).success).toBe(true);
    });

    it("accepts omitted key (no change)", () => {
      expect(parse({}).success).toBe(true);
    });
  });

  describe("avatarColor", () => {
    it("accepts a valid hex color", () => {
      expect(parse({ avatarColor: "#1a2B3c" }).success).toBe(true);
    });

    it("rejects missing hash", () => {
      expect(parse({ avatarColor: "1a2B3c" }).success).toBe(false);
    });

    it("rejects 3-digit shorthand", () => {
      expect(parse({ avatarColor: "#abc" }).success).toBe(false);
    });

    it("rejects 8-digit hex (with alpha)", () => {
      expect(parse({ avatarColor: "#1a2B3cFF" }).success).toBe(false);
    });

    it("rejects non-hex characters", () => {
      expect(parse({ avatarColor: "#gggggg" }).success).toBe(false);
    });

    it("accepts null (clears avatar color)", () => {
      expect(parse({ avatarColor: null }).success).toBe(true);
    });
  });
});
