// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/clock.port`
 * Purpose: Time abstraction for deterministic testing.
 * Scope: Provides current time in ISO format for domain layer. Does not handle timezone conversion or date arithmetic.
 * Invariants: Always returns ISO 8601 string format
 * Side-effects: none (interface only)
 * Notes: Enables time injection for pure domain layer
 * Links: Implemented by adapters, used by features
 * @public
 */

export interface Clock {
  /**
   * Get current time as ISO 8601 string
   * @returns Current timestamp in ISO format
   */
  now(): string;
}
