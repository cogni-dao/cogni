// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/graph-runs.create.internal.v1.contract`
 * Purpose: Contract for internal graph-run record creation (scheduler-worker → node app).
 * Scope: Wire format for POST /api/internal/graph-runs. The worker does not hold a DB client for graph_runs; it calls the owning node to persist the row. Does not implement the route or business logic.
 * Invariants:
 *   - Bearer SCHEDULER_API_TOKEN required
 *   - Idempotent: repeated POST with same runId is a no-op returning 200
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: /api/internal/graph-runs route, https://node-template.cognidao.org/knowledge/scheduled-run-grant-contract, task.0280
 * @internal
 */

import { z } from "zod";

export const GraphRunKindSchema = z.enum([
  "user_immediate",
  "system_scheduled",
  "system_webhook",
]);

export const InternalCreateGraphRunInputSchema = z.object({
  runId: z.string().uuid(),
  graphId: z.string().optional(),
  runKind: GraphRunKindSchema.optional(),
  triggerSource: z.string().optional(),
  triggerRef: z.string().optional(),
  requestedBy: z.string().optional(),
  /** Only set for scheduled runs */
  scheduleId: z.string().optional(),
  /** ISO 8601 timestamp; only set for scheduled runs */
  scheduledFor: z.string().datetime().optional(),
  /** Thread state key for conversation correlation */
  stateKey: z.string().optional(),
});

export const InternalCreateGraphRunOutputSchema = z.object({
  ok: z.literal(true),
  runId: z.string().uuid(),
});

export const internalCreateGraphRunOperation = {
  id: "graph-runs.create.internal.v1",
  summary: "Create graph_runs record (scheduler-worker → node app)",
  description:
    "Internal endpoint called by scheduler-worker to persist a graph_runs row in the owning node's database. Idempotent per runId.",
  input: InternalCreateGraphRunInputSchema,
  output: InternalCreateGraphRunOutputSchema,
} as const;

export type InternalCreateGraphRunInput = z.infer<
  typeof InternalCreateGraphRunInputSchema
>;
export type InternalCreateGraphRunOutput = z.infer<
  typeof InternalCreateGraphRunOutputSchema
>;
