// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/no-direct-completion-executestream.stack`
 * Purpose: Verify BILLABLE_AI_THROUGH_EXECUTOR invariant via static analysis.
 * Scope: Ensures executeStream() is only called from allowlisted adapter/definition files. Does not test runtime behavior.
 * Invariants:
 *   - BILLABLE_AI_THROUGH_EXECUTOR: All billable AI execution must flow through AiRuntimeService → GraphExecutorPort
 *   - Direct completion.executeStream() calls outside executor internals bypass billing/telemetry pipeline
 * Side-effects: IO (grep subprocess)
 * Notes: Complements ONE_LEDGER_WRITER. Catches call sites that would silently skip billing.
 * Links: GRAPH_EXECUTION.md, inproc-completion-unit.adapter.ts, completion.ts
 * @public
 */

import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Allowlisted paths that may call executeStream().
 * Update this list explicitly when adding new adapters/runtimes.
 */
const ALLOWLIST = [
  // Definition of executeStream itself
  "src/features/ai/services/completion.ts",
  // InProcCompletionUnitAdapter wraps executeStream for completion units
  "src/adapters/server/ai/inproc-completion-unit.adapter.ts",
];

describe("BILLABLE_AI_THROUGH_EXECUTOR Invariant", () => {
  it("executeStream() only called from allowlisted executor/adapter files", () => {
    // Search for actual method calls (not type definitions or docs)
    // Scope: src/ only (exclude tests/)
    const result = execSync(
      "grep -rn '\\.executeStream(' src/ --include='*.ts' || true",
      { encoding: "utf-8", cwd: process.cwd() }
    );

    const callSites = result
      .split("\n")
      .filter(Boolean)
      // Filter out allowlisted paths
      .filter((line) => !ALLOWLIST.some((allowed) => line.includes(allowed)))
      // Filter out type-only references (import type, interface, type alias)
      .filter((line) => !line.includes("import type"))
      .filter((line) => !line.includes(": ExecuteStream"))
      .filter((line) => !line.includes("ExecuteStreamParams"));

    // If any call sites remain, they violate BILLABLE_AI_THROUGH_EXECUTOR
    if (callSites.length > 0) {
      console.error(
        "BILLABLE_AI_THROUGH_EXECUTOR violation! executeStream() called from non-allowlisted files:",
        callSites
      );
      console.error(
        "\nAll billable AI execution must flow through AiRuntimeService → GraphExecutorPort."
      );
      console.error(
        "If this is a new adapter/runtime, add it to the ALLOWLIST in this test.\n"
      );
    }

    expect(callSites).toEqual([]);
  });

  it("executeStream is not re-exported from public facades", () => {
    // Verify executeStream is not exposed via app facades (would bypass executor)
    const facadeExports = execSync(
      "grep -rn 'executeStream' src/app/_facades/ --include='*.ts' || true",
      { encoding: "utf-8", cwd: process.cwd() }
    );

    const violations = facadeExports
      .split("\n")
      .filter(Boolean)
      // Allow import for passing to adapter factory (bootstrap pattern)
      .filter((line) => !line.includes("import {"))
      .filter((line) => !line.includes("import type"))
      // Allow passing as argument to factory
      .filter(
        (line) => !line.includes("createInProcGraphExecutor(executeStream")
      )
      // Disallow: export { executeStream } or return executeStream
      .filter(
        (line) =>
          line.includes("export") ||
          (line.includes("return") && line.includes("executeStream"))
      );

    if (violations.length > 0) {
      console.error(
        "executeStream must not be re-exported from facades:",
        violations
      );
    }

    expect(violations).toEqual([]);
  });
});
