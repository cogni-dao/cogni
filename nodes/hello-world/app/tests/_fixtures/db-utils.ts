// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@_fixtures/db-utils`
 * Purpose: Test utilities for database value type conversions.
 * Scope: Helpers for normalizing Drizzle bigint types to JS numbers in test assertions. Does not handle production type conversions.
 * Invariants: Safe for values < 2^53 (JavaScript safe integer limit)
 * Side-effects: none (pure functions)
 * Notes: Use for test assertions only; production code should preserve bigint types.
 * Links: tests/stack/payments/numeric-flow.stack.test.ts
 * @public
 */

/**
 * Convert bigint or number to number for test assertions.
 *
 * DB columns use BIGINT → Drizzle returns bigint in TypeScript.
 * Tests use number for convenience. Safe because max values < 2^53.
 *
 * @param x - Value from database (bigint) or expected value (number)
 * @returns JavaScript number
 */
export const asNumber = (x: bigint | number): number =>
  typeof x === "bigint" ? Number(x) : x;
