// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.epoch-activity.v1.contract`
 * Purpose: Defines operation contract for retrieving ingestion receipts for an epoch.
 * Scope: Zod schemas and types for epoch activity wire format. Does not contain business logic.
 * Invariants:
 *   - ALL_MATH_BIGINT: BigInt values serialized as strings
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

import { PaginationQuerySchema } from "./attribution.list-epochs.v1.contract";

export const SelectionSchema = z.object({
  userId: z.string().nullable(),
  included: z.boolean(),
  weightOverrideMilli: z.string().nullable(), // bigint as string
  note: z.string().nullable(),
});

export const IngestionReceiptSchema = z.object({
  receiptId: z.string(),
  source: z.string(),
  eventType: z.string(),
  platformUserId: z.string(),
  platformLogin: z.string().nullable(),
  artifactUrl: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  eventTime: z.string().datetime(),
  selection: SelectionSchema.nullable(),
});

export const EpochActivityOutputSchema = z.object({
  events: z.array(IngestionReceiptSchema),
  epochId: z.string(),
  total: z.number(),
});

export const epochActivityOperation = {
  id: "ledger.epoch-activity.v1",
  summary: "Get ingestion receipts for an epoch",
  description:
    "Returns ingestion receipts for the specified epoch, joined with selection data. Authenticated endpoint.",
  input: PaginationQuerySchema,
  output: EpochActivityOutputSchema,
} as const;

export type IngestionReceiptDto = z.infer<typeof IngestionReceiptSchema>;
export type EpochActivityOutput = z.infer<typeof EpochActivityOutputSchema>;
