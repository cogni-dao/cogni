// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/goal-metrics`
 * Purpose: Operator composition of the published @cogni-dao/metrics 0.3.0 goal-metric service.
 * Scope: Binds this node's id. Calculators, budgets and the source allow-list live in
 *   `@cogni-dao/metrics/knowledge`; nothing here re-implements them.
 * Invariants:
 *   - RELEASE_OWNS_BEHAVIOR: metric computation, assessment and goal progress come from the package.
 *   - NODE_SCOPED_OBSERVATIONS: observations are scoped to `getNodeId()` + the deploy environment.
 * Side-effects: none (factory only)
 * Links: hub adopt-node-package-release, story.0021
 * @internal
 */

import {
  createGoalProgressReader,
  createGoalSource,
  createGoalMetrics as createPublishedGoalMetrics,
} from "@cogni-dao/metrics/knowledge";
import type { Sql } from "postgres";
import { getNodeId } from "@/shared/config";

export { createGoalProgressReader, createGoalSource };

export function createGoalMetrics(deps: {
  knowledgeSql: Sql;
  observationsSql: Sql;
  environment: string;
  log(event: object): void;
}) {
  return createPublishedGoalMetrics({ ...deps, node: getNodeId() });
}
