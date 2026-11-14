// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.sign-data.v1.contract`
 * Purpose: Defines operation contract for the EIP-712 sign-data endpoint.
 * Scope: Zod schemas and types for sign-data wire format. Does not contain business logic.
 * Invariants:
 *   - WRITE_ROUTES_AUTHED: requires SIWE session
 *   - WRITE_ROUTES_APPROVER_GATED: requires wallet in ledger approvers
 *   - SIGNATURE_SCOPE_BOUND: returned typed data includes all scope-binding fields
 *   - Contract remains stable; breaking changes require new version
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

export const SignDataOutputSchema = z.object({
  domain: z.object({
    name: z.string(),
    version: z.string(),
    chainId: z.number(),
  }),
  types: z.object({
    AttributionStatement: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
      })
    ),
  }),
  primaryType: z.literal("AttributionStatement"),
  message: z.object({
    nodeId: z.string(),
    scopeId: z.string(),
    epochId: z.string(),
    finalAllocationSetHash: z.string(),
    poolTotalCredits: z.string(),
  }),
});

export const signDataOperation = {
  id: "ledger.sign-data.v1",
  summary: "Get EIP-712 typed data for epoch signing",
  description:
    "Returns EIP-712 typed data payload (domain + types + message) for a given epoch in review status. SIWE-protected, approver-gated.",
  output: SignDataOutputSchema,
} as const;

export type SignDataOutput = z.infer<typeof SignDataOutputSchema>;
