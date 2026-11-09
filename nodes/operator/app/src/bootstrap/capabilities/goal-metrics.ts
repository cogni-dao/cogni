// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/goal-metrics`
 * Purpose: Operator composition of the published @cogni-dao/metrics 0.6.0 goal-metric service.
 * Scope: Binds this node's id and registers the operator's node-local calculators: delivery
 *   (`deploy.serving-drift@1`, `deploy.release-success@1`, `deploy.lead-time@1`, task.5442) over the
 *   node-deploy release store, fleet uptime (`fleet.lanes-down@1`, `fleet.substrate-reach@1`,
 *   `fleet.uptime@1`, task.5457) over the same lane probes and the stored lanes-down readings, and PR review (`review.merge-coverage@1`, `review.fail-fix-rate@1`,
 *   task.5450) over the review App's check runs on the parent repo. Package calculators, budgets
 *   enforcement and the engine live in `@cogni-dao/metrics/knowledge`; nothing here re-implements them.
 * Invariants:
 *   - EDGE_CAUGHT_IS_NODE_LOCAL: `edge.caught@1` (story.5148) probes each application edge host's canary and reads
 *     the Caddy access log from Loki through the operator's existing Loki reader; hosts come from the catalog
 *     roster and this operator's own env domain, never a literal.
 *   - RELEASE_OWNS_BEHAVIOR: metric computation, assessment and goal progress come from the package.
 *   - NODE_SCOPED_OBSERVATIONS: observations are scoped to `getNodeId()` + the deploy environment.
 *   - NODE_CALCULATORS_READ_OWN_TABLES: the delivery calculators read only the operator's own release
 *     store and public HTTP probes (node-member metadata or public data), never Prometheus.
 *   - ONE_PROBE_SNAPSHOT: drift, lanes-down and substrate-reach share one per-tick probe snapshot, so a lane is
 *     probed once per tick. Uptime reads this node's own stored observations (`<node>/<environment>/` scope),
 *     read-only (task.5457).
 *   - REVIEW_IDENTITY_FROM_ENV: the review calculators take the repo from `NODE_SUBMODULE_PARENT_*` and the
 *     App id from `GH_REVIEW_APP_ID`; neither is a literal. Missing env makes a reading unavailable.
 * Side-effects: none (factory only)
 * Links: hub adopt-node-package-release, story.0021, task.5442, task.5450, features/node-deploy/delivery-kpis.ts,
 *   features/review/review-kpis.ts
 * @internal
 */

import {
  createGoalProgressReader,
  createGoalSource,
  createGoalMetrics as createPublishedGoalMetrics,
} from "@cogni-dao/metrics/knowledge";
import type { Sql } from "postgres";
import {
  DeliveryKpiSource,
  FleetObservationReader,
  GitHubReviewKpiSource,
  REVIEW_CHECK_RUN_NAME,
} from "@/adapters/server";
import { createEdgeHostCatalog } from "@/bootstrap/capabilities/node-catalog";
import { createLokiMetricReader } from "@/bootstrap/observability.factory";
import { createDeliveryCalculators } from "@/features/node-deploy/delivery-kpis";
import {
  createEdgeCaughtCalculators,
  type EdgeCaughtWindowEvent,
} from "@/features/node-deploy/edge-caught-kpis";
import { createFleetCalculators } from "@/features/node-deploy/fleet-kpis";
import { createFleetProbeSnapshots } from "@/features/node-deploy/fleet-probe-snapshot";
import { createReviewCalculators } from "@/features/review/review-kpis";
import { getNodeId } from "@/shared/config";

export { createGoalProgressReader, createGoalSource };

export function createGoalMetrics(deps: {
  knowledgeSql: Sql;
  observationsSql: Sql;
  /** The operator Postgres that holds `node_workload_*` (the node-deploy release store). */
  releaseStoreSql: Sql;
  /** The operator's own public host (`APP_BASE_URL`): the drift calculator's egress control probe. */
  controlHost: string | undefined;
  /**
   * The operator's parent repo (`NODE_SUBMODULE_PARENT_OWNER/REPO`) and the review App that writes
   * the `Cogni Git PR Review` check there (`GH_REVIEW_APP_*`). Absent parts make review readings unavailable.
   */
  review: {
    repo: { owner: string; repo: string } | undefined;
    appId: string | undefined;
    privateKeyBase64: string | undefined;
  };
  environment: string;
  log(event: object): void;
  /** One `edge_caught_window` event per `edge.caught@1` compute (story.5148). */
  logEdgeWindow(event: EdgeCaughtWindowEvent): void;
}) {
  const { releaseStoreSql, controlHost, review, logEdgeWindow, ...rest } = deps;
  const reviewRepo =
    review.appId && review.privateKeyBase64 ? review.repo : undefined;
  const deliverySource = new DeliveryKpiSource(releaseStoreSql);
  // ONE_PROBE_SNAPSHOT: drift and the fleet calculators classify the same per-tick probes.
  const snapshots = createFleetProbeSnapshots(deliverySource, { controlHost });
  return createPublishedGoalMetrics({
    ...rest,
    node: getNodeId(),
    nodeCalculators: [
      ...createDeliveryCalculators(deliverySource, { controlHost, snapshots }),
      ...createFleetCalculators({
        snapshots,
        // The package's scope key is `<node>/<environment>/<dataScope>`; read this node + environment only.
        observations: new FleetObservationReader(
          rest.observationsSql,
          `${getNodeId()}/${rest.environment}/`
        ),
      }),
      // story.5148: the edge catch-all counter. Hosts come from the catalog roster + this operator's env domain
      // (its own public host); the Loki reader is the operator's existing Grafana read credential (null = unknown).
      ...createEdgeCaughtCalculators({
        env: rest.environment,
        domain: controlHost,
        catalog: createEdgeHostCatalog(),
        probe: (input) => deliverySource.probe(input),
        loki: createLokiMetricReader(),
        log: logEdgeWindow,
      }),
      ...createReviewCalculators(
        new GitHubReviewKpiSource({
          appId: review.appId ?? "",
          privateKeyBase64: review.privateKeyBase64 ?? "",
          checkName: REVIEW_CHECK_RUN_NAME,
        }),
        { repo: reviewRepo }
      ),
    ],
  });
}
