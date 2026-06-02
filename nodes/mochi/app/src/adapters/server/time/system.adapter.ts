// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/time/system`
 * Purpose: System clock implementation for real-world time access.
 * Scope: Provides current system time in ISO format. Does not handle timezone conversion or date arithmetic.
 * Invariants: Always returns valid ISO 8601 string
 * Side-effects: IO (reads system time)
 * Notes: Real implementation for production use
 * Links: Implements Clock port
 * @internal
 */

import type { Clock } from "@/ports";

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
