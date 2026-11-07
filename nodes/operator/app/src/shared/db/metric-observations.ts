// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/db/metric-observations`
 * Purpose: Operator-local re-export of the goal-metric evidence tables owned by the published
 *   @cogni-dao/metrics 0.3.0 schema, so drizzle-kit tracks them for the operator Postgres.
 * Scope: Re-exports only. The metrics package defines the tables; migrations and pool ownership stay here.
 * Invariants: METRIC_TABLES_FORCE_RLS — both tables are service-role-only (ENABLE + FORCE, no policy);
 *   the FORCE statements are hand-appended to the generated migration.
 * Side-effects: none
 * Links: hub adopt-node-package-release, hub node-schema-update-contract, story.0021
 * @public
 */

export {
  metricObservations,
  metricRefreshCursors,
} from "@cogni-dao/metrics/schema";
