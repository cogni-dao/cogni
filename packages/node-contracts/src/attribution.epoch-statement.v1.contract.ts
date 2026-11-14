// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.epoch-statement.v1.contract`
 * Purpose: Defines operation contract for retrieving an epoch statement (entitlement plan).
 * Scope: Zod schemas and types for epoch statement wire format. Does not contain business logic.
 * Invariants:
 *   - ALL_MATH_BIGINT: BigInt values serialized as strings
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

const ClaimantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({
    kind: z.literal("identity"),
    provider: z.string(),
    externalId: z.string(),
    providerLogin: z.string().nullable(),
  }),
]);

export const AttributionStatementLineSchema = z.object({
  claimant_key: z.string(),
  claimant: ClaimantSchema,
  final_units: z.string(),
  pool_share: z.string(),
  credit_amount: z.string(),
  receipt_ids: z.array(z.string()),
});

export const StatementSchema = z.object({
  id: z.string(),
  epochId: z.string(),
  finalAllocationSetHash: z.string(),
  poolTotalCredits: z.string(),
  statementLines: z.array(AttributionStatementLineSchema),
  supersedesStatementId: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const EpochStatementOutputSchema = z.object({
  statement: StatementSchema.nullable(),
});

export const epochStatementOperation = {
  id: "ledger.epoch-statement.v1",
  summary: "Get statement for an epoch",
  description:
    "Returns the statement (entitlement plan) for the specified epoch. statement is null if none exists yet. Always 200.",
  input: z.object({}),
  output: EpochStatementOutputSchema,
} as const;

export type AttributionStatementLineDto = z.infer<
  typeof AttributionStatementLineSchema
>;
export type StatementDto = z.infer<typeof StatementSchema>;
