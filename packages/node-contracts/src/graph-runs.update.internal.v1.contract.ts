// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/graph-runs.update.internal.v1.contract`
 * Purpose: Contract for updating graph_runs status via internal API (scheduler-worker → node app).
 * Scope: Wire format for PATCH /api/internal/graph-runs/{runId}. Does not implement the route or business logic.
 * Invariants:
 *   - Bearer SCHEDULER_API_TOKEN required
 *   - Status transitions are monotonic at the adapter layer: pending → running → (success|error|timeout|skipped|cancelled)
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: /api/internal/graph-runs/[runId] route, docs/spec/scheduler.md, task.0280
 * @internal
 */

import { z } from "zod";

export const GraphRunUpdateStatusSchema = z.enum([
  "running",
  "success",
  "error",
  "timeout",
  "skipped",
  "cancelled",
]);

export const InternalUpdateGraphRunInputSchema = z.object({
  status: GraphRunUpdateStatusSchema,
  traceId: z.string().nullable().optional(),
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
});

export const InternalUpdateGraphRunOutputSchema = z.object({
  ok: z.literal(true),
  runId: z.string().uuid(),
});

export const internalUpdateGraphRunOperation = {
  id: "graph-runs.update.internal.v1",
  summary: "Update graph_runs status (scheduler-worker → node app)",
  description:
    "Internal endpoint called by scheduler-worker to update a graph_runs row in the owning node's database. Status transitions handled by the node's GraphRunRepository.",
  input: InternalUpdateGraphRunInputSchema,
  output: InternalUpdateGraphRunOutputSchema,
} as const;

export type InternalUpdateGraphRunInput = z.infer<
  typeof InternalUpdateGraphRunInputSchema
>;
export type InternalUpdateGraphRunOutput = z.infer<
  typeof InternalUpdateGraphRunOutputSchema
>;
