// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/scheduled-jobs/registry`
 * Purpose: `defineScheduledJob` registry — the single seam a node dev touches for
 *   recurring work. Collects job defs by `id`; the dispatcher route and the bootstrap
 *   registration helper read back from here. Pure, in-process, side-effect-free.
 * Scope: Registry + id validation only. No routes, tokens, NodeTaskWorkflow, queues, HTTP.
 * Invariants:
 *   - PURE_LAYER: `shared/` may import only `shared`/`types` (dep-cruiser). No bootstrap.
 *   - ID_IS_ROUTE_SAFE: `id` becomes the path segment `/api/internal/jobs/<id>`, so it
 *     must match `^[a-z0-9][a-z0-9-]*$` — no slashes, dots, traversal, or scheme.
 *   - UNIQUE_IDS: registering two jobs with the same id throws at module load (fail fast).
 *   - REGISTRY_IS_DECLARATIVE: defineScheduledJob mutates a module-level map at import
 *     time; consumers import the job-definitions barrel to populate it.
 * Side-effects: in-process map mutation only (no I/O).
 * Links: ./types, app/api/internal/jobs/[jobId]/route.ts, bootstrap/jobs/scheduledJobs.ts
 * @public
 */

import type { ScheduledJobContext, ScheduledJobDefinition } from "./types";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The single source of truth for declared scheduled jobs, keyed by id. */
const registry = new Map<string, ScheduledJobDefinition<never>>();

/**
 * Declare a recurring job. The node dev writes ONLY this — no route, no auth check,
 * no idempotency check, no `createSchedule` call. The wrapper owns all of that.
 *
 * Returns the (frozen) definition so the dev can `export const x = defineScheduledJob(...)`.
 *
 * @typeParam Deps - the job's runtime dependencies, threaded through `ctx.deps`.
 *   Defaults to `unknown` for a self-contained job.
 */
export function defineScheduledJob<Deps = unknown>(
  def: ScheduledJobDefinition<Deps>
): ScheduledJobDefinition<Deps> {
  if (!ID_PATTERN.test(def.id)) {
    throw new Error(
      `defineScheduledJob: invalid id "${def.id}" — must match ${ID_PATTERN} ` +
        `(lowercase alphanumerics + dashes; becomes the route segment /api/internal/jobs/<id>)`
    );
  }
  if (registry.has(def.id)) {
    throw new Error(
      `defineScheduledJob: duplicate job id "${def.id}" — ids must be unique`
    );
  }
  const frozen = Object.freeze({ ...def });
  // Store under the Deps-erased shape; the dispatcher rebinds Deps when it invokes run.
  registry.set(def.id, frozen as unknown as ScheduledJobDefinition<never>);
  return frozen;
}

/** Look up a registered job by id, or `undefined` if none. */
export function getScheduledJob(
  id: string
): ScheduledJobDefinition<never> | undefined {
  return registry.get(id);
}

/** All registered jobs, in declaration order. */
export function listScheduledJobs(): readonly ScheduledJobDefinition<never>[] {
  return [...registry.values()];
}

/**
 * Invoke a registered job's `run` with a context whose `deps` is bound by the caller
 * (the dispatcher route supplies the concrete container). Keeps the unsafe Deps cast
 * in ONE place so callers stay strictly typed.
 *
 * @throws Error if no job with `id` is registered.
 */
export async function runScheduledJob<Deps>(
  id: string,
  ctx: ScheduledJobContext<Deps>
): Promise<void> {
  const job = registry.get(id);
  if (!job) {
    throw new Error(`runScheduledJob: no job registered for id "${id}"`);
  }
  const run = job.run as unknown as ScheduledJobDefinition<Deps>["run"];
  await run(ctx);
}

/** Test-only: clear the registry between cases. */
export function __resetScheduledJobRegistryForTest(): void {
  registry.clear();
}
