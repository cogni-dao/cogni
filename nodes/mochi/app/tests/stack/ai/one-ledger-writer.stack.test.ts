// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/one-ledger-writer.stack`
 * Purpose: Verify ONE_LEDGER_WRITER invariant via static analysis.
 * Scope: Ensures only billing.ts calls accountService.recordChargeReceipt(). Does not test runtime behavior.
 * Invariants:
 *   - ONE_LEDGER_WRITER: Only billing.ts may call recordChargeReceipt
 * Side-effects: IO (grep subprocess)
 * Notes: Complements depcruise rule. Catches call sites that depcruise's import-based analysis might miss.
 * Links: GRAPH_EXECUTION.md, billing.ts
 * @public
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("ONE_LEDGER_WRITER Invariant", () => {
  it("only billing.ts calls recordChargeReceipt", () => {
    // Search for actual method calls (not interface definitions or docs)
    const result = execSync(
      "grep -rn '\\.recordChargeReceipt(' src/ --include='*.ts' || true",
      { encoding: "utf-8", cwd: join(process.cwd(), "nodes/operator/app") }
    );

    const callSites = result
      .split("\n")
      .filter(Boolean)
      // Allowed: billing.ts (the sole ledger writer)
      .filter((line) => !line.includes("billing.ts"))
      // Allowed: port interface definition
      .filter((line) => !line.includes(".port.ts"))
      // Allowed: adapter implementation (implements the port)
      .filter((line) => !line.includes(".adapter.ts"))
      // Allowed: AGENTS.md documentation
      .filter((line) => !line.includes("AGENTS.md"));

    // If any call sites remain, they violate ONE_LEDGER_WRITER
    if (callSites.length > 0) {
      console.error(
        "ONE_LEDGER_WRITER violation! recordChargeReceipt called from:",
        callSites
      );
    }

    expect(callSites).toEqual([]);
  });

  it("billing.ts is the only feature file importing AccountService for writes", () => {
    // Verify billing.ts imports AccountService
    const billingImports = execSync(
      "grep -n 'AccountService' src/features/ai/services/billing.ts || true",
      { encoding: "utf-8", cwd: join(process.cwd(), "nodes/operator/app") }
    );

    expect(billingImports).toContain("AccountService");

    // Verify no other feature files call recordChargeReceipt
    // (completion.ts, ai_runtime.ts, etc. may import AccountService for read-only ops)
    const otherCallSites = execSync(
      "grep -rn 'recordChargeReceipt' src/features/ --include='*.ts' | grep -v billing.ts | grep -v AGENTS.md || true",
      { encoding: "utf-8", cwd: join(process.cwd(), "nodes/operator/app") }
    );

    const violations = otherCallSites.split("\n").filter(Boolean);
    expect(violations).toEqual([]);
  });
});
