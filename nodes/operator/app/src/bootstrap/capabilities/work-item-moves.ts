// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item-moves`
 * Purpose: Binds the work-items `moves` ports (baseline pin, read-time readings) to this node's metrics service (story.0033).
 * Scope: Maps `MetricService` reads to the two narrow work-items ports. No stores of its own; the service is resolved at call time.
 * Invariants:
 *   - WORK_ITEMS_FREE_OF_METRICS: `@cogni/work-items` never imports `@cogni-dao/metrics`; only this binding sees both.
 *   - GOOD_READINGS_ONLY: a baseline pin and a latest reading are the metric's last good (`ok`, finite) observation; a failed or pending attempt is never a baseline.
 *   - DEPRECATED_IS_NOT_MISSING: `metric_not_found` (unknown or deprecated definition) throws `MoveMetricGoneError` so a read shows `metric_deprecated`; `observation_not_found` is a missing reading.
 *   - LATEST_ONLY: a read looks up the metric's latest reading and the one pinned baseline observation; no history is walked.
 *   - ABSENT_SERVICE_IS_UNAVAILABLE: with no metrics service the pin throws (the write is refused, nothing written) and the read side answers `unknown`.
 * Side-effects: IO (metrics service reads)
 * Links: packages/work-items/src/moves.ts, hub metric-foundation-design
 * @internal
 */

import {
  type MetricBaselinePort,
  MoveMetricGoneError,
  type MoveReading,
  type MoveReadingPort,
} from "@cogni/work-items";
import type { MetricService } from "@cogni-dao/metrics";
import {
  MetricError,
  type MetricObservation,
} from "@cogni-dao/metrics/contracts";

/** An observation as a work item shows it: an ok reading with a finite value and a time. */
function toReading(
  observation: MetricObservation | null | undefined
): MoveReading | null {
  if (
    !observation ||
    observation.status !== "ok" ||
    observation.value === null ||
    !Number.isFinite(observation.value) ||
    !observation.observedAt
  )
    return null;
  return { value: observation.value, observedAt: observation.observedAt };
}

/** The metric itself is gone (unknown or deprecated), as opposed to a missing observation. */
const metricGone = (error: unknown): boolean =>
  error instanceof MetricError && error.code === "metric_not_found";

const notFound = (error: unknown): boolean =>
  error instanceof MetricError && error.status === 404;

export function createMoveMetricPorts(
  getMetrics: () => MetricService | undefined
): { baselines: MetricBaselinePort; readings: MoveReadingPort } {
  const service = (): MetricService => {
    const metrics = getMetrics();
    if (!metrics) throw new Error("metrics service is not configured");
    return metrics;
  };
  return {
    baselines: {
      async latestObservationId(metricId, signal) {
        signal.throwIfAborted();
        const view = await service().read(metricId);
        return toReading(view.lastGood) ? (view.lastGood?.id ?? null) : null;
      },
    },
    readings: {
      async observation(metricId, observationId, signal) {
        signal.throwIfAborted();
        try {
          const saved = await service().observation(metricId, observationId);
          return toReading(saved.observation);
        } catch (error) {
          if (metricGone(error)) throw new MoveMetricGoneError(metricId);
          if (notFound(error)) return null;
          throw error;
        }
      },
      async latest(metricId, signal) {
        signal.throwIfAborted();
        try {
          return toReading((await service().read(metricId)).lastGood);
        } catch (error) {
          if (metricGone(error)) throw new MoveMetricGoneError(metricId);
          if (notFound(error)) return null;
          throw error;
        }
      },
    },
  };
}
