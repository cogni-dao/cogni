// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/setup.verify.v1.contract`
 * Purpose: Contract for verifying DAO formation transactions via HTTP API.
 * Scope: Defines request/response schemas for POST /api/setup/verify; does not perform RPC or persistence.
 * Invariants: Server derives ALL addresses from tx receipts; never trusts client-provided addresses.
 * Side-effects: none
 * Links: docs/spec/node-formation.md, work/projects/proj.chain-deployment-refactor.md
 * @public
 */

import { SUPPORTED_CHAIN_IDS } from "@cogni/aragon-osx";
import { z } from "zod";

const hexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address");
const txHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Invalid tx hash");

export const setupVerifyOperation = {
  id: "setup.verify.v1",
  summary: "Verify DAO formation transactions",
  description:
    "Server derives addresses from tx receipts and verifies on-chain state (minted balance, CogniSignal.DAO())",
  input: z
    .object({
      chainId: z
        .number()
        .int()
        .refine(
          (id) => (SUPPORTED_CHAIN_IDS as readonly number[]).includes(id),
          {
            message: `chainId must be one of: ${SUPPORTED_CHAIN_IDS.join(", ")}`,
          }
        ),
      daoTxHash: txHash.describe("DAOFactory.createDao transaction hash"),
      signalTxHash: txHash.describe("CogniSignal deployment transaction hash"),
      // Block number from client receipt - used to query at specific block (avoids cross-RPC race)
      signalBlockNumber: z
        .number()
        .int()
        .positive()
        .describe("Block number where CogniSignal was deployed (from receipt)"),
      initialHolder: hexAddress.describe("Expected token recipient address"),
      expectedTokenSupplyUnits: z
        .string()
        .regex(/^[1-9][0-9]*$/, "Invalid token supply units")
        .describe("Expected 18-decimal token supply minted to initialHolder"),
    })
    .strict(), // SECURITY: Reject any client-supplied addresses (must derive from receipts)
  output: z.discriminatedUnion("verified", [
    z.object({
      verified: z.literal(true),
      addresses: z.object({
        dao: hexAddress,
        token: hexAddress,
        plugin: hexAddress,
        signal: hexAddress,
      }),
    }),
    z.object({
      verified: z.literal(false),
      errors: z.array(z.string()),
    }),
  ]),
} as const;

export type SetupVerifyInput = z.infer<typeof setupVerifyOperation.input>;
export type SetupVerifyOutput = z.infer<typeof setupVerifyOperation.output>;
