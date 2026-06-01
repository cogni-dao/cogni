// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/test/ai-telemetry/fake-ai-telemetry.adapter`
 * Purpose: In-memory test double for AiTelemetryPort.
 * Scope: Records invocations in memory for test assertions. Does NOT write to DB.
 * Invariants: Thread-safe via simple array; reset between tests.
 * Side-effects: none
 * Notes: Used by unit tests that need to verify telemetry recording.
 * Links: AiTelemetryPort
 * @public
 */

import type { AiTelemetryPort, RecordInvocationParams } from "@/ports";

/**
 * In-memory test double for AiTelemetryPort.
 * Records invocations in memory for test assertions.
 */
export class FakeAiTelemetryAdapter implements AiTelemetryPort {
  /** Recorded invocations for test assertions */
  readonly invocations: RecordInvocationParams[] = [];

  async recordInvocation(params: RecordInvocationParams): Promise<void> {
    this.invocations.push(params);
  }

  /** Reset recorded invocations between tests */
  reset(): void {
    this.invocations.length = 0;
  }

  /** Get invocations by status */
  getByStatus(status: "success" | "error"): RecordInvocationParams[] {
    return this.invocations.filter((i) => i.status === status);
  }

  /** Get last recorded invocation (or undefined if none) */
  getLast(): RecordInvocationParams | undefined {
    return this.invocations[this.invocations.length - 1];
  }
}
