// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/fake-clock`
 * Purpose: Verifies time-sensitive module behavior under controlled time conditions.
 * Scope: Provides deterministic time control for testing. Does NOT replace system Date globally.
 * Invariants: Time advances only via explicit calls; state resets consistently; millisecond precision maintained.
 * Side-effects: none
 * Notes: Use in unit tests requiring time control; supports advance/setTime/reset operations.
 * Links: tests/setup.ts
 * @public
 */

/**
 * Fake clock implementation for deterministic unit tests.
 *
 * Provides controllable time for testing time-sensitive logic
 * without actual time dependencies.
 */
export class FakeClock {
  private currentTime: Date;

  constructor(initialTime: string | Date = "2024-01-01T00:00:00.000Z") {
    this.currentTime = new Date(initialTime);
  }

  now(): string {
    return this.currentTime.toISOString();
  }

  advance(milliseconds: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + milliseconds);
  }

  setTime(time: string | Date): void {
    this.currentTime = new Date(time);
  }

  reset(): void {
    this.currentTime = new Date("2024-01-01T00:00:00.000Z");
  }
}
