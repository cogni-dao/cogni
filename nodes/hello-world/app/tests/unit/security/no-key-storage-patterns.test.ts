// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/security/no-key-storage-patterns`
 * Purpose: CI guard test that prevents re-introduction of key storage patterns in the src directory.
 * Scope: Scans source files for banned patterns related to virtual key storage. Does NOT test runtime behavior.
 * Invariants: MVP uses service-auth mode - no key storage column or sentinels in src/**
 * Side-effects: process.env (read-only file scan via child_process)
 * Notes: When real API keys are introduced, update allowlist in this file.
 * Links: docs/spec/security-auth.md, src/shared/db/schema.billing.ts
 * @public
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(__dirname, "../../../src");

/**
 * Patterns that indicate key storage was re-added.
 * If any of these patterns match in src/**, the test fails.
 */
const BANNED_PATTERNS = [
  // Column definition in schema
  { pattern: "litellm_virtual_key", description: "key storage column name" },
  { pattern: "litellmVirtualKey", description: "key storage field name" },
  // Sentinel values (MVP used these before dropping column)
  {
    pattern: "\\[master-key-mode\\]",
    description: "sentinel value for master key mode",
  },
  {
    pattern: "MASTER_KEY_MODE_SENTINEL",
    description: "sentinel constant name",
  },
];

/**
 * Files explicitly allowed to contain these patterns (e.g., this test file, docs, migrations).
 * Uses path suffix matching.
 */
const ALLOWLIST = [
  // This test file itself
  "tests/unit/security/no-key-storage-patterns.test.ts",
  // Migration files may reference dropped columns in comments
  "src/adapters/server/db/migrations/",
];

function isAllowlisted(filepath: string): boolean {
  return ALLOWLIST.some((allowed) => filepath.includes(allowed));
}

describe("Security CI Guard: No key storage patterns in src/**", () => {
  for (const { pattern, description } of BANNED_PATTERNS) {
    it(`MUST NOT contain ${description} (${pattern})`, () => {
      let output: string;
      try {
        // Use grep to find matches in src/
        // -r recursive, -l files only, -E extended regex
        output = execSync(`grep -rlE '${pattern}' '${SRC_DIR}'`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch (_e) {
        // grep returns exit code 1 when no matches found - this is expected/good
        output = "";
      }

      // Filter out allowlisted files
      const matches = output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .filter((filepath) => !isAllowlisted(filepath));

      if (matches.length > 0) {
        throw new Error(
          `Found banned pattern "${pattern}" (${description}) in src/**:\n` +
            matches.map((f) => `  - ${f}`).join("\n") +
            "\n\nThis pattern indicates key storage was re-added. " +
            "MVP uses service-auth mode with no key storage. " +
            "If you are intentionally adding real API key support, update the allowlist in this test."
        );
      }

      expect(matches).toHaveLength(0);
    });
  }
});
