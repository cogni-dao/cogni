// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/scheduled-jobs.registry`
 * Purpose: The single import barrel that loads every `defineScheduledJob` definition,
 *   populating the in-process registry. The dispatcher route and the registration
 *   helper import this so a fire / a reconcile sees all declared jobs. Adding a job =
 *   write a `definitions/<id>.job.ts` and add one import line here.
 * Scope: Side-effect imports + a typed list of declared ids. No logic.
 * Invariants:
 *   - SIDE_EFFECT_IMPORTS: importing each job module runs its defineScheduledJob call.
 *   - SINGLE_REGISTRATION_POINT: this is the only place that enumerates node jobs.
 * Side-effects: populates the scheduled-jobs registry at import time.
 * Links: ./definitions/*.job.ts, ../../shared/node-app-scaffold/scheduled-jobs
 * @public
 */

// --- Job definitions (side-effect: each registers itself) ---
import "./definitions/metrics-ingest.job";

/**
 * Declared scheduled-job ids. Keep in sync with the imports above; this is what the
 * registration helper iterates to create/reconcile schedules.
 */
export const SCHEDULED_JOB_IDS = ["metrics-ingest"] as const;

export type ScheduledJobId = (typeof SCHEDULED_JOB_IDS)[number];
