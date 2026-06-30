// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.epoch-contributors.v1.contract`
 * Purpose: Agent-first read contract for an epoch's aggregated contributors-by-identity rollup, active attribution policy id, and pool window.
 * Scope: Zod schemas and types for the epoch-contributors wire format. Does not contain business logic.
 * Invariants:
 *   - ALL_MATH_BIGINT: point/unit values serialized as strings
 *   - SELECTION_IS_THE_GATE: a contributor appears iff a receipt is selected
 *     (included === true) — points may be "0"
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.epoch-activity.v1.contract
 * @public
 */

import { z } from "zod";

export const EpochContributorSchema = z.object({
  /** "user:<id>" for resolved, "identity:<source>:<platformUserId>" otherwise. */
  claimantKey: z.string(),
  claimantKind: z.enum(["user", "identity"]),
  isLinked: z.boolean(),
  displayName: z.string().nullable(),
  claimantLabel: z.string(),
  /** Summed weight (milli-units) as string — may be "0" for a selected weight-0 receipt. */
  points: z.string(),
  /** Share of total points, percent (0–100, one decimal). */
  share: z.number(),
  receiptCount: z.number(),
});

export const EpochContributorsOutputSchema = z.object({
  epochId: z.string(),
  status: z.enum(["open", "review", "finalized"]),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  /** Active attribution policy/profile id (repo-spec `attribution_pipeline`). */
  attributionPipeline: z.string().nullable(),
  contributors: z.array(EpochContributorSchema),
  /** Sum of all contributor points (milli-units) as string. */
  totalPoints: z.string(),
});

export const epochContributorsOperation = {
  id: "ledger.epoch-contributors.v1",
  summary: "Get aggregated contributors-by-identity for an epoch",
  description:
    "Returns the aggregated contributor rollup for the specified epoch (any status, no finalized gate), each keyed by identity with points and share, plus the active attribution policy. Authenticated endpoint — accepts a human SIWE session OR an agent bearer token.",
  output: EpochContributorsOutputSchema,
} as const;

export type EpochContributorDto = z.infer<typeof EpochContributorSchema>;
export type EpochContributorsOutput = z.infer<
  typeof EpochContributorsOutputSchema
>;
