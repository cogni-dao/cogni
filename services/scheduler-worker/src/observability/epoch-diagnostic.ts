// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/observability/epoch-diagnostic`
 * Purpose: Write the finite shared diagnostic contract without raw errors or caller overrides.
 * Scope: Pino runtime wiring; target authority belongs to the calling closure/grant boundary.
 * Invariants: Instrumentation cannot change activity return, exception or retry behavior.
 * Side-effects: one projected stdout event when a valid target exists.
 * Links: https://cognidao.org/knowledge/node-log-proxy-contract
 * @internal
 */
import {
  buildEpochWorkerDiagnostic,
  type EpochDiagnosticTarget,
  type EpochWorkerDiagnosticData,
} from "@cogni/scheduler-core";
import type { Logger } from "./logger.js";
export function logEpochDiagnostic(
  logger: Logger,
  target: EpochDiagnosticTarget | null,
  data: EpochWorkerDiagnosticData
): void {
  if (!target) return;
  try {
    const event = buildEpochWorkerDiagnostic(
      target,
      data,
      new Date().toISOString()
    );
    logger.info(event, event.event);
  } catch {
    /* Diagnostics are best effort; never replace an activity's own result/error. */
  }
}
