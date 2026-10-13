// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/ai.runs.v1`
 * Purpose: Zod contract for GET /api/v1/ai/runs — list graph runs for the authenticated user.
 * Scope: Input (query params with filtering + cursor pagination) and output (run list + next cursor). Does not contain business logic.
 * Invariants: CONTRACTS_ARE_TRUTH — single source for run list API shape
 * Side-effects: none
 * Links: docs/spec/unified-graph-launch.md, packages/scheduler-core/src/types.ts
 * @public
 */

import { z } from "zod";

const GRAPH_RUN_STATUSES = [
  "pending",
  "running",
  "success",
  "error",
  "timeout",
  "skipped",
  "cancelled",
] as const;

const GRAPH_RUN_KINDS = [
  "user_immediate",
  "system_scheduled",
  "system_webhook",
] as const;

export const listRunsOperation = {
  id: "ai.runs.list.v1",
  summary: "List graph runs for the authenticated user, ordered by recency",
  input: z.object({
    status: z.enum(GRAPH_RUN_STATUSES).optional(),
    runKind: z.enum(GRAPH_RUN_KINDS).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().datetime().optional(),
  }),
  output: z.object({
    runs: z.array(
      z.object({
        id: z.string(),
        runId: z.string(),
        graphId: z.string().nullable(),
        runKind: z.enum(GRAPH_RUN_KINDS).nullable(),
        status: z.enum(GRAPH_RUN_STATUSES),
        statusLabel: z.string().nullable(),
        requestedBy: z.string().nullable(),
        startedAt: z.string().nullable(),
        completedAt: z.string().nullable(),
        errorCode: z.string().nullable(),
        errorMessage: z.string().nullable(),
        stateKey: z.string().nullable(),
      })
    ),
    nextCursor: z.string().optional(),
  }),
} as const;

export type ListRunsInput = z.infer<typeof listRunsOperation.input>;
export type ListRunsOutput = z.infer<typeof listRunsOperation.output>;
