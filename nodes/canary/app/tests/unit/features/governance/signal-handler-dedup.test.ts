// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/signal-handler-dedup`
 * Purpose: Unit tests for tx hash dedup logic in signal handler.
 * Scope: Tests in-memory dedup Set — does not test RPC calls or GitHub API.
 * Invariants: TX_HASH_DEDUP — same tx hash is executed at most once.
 * Side-effects: none
 * Links: src/features/governance/services/signal-handler.ts
 * @public
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  hasTxBeenExecuted,
  markTxExecuted,
  resetTxDedup,
} from "@/features/governance/services/signal-handler";

describe("features/governance/signal-handler dedup", () => {
  afterEach(() => {
    resetTxDedup();
  });

  it("reports tx as not executed initially", () => {
    expect(hasTxBeenExecuted("0xabc123")).toBe(false);
  });

  it("reports tx as executed after marking", () => {
    markTxExecuted("0xabc123");
    expect(hasTxBeenExecuted("0xabc123")).toBe(true);
  });

  it("is case-insensitive", () => {
    markTxExecuted("0xABC123");
    expect(hasTxBeenExecuted("0xabc123")).toBe(true);
  });

  it("resets correctly", () => {
    markTxExecuted("0xabc123");
    resetTxDedup();
    expect(hasTxBeenExecuted("0xabc123")).toBe(false);
  });
});
