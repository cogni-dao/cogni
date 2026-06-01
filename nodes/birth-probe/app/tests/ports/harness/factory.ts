// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ports/harness/factory`
 * Purpose: Creates shared test harness instances for port contract testing.
 * Scope: Port testing infrastructure only. Does NOT contain actual test cases.
 * Invariants: makeHarness returns TestHarness with cleanup array; dispose runs all cleanup functions.
 * Side-effects: none
 * Notes: Provides basic test infrastructure and cleanup utilities for port contract testing.
 * Links: tests/ports/harness/
 * @internal
 */

export interface TestHarness {
  // Basic test utilities
  tmpdir?: string;
  cleanup?: (() => Promise<void>)[];
}

/**
 * Creates a basic test harness.
 */
export async function makeHarness(): Promise<TestHarness> {
  const harness: TestHarness = {
    cleanup: [],
  };

  return harness;
}

/**
 * Cleans up all resources in a test harness.
 */
export async function dispose(harness: TestHarness): Promise<void> {
  if (harness.cleanup) {
    for (const cleanup of harness.cleanup) {
      await cleanup();
    }
  }
}
