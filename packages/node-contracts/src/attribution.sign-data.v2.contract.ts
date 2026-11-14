// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.sign-data.v2.contract`
 * Purpose: Defines the deployment-bound EIP-712 sign-data wire format.
 * Scope: Zod schemas and types only; does not let clients choose the environment.
 * The server derives deploymentEnvironment; clients may display and sign it.
 * Invariants: SIGNATURE_SCOPE_BOUND, SIGNATURE_DEPLOYMENT_BOUND.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

export const EIP712DeploymentEnvironmentSchema = z.enum([
  "local",
  "test",
  "candidate-a",
  "preview",
  "production",
]);

export const SignDataV2OutputSchema = z.object({
  domain: z.object({
    name: z.literal("Cogni Attribution"),
    version: z.literal("2"),
    chainId: z.number().int().positive(),
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
    deploymentEnvironment: EIP712DeploymentEnvironmentSchema,
    finalAllocationSetHash: z.string(),
    poolTotalCredits: z.string(),
  }),
});

export const signDataV2Operation = {
  id: "ledger.sign-data.v2",
  summary: "Get deployment-bound EIP-712 typed data for epoch signing",
  description:
    "Returns EIP-712 v2 typed data for an epoch in review. The server-derived deploymentEnvironment prevents replay across candidate-a, preview, and production. SIWE-protected, approver-gated.",
  output: SignDataV2OutputSchema,
} as const;

export type EIP712DeploymentEnvironment = z.infer<
  typeof EIP712DeploymentEnvironmentSchema
>;
export type SignDataV2Output = z.infer<typeof SignDataV2OutputSchema>;
