// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/no-direct-completion-executestream.stack`
 * Purpose: Verify BILLABLE_AI_THROUGH_EXECUTOR invariant via static analysis.
 * Scope: Ensures the raw LlmService transport seam (executeStream + LlmService.completionStream)
 *   is only consumed from allowlisted executor-internal files, and that the removed
 *   non-streaming LlmService.completion() is never reintroduced. Does not test runtime behavior.
 * Invariants:
 *   - BILLABLE_AI_THROUGH_EXECUTOR: All billable AI execution must flow through the graph executor
 *     (completionStream facade → GraphRunWorkflow → GraphExecutorPort), never the raw LlmService port.
 *   - Direct LlmService consumption (executeStream / completionStream / completion) outside executor
 *     internals bypasses the PreflightCreditCheckDecorator + UsageCommitDecorator stack → silent
 *     post-bill with no credit gate (bug.5042 — beacon's Research/Generate panels did exactly this).
 * Side-effects: IO (grep subprocess)
 * Notes: Complements ONE_LEDGER_WRITER. Catches call sites that would silently skip the billing gate.
 * Links: graph-execution-spec, docs/guides/agent-development.md, inproc-completion-unit.adapter.ts, completion.ts
 * @public
 */

import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Allowlisted paths that may consume the raw LlmService transport (executeStream /
 * LlmService.completionStream). These are the executor-internal seam only.
 * Update this list explicitly when adding a new executor-internal adapter/runtime —
 * and only if the new path is itself wrapped by the GraphExecutorPort billing decorators.
 */
const ALLOWLIST = [
  // Definition of executeStream itself (wraps LlmService.completionStream)
  "src/features/ai/services/completion.ts",
  // InProcCompletionUnitAdapter wraps the completion stream for completion units
  "src/adapters/server/ai/inproc-completion-unit.adapter.ts",
];

/** Filter raw grep output down to real call sites outside the allowlist. */
function callSitesOutsideAllowlist(grepOutput: string): string[] {
  return (
    grepOutput
      .split("\n")
      .filter(Boolean)
      .filter((line) => !ALLOWLIST.some((allowed) => line.includes(allowed)))
      // Filter out type-only references (import type, interface, type alias, signatures)
      .filter((line) => !line.includes("import type"))
      .filter((line) => !line.includes(": ExecuteStream"))
      .filter((line) => !line.includes("ExecuteStreamParams"))
  );
}

describe("BILLABLE_AI_THROUGH_EXECUTOR Invariant", () => {
  it("executeStream() only called from allowlisted executor/adapter files", () => {
    const result = execSync(
      "grep -rn '\\.executeStream(' src/ --include='*.ts' || true",
      { encoding: "utf-8", cwd: process.cwd() }
    );

    const callSites = callSitesOutsideAllowlist(result);

    if (callSites.length > 0) {
      console.error(
        "BILLABLE_AI_THROUGH_EXECUTOR violation! executeStream() called from non-allowlisted files:",
        callSites
      );
      console.error(
        "\nAll billable AI execution must flow through the graph executor (completionStream facade)."
      );
      console.error(
        "If this is a new executor-internal adapter/runtime, add it to the ALLOWLIST in this test.\n"
      );
    }

    expect(callSites).toEqual([]);
  });

  it("LlmService.completionStream() only called from allowlisted executor/adapter files", () => {
    // The raw transport seam. A feature/route calling this directly bypasses the
    // preflight credit gate (bug.5042). `.completionStream(` (leading dot) matches
    // call sites; method definitions are `async completionStream(` (no leading dot).
    const result = execSync(
      "grep -rn '\\.completionStream(' src/ --include='*.ts' || true",
      { encoding: "utf-8", cwd: process.cwd() }
    );

    const callSites = callSitesOutsideAllowlist(result);

    if (callSites.length > 0) {
      console.error(
        "BILLABLE_AI_THROUGH_EXECUTOR violation! LlmService.completionStream() called from non-allowlisted files:",
        callSites
      );
      console.error(
        "\nNode features must call the graph executor (completionStream facade) — not the raw LlmService port."
      );
      console.error(
        "Need platform/system billing instead of end-user billing? That requires human sign-off and STILL"
      );
      console.error(
        "routes through the executor bound to a system billing account. See docs/guides/agent-development.md.\n"
      );
    }

    expect(callSites).toEqual([]);
  });

  it("the non-streaming LlmService.completion() is never reintroduced", () => {
    // completion() was removed (bug.5042): it post-billed silently with no credit
    // pre-check. A single streaming seam keeps billing/telemetry centralized.
    // Any `.completion(` call site is forbidden anywhere in src.
    const result = execSync(
      "grep -rn '\\.completion(' src/ --include='*.ts' || true",
      { encoding: "utf-8", cwd: process.cwd() }
    );

    const callSites = result.split("\n").filter(Boolean);

    if (callSites.length > 0) {
      console.error(
        "Forbidden non-streaming LlmService.completion() reintroduced:",
        callSites
      );
      console.error(
        "\nUse the graph executor (completionStream facade) and await `final` for non-streaming results.\n"
      );
    }

    expect(callSites).toEqual([]);
  });

  it("LlmService transport is not re-exported from public facades", () => {
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
