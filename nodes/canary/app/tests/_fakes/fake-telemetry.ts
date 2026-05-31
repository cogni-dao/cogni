// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/fake-telemetry`
 * Purpose: Verifies telemetry-dependent module behavior under captured telemetry conditions.
 * Scope: Captures and stores telemetry events for verification. Does NOT send data to external services.
 * Invariants: Events/traces stored in memory; query methods return immutable copies; reset clears all data.
 * Side-effects: none
 * Notes: Use in unit tests to verify telemetry calls; supports event and trace verification.
 * Links: tests/setup.ts
 * @public
 */

/**
 * Fake telemetry implementation for unit tests.
 *
 * Captures telemetry calls for verification without
 * external service dependencies.
 */
export class FakeTelemetry {
  private events: { type: string; data: unknown; timestamp: Date }[] = [];
  private traces: { name: string; data: unknown; timestamp: Date }[] = [];

  event(type: string, data: unknown): void {
    this.events.push({ type, data, timestamp: new Date() });
  }

  trace(name: string, data: unknown): void {
    this.traces.push({ name, data, timestamp: new Date() });
  }

  getEvents(): { type: string; data: unknown; timestamp: Date }[] {
    return [...this.events];
  }

  getTraces(): { name: string; data: unknown; timestamp: Date }[] {
    return [...this.traces];
  }

  getEventCount(): number {
    return this.events.length;
  }

  getTraceCount(): number {
    return this.traces.length;
  }

  reset(): void {
    this.events = [];
    this.traces = [];
  }
}
