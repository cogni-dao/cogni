// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.epoch-user-projections.v1.contract`
 * Purpose: Defines operation contract for retrieving user projections for an epoch.
 * Scope: Zod schemas and types for epoch user projection wire format. Does not contain business logic.
 * Invariants:
 *   - ALL_MATH_BIGINT: BigInt values serialized as strings
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

export const UserProjectionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  projectedUnits: z.string(), // bigint as string
  receiptCount: z.number(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const EpochUserProjectionsOutputSchema = z.object({
  userProjections: z.array(UserProjectionSchema),
  epochId: z.string(),
});

export const epochUserProjectionsOperation = {
  id: "ledger.epoch-user-projections.v1",
  summary: "Get user projections for an epoch",
  description:
    "Returns recomputable per-user projections for the specified epoch. Public endpoint.",
  input: z.object({}),
  output: EpochUserProjectionsOutputSchema,
} as const;

export type UserProjectionDto = z.infer<typeof UserProjectionSchema>;
export type EpochUserProjectionsOutput = z.infer<
  typeof EpochUserProjectionsOutputSchema
>;
