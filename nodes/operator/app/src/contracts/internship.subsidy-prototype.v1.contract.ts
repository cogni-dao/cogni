// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/internship.subsidy-prototype.v1`
 * Purpose: Public prototype contract for intern AI subscription subsidy rail planning.
 * Scope: Defines query input and response DTO for rail-neutral subsidy execution drafts.
 * Invariants: VALIDATE_IO; protocol-specific details are descriptive, not transaction payloads.
 * Side-effects: none
 * Links: ports/subsidy-distribution-rail.port.ts
 * @public
 */

import { z } from "zod";

export const SubsidyRailSchema = z.enum(["allo", "sablier-flow"]);
export type SubsidyRail = z.infer<typeof SubsidyRailSchema>;

const PositiveSmallIntSchema = z.coerce.number().int().min(1).max(50);

export const internshipSubsidyPrototypeOperation = {
  id: "internship.subsidy-prototype.v1",
  summary: "Draft intern AI subscription subsidy distribution plan",
  input: z.object({
    rail: SubsidyRailSchema.default("allo"),
    cohortSize: PositiveSmallIntSchema.default(5),
    incrementsPerIntern: PositiveSmallIntSchema.max(12).default(3),
  }),
  output: z.object({
    generatedAt: z.string(),
    selectedRail: z.object({
      rail: SubsidyRailSchema,
      label: z.string(),
      fit: z.enum(["recommended", "viable", "fallback"]),
      status: z.literal("prototype"),
      ossProjectUrl: z.string().url(),
      contractSurface: z.array(z.string()),
      cogniResponsibilities: z.array(z.string()),
      avoidedResponsibilities: z.array(z.string()),
      actions: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          actor: z.enum(["derek", "dao", "operator", "recipient"]),
          timing: z.enum([
            "setup",
            "approval",
            "per_recipient",
            "per_milestone",
          ]),
          details: z.string(),
        })
      ),
      riskNotes: z.array(z.string()),
    }),
    railOptions: z.array(
      z.object({
        rail: SubsidyRailSchema,
        label: z.string(),
        fit: z.enum(["recommended", "viable", "fallback"]),
      })
    ),
    program: z.object({
      id: z.string(),
      name: z.string(),
      purpose: z.string(),
      managerLegalActor: z.string(),
      cohortSize: z.number().int(),
      incrementsPerIntern: z.number().int(),
      incrementUsdCents: z.number().int(),
      poolAmountUsdCents: z.number().int(),
      asset: z.object({
        symbol: z.literal("USDC"),
        chainId: z.number().int(),
        decimals: z.literal(6),
      }),
      milestones: z.array(
        z.object({
          id: z.string(),
          sequence: z.number().int(),
          label: z.string(),
          gate: z.enum([
            "interview_passed",
            "contributor_started",
            "first_accepted_contribution",
            "monthly_checkin",
          ]),
          amountUsdCents: z.number().int(),
        })
      ),
    }),
  }),
} as const;

export type InternshipSubsidyPrototypeInput = z.infer<
  typeof internshipSubsidyPrototypeOperation.input
>;
export type InternshipSubsidyPrototypeOutput = z.infer<
  typeof internshipSubsidyPrototypeOperation.output
>;
