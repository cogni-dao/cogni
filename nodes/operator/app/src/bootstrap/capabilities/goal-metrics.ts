// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/goal-metrics`
 * Purpose: Operator composition of the published @cogni-dao/metrics 0.9.0 goal-metric service.
 * Scope: Binds this node's id and registers the operator's node-local calculators: delivery
 *   (`deploy.serving-drift@1`, `deploy.release-success@1`, `deploy.first-try@1`, `deploy.lead-time@1`, task.5442, bug.5617) over the
 *   node-deploy release store, the candidate queue (`delivery.candidate-backlog@1`, task.5498: open PRs from the review App's
 *   GitHub read against the release store's served SHAs), fleet uptime (`fleet.lanes-down@1`, `fleet.substrate-reach@1`,
 *   `fleet.uptime@1`, task.5457) over the same lane probes and the stored lanes-down readings, and PR review (`review.merge-coverage@1`, `review.fail-fix-rate@1`,
 *   task.5450) over the review App's check runs on the parent repo, and shared-substrate host pressure
 *   (`substrate.host-pressure@1`, bug.5613) over per-host node_exporter and k3s-kine series in Grafana Cloud Mimir, and dark
 *   node-app metrics (`fleet.lane-metrics@1`, bug.5641) over the release store's serving lanes and `up{job="node-lanes"}`. Package calculators, budgets
 *   enforcement and the engine live in `@cogni-dao/metrics/knowledge`; nothing here re-implements them.
 * Invariants:
 *   - EDGE_CAUGHT_IS_NODE_LOCAL: `edge.caught@1` (story.5148) probes each application edge host's canary and reads
 *     the Caddy access log from Loki through the operator's existing Loki reader; hosts come from the catalog
 *     roster and this operator's own env domain, never a literal.
 *   - RELEASE_OWNS_BEHAVIOR: metric computation, assessment and goal progress come from the package.
 *   - SERVES_FROM_PACKAGE (0.9.0, story.0033): a metric row's `serves` and `band` are parsed, joined under their KPI
 *     (`served`) and reported (`orphans`, `servedTruncated`, `servedUnavailable`) by the package; no operator code
 *     reads or writes them here.
 *   - NODE_SCOPED_OBSERVATIONS: observations are scoped to `getNodeId()` + the deploy environment.
 *   - NODE_CALCULATORS_READ_OWN_TABLES: the delivery calculators read only the operator's own release
 *     store and public HTTP probes (node-member metadata or public data), never Prometheus.
 *   - SUBSTRATE_READS_PROMETHEUS_DELIBERATELY: `substrate.host-pressure@1` and `fleet.lane-metrics@1` are the
 *     calculators that read Prometheus (Mimir, through `MetricsQueryPort`). Host pressure and scrape `up` exist only there. An absent reader or a
 *     Mimir failure makes its readings unavailable, never 0.
 *   - ONE_PROBE_SNAPSHOT: drift, lanes-down and substrate-reach share one per-tick probe snapshot, so a lane is
 *     probed once per tick. Uptime reads this node's own stored observations (`<node>/<environment>/` scope),
 *     read-only (task.5457).
 *   - REVIEW_IDENTITY_FROM_ENV: the review calculators take the repo from `NODE_SUBMODULE_PARENT_*` and the
 *     App id from `GH_REVIEW_APP_ID`; neither is a literal. Missing env makes a reading unavailable.
 * Side-effects: none (factory only)
 * Links: hub adopt-node-package-release, story.0021, task.5442, task.5450, bug.5613, features/node-deploy/delivery-kpis.ts,
 *   features/review/review-kpis.ts, features/substrate-health/substrate-kpis.ts
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
  GitHubCandidateBacklogSource,
  GitHubReviewKpiSource,
  REVIEW_CHECK_RUN_NAME,
} from "@/adapters/server";
import {
  createEdgeHostCatalog,
  createNodeCatalog,
} from "@/bootstrap/capabilities/node-catalog";
import { createLokiMetricReader } from "@/bootstrap/observability.factory";
import {
  createCandidateBacklogCalculators,
  parseSourceRepo,
} from "@/features/node-deploy/candidate-backlog-kpis";
import { createDeliveryCalculators } from "@/features/node-deploy/delivery-kpis";
import {
  createEdgeCaughtCalculators,
  type EdgeCaughtWindowEvent,
} from "@/features/node-deploy/edge-caught-kpis";
import { createFleetCalculators } from "@/features/node-deploy/fleet-kpis";
import { createFleetProbeSnapshots } from "@/features/node-deploy/fleet-probe-snapshot";
import { createLaneMetricsCalculators } from "@/features/node-deploy/lane-metrics-kpis";
import { MAX_LEASE_LANES } from "@/features/node-deploy/lease-metrics";
import { createReviewCalculators } from "@/features/review/review-kpis";
import { createSubstrateCalculators } from "@/features/substrate-health/substrate-kpis";
import type { MetricsQueryPort } from "@/ports";
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
  /** The Mimir instant reader for `substrate.host-pressure@1`; absent makes substrate readings unavailable. */
  prometheus?: Pick<MetricsQueryPort, "queryInstant"> | null;
  environment: string;
  log(event: object): void;
  /** One `edge_caught_window` event per `edge.caught@1` compute (story.5148). */
  logEdgeWindow(event: EdgeCaughtWindowEvent): void;
}) {
  const {
    releaseStoreSql,
    controlHost,
    review,
    prometheus,
    logEdgeWindow,
    ...rest
  } = deps;
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
      // task.5498: the candidate queue (`delivery.candidate-backlog@1`). The node repo is its catalog
      // `source_repo`; GitHub is read through the same review App as the review KPIs (no new credential).
      ...createCandidateBacklogCalculators(deliverySource, {
        repoOf: async (nodeId) =>
          parseSourceRepo(
            (
              (await createNodeCatalog().entryFor(nodeId))?.row as
                | { source_repo?: unknown }
                | undefined
            )?.source_repo
          ),
        operatorNodeId: getNodeId(),
        github:
          review.appId && review.privateKeyBase64
            ? new GitHubCandidateBacklogSource({
                appId: review.appId,
                privateKeyBase64: review.privateKeyBase64,
              })
            : undefined,
      }),
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
      ...createSubstrateCalculators({ prometheus }),
      // bug.5641 R3: node-app lanes whose metrics stop reaching Mimir. Declared lanes come from the same release-store
      // read the HTTP SD route lists; observed `up{job="node-lanes"}` from the same Mimir reader as host pressure.
      ...createLaneMetricsCalculators({
        lanes: async (env, signal) =>
          deliverySource.servingLanes({
            scope: { env },
            maxRows: MAX_LEASE_LANES,
            signal,
            nodeAppsOnly: true,
          }),
        prometheus,
      }),
    ],
  });
}
