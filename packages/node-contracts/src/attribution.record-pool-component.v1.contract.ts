// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.record-pool-component.v1.contract`
 * Purpose: Defines operation contract for recording a pool component on an epoch.
 * Scope: Zod schemas and types for pool component wire format. Does not contain business logic.
 * Invariants:
 *   - ALL_MATH_BIGINT: BigInt values serialized as strings
 *   - WRITE_ROUTES_AUTHED: requires SIWE session
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

/** Validates a string is a valid integer and transforms to bigint at parse time. */
const zBigint = z
  .string()
  .regex(/^-?\d+$/, "Must be a valid integer string")
  .transform(BigInt);

export const PoolComponentInputSchema = z.object({
  componentId: z.string(),
  algorithmVersion: z.string(),
  inputsJson: z.record(z.string(), z.unknown()),
  amountCredits: zBigint,
  evidenceRef: z.string().optional(),
});

export const PoolComponentOutputSchema = z.object({
  id: z.string(),
  componentId: z.string(),
  amountCredits: z.string(),
  computedAt: z.string().datetime(),
});

export const recordPoolComponentOperation = {
  id: "ledger.record-pool-component.v1",
  summary: "Record a pool component",
  description:
    "Records a pool component (e.g. base_issuance, kpi_bonus) for the specified epoch. SIWE-protected.",
  input: PoolComponentInputSchema,
  output: PoolComponentOutputSchema,
} as const;

export type PoolComponentInput = z.infer<typeof PoolComponentInputSchema>;
export type PoolComponentOutput = z.infer<typeof PoolComponentOutputSchema>;
