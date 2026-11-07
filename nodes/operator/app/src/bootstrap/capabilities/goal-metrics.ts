// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/goal-metrics`
 * Purpose: Operator composition of the published @cogni-dao/metrics 0.4.0 goal-metric service.
 * Scope: Binds this node's id and registers the operator's node-local delivery calculators
 *   (`deploy.serving-drift@1`, `deploy.release-success@1`, `deploy.lead-time@1`, task.5442) over the
 *   node-deploy release store. Package calculators, budgets enforcement and the engine live in
 *   `@cogni-dao/metrics/knowledge`; nothing here re-implements them.
 * Invariants:
 *   - RELEASE_OWNS_BEHAVIOR: metric computation, assessment and goal progress come from the package.
 *   - NODE_SCOPED_OBSERVATIONS: observations are scoped to `getNodeId()` + the deploy environment.
 *   - NODE_CALCULATORS_READ_OWN_TABLES: the delivery calculators read only the operator's own release
 *     store and public HTTP probes (node-member metadata or public data), never Prometheus.
 * Side-effects: none (factory only)
 * Links: hub adopt-node-package-release, story.0021, task.5442, features/node-deploy/delivery-kpis.ts
 * @internal
 */

import {
  createGoalProgressReader,
  createGoalSource,
  createGoalMetrics as createPublishedGoalMetrics,
} from "@cogni-dao/metrics/knowledge";
import type { Sql } from "postgres";
import { DeliveryKpiSource } from "@/adapters/server";
import { createDeliveryCalculators } from "@/features/node-deploy/delivery-kpis";
import { getNodeId } from "@/shared/config";

export { createGoalProgressReader, createGoalSource };

export function createGoalMetrics(deps: {
  knowledgeSql: Sql;
  observationsSql: Sql;
  /** The operator Postgres that holds `node_workload_*` (the node-deploy release store). */
  releaseStoreSql: Sql;
  /** The operator's own public host (`APP_BASE_URL`): the drift calculator's egress control probe. */
  controlHost: string | undefined;
  environment: string;
  log(event: object): void;
}) {
  const { releaseStoreSql, controlHost, ...rest } = deps;
  return createPublishedGoalMetrics({
    ...rest,
    node: getNodeId(),
    nodeCalculators: createDeliveryCalculators(
      new DeliveryKpiSource(releaseStoreSql),
      { controlHost }
    ),
  });
}
