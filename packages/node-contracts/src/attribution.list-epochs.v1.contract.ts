// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.list-epochs.v1.contract`
 * Purpose: Defines operation contract for listing ledger epochs with pagination.
 * Scope: Zod schemas and types for epoch list wire format. Does not contain business logic.
 * Invariants:
 *   - ALL_MATH_BIGINT: BigInt values serialized as strings
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const EpochSchema = z.object({
  id: z.string(), // bigint as string
  status: z.enum(["open", "review", "finalized"]),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  weightConfig: z.record(z.string(), z.number()),
  poolTotalCredits: z.string().nullable(), // bigint as string
  /** Pinned review authority; null while open. Additive for compatible readers. */
  approvers: z.array(z.string()).nullable().optional(),
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const ListEpochsOutputSchema = z.object({
  epochs: z.array(EpochSchema),
  total: z.number(),
});

export const listEpochsOperation = {
  id: "ledger.list-epochs.v1",
  summary: "List all epochs",
  description:
    "Returns all epochs for the current node, paginated. Public endpoint.",
  input: PaginationQuerySchema,
  output: ListEpochsOutputSchema,
} as const;

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type EpochDto = z.infer<typeof EpochSchema>;
export type ListEpochsOutput = z.infer<typeof ListEpochsOutputSchema>;
