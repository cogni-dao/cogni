// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/internship.interest.v1`
 * Purpose: Public internship interest signup operation contract.
 * Scope: Defines wire input and output for the recruitment interest endpoint.
 * Invariants: VALIDATE_IO; keep payload small and recruitment-specific.
 * Side-effects: none
 * Links: story.5001
 * @public
 */

import { z } from "zod";

const WalletAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/);

const WalletSignatureSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{130}$/);

const InternshipFocusSchema = z.enum([
  "x402-apps",
  "applied-ai-products",
  "infrastructure",
  "growth-ops",
  "not-sure",
]);

const UnsignedInternshipInterestInputSchema = z.object({
  email: z.string().trim().email().max(240),
  portfolioUrl: z.string().trim().url().max(500),
  focus: InternshipFocusSchema,
  interest: z.string().trim().min(1).max(240),
});

const InternshipWalletSignatureSchema = z.object({
  walletAddress: WalletAddressSchema,
  walletSignature: WalletSignatureSchema,
  walletMessage: z.string().trim().min(1).max(2000),
  walletSignedAt: z.string().datetime(),
});

export const internshipInterestOperation = {
  id: "internship.interest.v1",
  summary: "Submit Cogni internship interest",
  input: UnsignedInternshipInterestInputSchema.and(
    InternshipWalletSignatureSchema
  ),
  output: z.object({
    ok: z.literal(true),
    referenceId: z.string(),
    derekInterviewUrl: z.string().url(),
  }),
} as const;

export type InternshipInterestInput = z.infer<
  typeof internshipInterestOperation.input
>;
export type UnsignedInternshipInterestInput = z.infer<
  typeof UnsignedInternshipInterestInputSchema
>;
export type InternshipInterestOutput = z.infer<
  typeof internshipInterestOperation.output
>;

export function buildInternshipApplicationMessage(
  input: UnsignedInternshipInterestInput & { walletSignedAt: string }
): string {
  return [
    "Cogni internship interest",
    "",
    "I am submitting internship interest to Cogni and confirming that Derek may use this wallet signature as proof that I sent it.",
    "",
    `Email: ${input.email.trim()}`,
    `Wallet signed at: ${input.walletSignedAt}`,
    `Portfolio: ${input.portfolioUrl.trim()}`,
    `Niche direction: ${input.focus}`,
    "",
    `Interested in: ${input.interest.trim()}`,
  ].join("\n");
}
