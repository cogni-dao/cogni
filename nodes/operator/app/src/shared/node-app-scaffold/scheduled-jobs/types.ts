// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/scheduled-jobs/types`
 * Purpose: Pure types for the `defineScheduledJob` node-dev API — the one-function
 *   surface a node dev writes for recurring work. No routes, tokens, NodeTaskWorkflow,
 *   queues, or HTTP appear here.
 * Scope: Type definitions only. No I/O, no adapters.
 * Invariants:
 *   - PURE_LAYER: lives in `shared/`, so it may import only `shared`/`types` (dep-cruiser).
 *     The logger is a structural `JobLogger`, NOT a pino import.
 *   - DEPS_ARE_GENERIC: a job's runtime dependencies (container, ports) are threaded
 *     through `ctx.deps` as a generic so this pure layer never references bootstrap.
 * Side-effects: none
 * Links: ./registry, app/api/internal/jobs/[jobId]/route.ts, bootstrap/jobs/scheduledJobs.ts
 * @public
 */

/**
 * Minimal structural logger handed to a job's `run`. Matches the shape of the
 * request-scoped pino logger the dispatcher route injects, without importing pino
 * into this pure layer.
 */
export interface JobLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Execution context handed to a scheduled job's `run`. The dispatcher route
 * constructs this on each cron dispatch; the node dev never builds it.
 *
 * @typeParam Deps - the job's runtime dependencies (e.g. the operator container).
 *   Defaults to `unknown` so a self-contained job need not declare any. AI work in
 *   `run` goes through `deps` (the existing graph executor), never workflow code.
 */
export interface ScheduledJobContext<Deps = unknown> {
  /** This job's stable id (the `id` passed to `defineScheduledJob`). */
  readonly jobId: string;
  /** The node this dispatch is scoped to (operator's `getNodeId()`). */
  readonly nodeId: string;
  /** Temporal `scheduledFor` instant for this fire, parsed from the idempotency key. */
  readonly scheduledFor: string | null;
  /** The full idempotency key the dispatch carried: `${nodeId}/${scheduleId}/${scheduledFor}`. */
  readonly idempotencyKey: string | null;
  /** Request-scoped structured logger. */
  readonly logger: JobLogger;
  /** Runtime dependencies (graph executor, ports, …) wired by the dispatcher. */
  readonly deps: Deps;
}

/**
 * The single function a node dev implements: the work, inline. No routes, no auth,
 * no idempotency, no `createSchedule` — those are the substrate the wrapper owns.
 */
export type ScheduledJobRun<Deps = unknown> = (
  ctx: ScheduledJobContext<Deps>
) => Promise<void>;

/**
 * The one-function job definition. A node dev writes exactly this:
 *
 * ```ts
 * export const metricsIngest = defineScheduledJob({
 *   id: "metrics-ingest",
 *   cron: "*\/15 * * * *",
 *   run: async (ctx) => { /* the work, inline *\/ },
 * });
 * ```
 */
export interface ScheduledJobDefinition<Deps = unknown> {
  /** Stable, URL-safe id. Becomes the dispatch route `/api/internal/jobs/<id>`. */
  readonly id: string;
  /** 5-field cron expression (e.g. "*\/15 * * * *"). */
  readonly cron: string;
  /** IANA timezone. Defaults to "UTC" when omitted. */
  readonly timezone?: string;
  /** The work, inline. Runs in the dispatcher; receives a ready context. */
  readonly run: ScheduledJobRun<Deps>;
}
