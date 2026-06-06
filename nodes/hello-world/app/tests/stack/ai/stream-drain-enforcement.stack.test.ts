// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/stream-drain-enforcement.stack`
 * Purpose: Verify CALLER_DRAIN_OBLIGATION invariant via static analysis.
 * Scope: Ensures all consumer-level runGraph() call sites drain the stream (via `for await`). Does not test runtime behavior.
 * Invariants:
 *   - CALLER_DRAIN_OBLIGATION: Every runGraph() consumer must drain the stream for billing to fire
 * Side-effects: IO (grep subprocess)
 * Notes: Decorator/router call sites are excluded (they wrap and re-yield, not consume). This complements the JSDoc on GraphExecutorPort.runGraph().
 * Links: src/ports/graph-executor.port.ts, usage-commit.decorator.ts, GRAPH_EXECUTION.md
 * @public
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CALLER_DRAIN_OBLIGATION Invariant", () => {
  it("all consumer-level runGraph() call sites drain the stream", () => {
    // Find all .runGraph( call sites in src/ (production code only)
    const grepResult = execSync(
      "grep -rn '\\.runGraph(' src/ --include='*.ts' || true",
      { encoding: "utf-8", cwd: join(process.cwd(), "nodes/operator/app") }
    );

    const allSites = grepResult.split("\n").filter(Boolean);

    // Exclude infrastructure sites (decorators, routers, lazy providers) — these
    // wrap the stream and delegate to consumers, they don't consume themselves
    const infrastructurePatterns = [
      "usage-commit.decorator.ts", // wraps stream with billing
      "observability-executor.decorator.ts", // wraps stream with telemetry
      "preflight-credit-check.decorator.ts", // wraps stream with credit gate
      "aggregating-executor.ts", // routes to provider
      "graph-executor.factory.ts", // lazy provider internal delegation
      "graph-executor.port.ts", // interface definition / JSDoc
      "AGENTS.md", // documentation
    ];

    const consumerSites = allSites.filter(
      (line) => !infrastructurePatterns.some((pat) => line.includes(pat))
    );

    // Each consumer site's file must contain evidence of stream draining:
    // - `for await` pattern (explicit drain loop)
    const violations: string[] = [];

    for (const site of consumerSites) {
      const filePath = site.split(":")[0] ?? "";
      const fileContent = readFileSync(
        join(process.cwd(), "nodes/operator/app", filePath),
        "utf-8"
      );

      const hasForAwaitDrain = fileContent.includes("for await");

      if (!hasForAwaitDrain) {
        violations.push(site);
      }
    }

    if (violations.length > 0) {
      console.error(
        "CALLER_DRAIN_OBLIGATION violation! runGraph() called without stream drain:",
        violations
      );
    }

    expect(violations).toEqual([]);

    // Sanity: we should have found at least one consumer call site.
    expect(consumerSites.length).toBeGreaterThanOrEqual(1);
  });
});
