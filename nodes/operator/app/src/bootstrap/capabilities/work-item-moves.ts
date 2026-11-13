// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item-moves`
 * Purpose: Binds the work-items `moves` ports (baseline pin, read-time readings) to this node's metrics service (story.0033).
 * Scope: Maps `MetricService` reads to the two narrow work-items ports. No stores of its own; the service is resolved at call time.
 * Invariants:
 *   - WORK_ITEMS_FREE_OF_METRICS: `@cogni/work-items` never imports `@cogni-dao/metrics`; only this binding sees both.
 *   - FRESH_BASELINE: pin only a fresh successful latest attempt; preserve failures in the read projection.
 *   - DEPRECATED_IS_NOT_MISSING: `metric_not_found` (unknown or deprecated definition) throws `MoveMetricGoneError` so a read shows `metric_deprecated`; `observation_not_found` is a missing reading.
 *   - LATEST_ONLY: a read looks up the metric's latest reading and the one pinned baseline observation; no history is walked.
 *   - CHAIN_FROM_CHEAP_READS (task.0118): `context` resolves metric → KPI → goal from `describe` (definitions) and the active goals' bindings; never the goal progress read.
 *   - ABSENT_SERVICE_IS_UNAVAILABLE: with no metrics service the pin throws (the write is refused, nothing written) and the read side answers `unknown`.
 * Side-effects: IO (metrics service reads)
 * Links: packages/work-items/src/moves.ts, hub metric-foundation-design
 * @internal
 */

import {
  type MetricBaselinePort,
  MoveMetricGoneError,
  type MoveReadingPort,
} from "@cogni/work-items";
import {
  assessDirection,
  createWorkMetricReader,
  type MetricService,
  readMetricChains,
} from "@cogni-dao/metrics";
import {
  MetricError,
  type MetricObservation,
  type MetricView,
} from "@cogni-dao/metrics/contracts";
import {
  createGoalSource,
  type GoalKnowledgeReader,
} from "@cogni-dao/metrics/knowledge";

/** The metric itself is gone (unknown or deprecated), as opposed to a missing observation. */
const metricGone = (error: unknown): boolean =>
  error instanceof MetricError && error.code === "metric_not_found";

const notFound = (error: unknown): boolean =>
  error instanceof MetricError && error.status === 404;

export function createMoveMetricPorts(
  getMetrics: () => MetricService | undefined,
  /** Where the active goals live; without it a read cannot resolve the KPI chain (`context: "unavailable"`). */
  getGoals?: () => GoalKnowledgeReader | undefined
): {
  baselines: MetricBaselinePort;
  readings: MoveReadingPort;
} {
  const service = (): MetricService => {
    const metrics = getMetrics();
    if (!metrics) throw new Error("metrics service is not configured");
    return metrics;
  };
  return {
    baselines: {
      async latestObservationId(metricId, signal) {
        signal.throwIfAborted();
        return createWorkMetricReader(service()).baselineId(metricId);
      },
    },
    readings: {
      ...(getGoals
        ? {
            // CHAIN_FROM_CHEAP_READS (task.0118): metric definitions plus the active goals'
            // bindings. Never the goal progress read, which is slow and can 503.
            async context(metricIds: readonly string[], signal: AbortSignal) {
              signal.throwIfAborted();
              const goals = getGoals();
              if (!goals) throw new Error("goals reader is not configured");
              return readMetricChains({
                metrics: service(),
                goals: createGoalSource(goals, signal),
                metricIds,
                signal,
              });
            },
          }
        : {}),
      async batch(moves, signal) {
        signal.throwIfAborted();
        const result = await service().workReadBatch(
          moves.map(({ metricId, baselineObservationId }) => ({
            metricId,
            baselineObservationId,
          })),
          signal
        );
        signal.throwIfAborted();
        return result;
      },
      assess(direction, baseline, current) {
        return assessDirection(
          direction,
          baseline as MetricObservation | null,
          current as
            | (MetricObservation & { viewState?: MetricView["viewState"] })
            | null
        );
      },
      async observation(metricId, observationId, signal) {
        signal.throwIfAborted();
        try {
          return await createWorkMetricReader(service()).observation(
            metricId,
            observationId
          );
        } catch (error) {
          if (metricGone(error)) throw new MoveMetricGoneError(metricId);
          if (notFound(error)) return null;
          throw error;
        }
      },
      async latest(metricId, signal) {
        signal.throwIfAborted();
        try {
          return await createWorkMetricReader(service()).latest(metricId);
        } catch (error) {
          if (metricGone(error)) throw new MoveMetricGoneError(metricId);
          if (notFound(error)) return null;
          throw error;
        }
      },
    },
  };
}
