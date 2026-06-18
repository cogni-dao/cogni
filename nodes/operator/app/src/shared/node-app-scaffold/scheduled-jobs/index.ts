// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/scheduled-jobs`
 * Purpose: Public barrel for the `defineScheduledJob` node-dev API. A node dev imports
 *   `defineScheduledJob` from here and writes ONE function — never a route, token,
 *   NodeTaskWorkflow, queue, or HTTP call.
 * Scope: Re-exports only.
 * Side-effects: none
 * Links: ./registry, ./types
 * @public
 */

export {
  __resetScheduledJobRegistryForTest,
  defineScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  runScheduledJob,
} from "./registry";
export type {
  JobLogger,
  ScheduledJobContext,
  ScheduledJobDefinition,
  ScheduledJobRun,
} from "./types";
