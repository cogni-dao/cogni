// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work-item-sessions.v1`
 * Purpose: Operator-local Zod contracts for work-item execution sessions.
 * Scope: Request/response schemas for claim, heartbeat, PR link, and
 *   coordination status endpoints. Does not define shared node contracts.
 * Invariants: OPERATOR_COORDINATION_LOCAL — these shapes belong to the
 *   operator node until another sovereign node proves the same API surface.
 * Side-effects: none
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @public
 */

import { z } from "zod";

export const WorkItemSessionStatusSchema = z.enum([
  "active",
  "idle",
  "stale",
  "closed",
  "superseded",
]);

export const RepoFullNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, {
    message: "repoFullName must be 'owner/repo'",
  });

export const WorkItemSessionDtoSchema = z.object({
  coordinationId: z.string().uuid(),
  workItemId: z.string().min(1),
  status: WorkItemSessionStatusSchema,
  claimedByUserId: z.string().min(1),
  claimedByDisplayName: z.string().nullable(),
  claimedAt: z.string().datetime(),
  lastHeartbeatAt: z.string().datetime().nullable(),
  deadlineAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  lastCommand: z.string().nullable(),
  branch: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  repoFullName: z.string().nullable(),
});

const ttlSecondsSchema = z
  .number()
  .int()
  .min(60)
  .max(60 * 60 * 2);

export const workItemSessionClaimOperation = {
  id: "operator.work-item-session.claim.v1",
  input: z.object({
    ttlSeconds: ttlSecondsSchema.optional(),
    lastCommand: z.string().min(1).max(120).optional(),
  }),
  output: z.object({
    claimed: z.boolean(),
    conflict: z.boolean(),
    session: WorkItemSessionDtoSchema,
    nextAction: z.string(),
    statusUrl: z.string(),
  }),
} as const;

export const workItemSessionHeartbeatOperation = {
  id: "operator.work-item-session.heartbeat.v1",
  input: z.object({
    ttlSeconds: ttlSecondsSchema.optional(),
    lastCommand: z.string().min(1).max(120).optional(),
  }),
  output: z.object({
    session: WorkItemSessionDtoSchema,
    nextAction: z.string(),
    statusUrl: z.string(),
  }),
} as const;

export const workItemSessionPrOperation = {
  id: "operator.work-item-session.pr.v1",
  input: z
    .object({
      branch: z.string().min(1).max(240).optional(),
      prNumber: z.number().int().positive().optional(),
      repoFullName: RepoFullNameSchema.optional(),
    })
    .refine(
      (value) => value.branch !== undefined || value.prNumber !== undefined,
      {
        message: "branch or prNumber is required",
      }
    )
    .refine(
      (value) =>
        value.prNumber === undefined || value.repoFullName !== undefined,
      {
        message: "repoFullName is required when prNumber is provided",
      }
    ),
  output: z.object({
    session: WorkItemSessionDtoSchema,
    nextAction: z.string(),
    statusUrl: z.string(),
  }),
} as const;

export const workItemSessionCoordinationOperation = {
  id: "operator.work-item-session.coordination.v1",
  input: z.object({}),
  output: z.object({
    workItemId: z.string().min(1),
    session: WorkItemSessionDtoSchema.nullable(),
    nextAction: z.string(),
    statusUrl: z.string(),
  }),
} as const;

export type WorkItemSessionDto = z.infer<typeof WorkItemSessionDtoSchema>;
export type WorkItemSessionClaimInput = z.infer<
  typeof workItemSessionClaimOperation.input
>;
export type WorkItemSessionHeartbeatInput = z.infer<
  typeof workItemSessionHeartbeatOperation.input
>;
export type WorkItemSessionPrInput = z.infer<
  typeof workItemSessionPrOperation.input
>;
