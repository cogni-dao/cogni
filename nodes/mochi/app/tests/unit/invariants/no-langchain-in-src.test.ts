// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/invariants/no-langchain-in-src`
 * Purpose: Tripwire test verifying NO_LANGCHAIN_IN_SRC invariant.
 * Scope: Grep-based smoke test ensuring @langchain imports stay in packages/langgraph-graphs/. Does NOT verify runtime behavior or import correctness.
 * Invariants:
 *   - NO_LANGCHAIN_IN_SRC: src/** must not import @langchain/* (except SDK in dev adapter)
 *   - OFFICIAL_SDK_ONLY: @langchain/langgraph-sdk allowed in langgraph dev adapter
 * Side-effects: none (read-only grep)
 * Links: LANGGRAPH_AI.md, GRAPH_EXECUTION.md, LANGGRAPH_SERVER.md
 * @internal
 */

import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("NO_LANGCHAIN_IN_SRC invariant", () => {
  it("@langchain imports only exist in packages/, not in src/", () => {
    // Grep src/ for @langchain imports (excluding comments and type-only imports)
    // Using grep with ERE for better pattern matching
    const result = execSync(
      `grep -rn "@langchain" src/ --include='*.ts' --include='*.tsx' 2>/dev/null || true`,
      { encoding: "utf-8", cwd: process.cwd() }
    );

    // Filter out lines that are:
    // - Comments (// or * at start after line number)
    // - Empty lines
    // - Allowed SDK imports in langgraph dev adapter (per OFFICIAL_SDK_ONLY)
    const actualImports = result
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        // Extract file path and content (format: "file:num:content")
        const match = line.match(/^([^:]+):\d+:(.*)$/);
        if (!match) return false;
        const filePath = match[1];
        const content = match[2].trim();

        // Skip if it's a comment
        if (content.startsWith("//")) return false;
        if (content.startsWith("*")) return false;
        if (content.startsWith("/*")) return false;

        // Skip documentation references (in JSDoc or module headers)
        if (content.includes("@langchain/*")) return false;

        // Per OFFICIAL_SDK_ONLY: Allow @langchain/langgraph-sdk in langgraph dev adapter
        // This is the only allowed SDK import outside packages/
        if (
          filePath.includes("src/adapters/server/ai/langgraph/dev/") &&
          content.includes("@langchain/langgraph-sdk")
        ) {
          return false;
        }

        return true;
      });

    // Should be empty - no actual @langchain imports in src/
    if (actualImports.length > 0) {
      console.log("Found @langchain imports in src/:");
      for (const line of actualImports) {
        console.log(`  ${line}`);
      }
    }

    expect(actualImports).toEqual([]);
  });
});
