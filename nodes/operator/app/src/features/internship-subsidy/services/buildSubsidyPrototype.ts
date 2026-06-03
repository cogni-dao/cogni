// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/internship-subsidy/services/buildSubsidyPrototype`
 * Purpose: Compose the intern subsidy program with a selected OSS distribution rail.
 * Scope: Feature orchestration only; delegates rail details to SubsidyDistributionRailPort.
 * Invariants: adapter-swappable; no chain IO; output shape derives from contract.
 * Side-effects: IO only through injected rail ports.
 * Links: contracts/internship.subsidy-prototype.v1.contract.ts
 * @public
 */

import type { InternshipSubsidyPrototypeOutput } from "@/contracts/internship.subsidy-prototype.v1.contract";
import type {
  SubsidyDistributionRailKind,
  SubsidyDistributionRailPort,
  SubsidyEligibilityGate,
  SubsidyMilestone,
  SubsidyProgram,
} from "@/ports";
import { CHAIN_ID } from "@/shared/web3";

export interface BuildSubsidyPrototypeDeps {
  readonly rails: Record<
    SubsidyDistributionRailKind,
    SubsidyDistributionRailPort
  >;
  readonly now: () => string;
}

export interface BuildSubsidyPrototypeInput {
  readonly rail: SubsidyDistributionRailKind;
  readonly cohortSize: number;
  readonly incrementsPerIntern: number;
}

const INCREMENT_USD_CENTS = 20_000;

const milestoneTemplates: readonly {
  readonly gate: SubsidyEligibilityGate;
  readonly label: string;
}[] = [
  {
    gate: "interview_passed",
    label: "Interview passed and wallet identity linked",
  },
  {
    gate: "contributor_started",
    label: "Contributor started active Cogni work",
  },
  {
    gate: "first_accepted_contribution",
    label: "First accepted contribution or validated work proof",
  },
  {
    gate: "monthly_checkin",
    label: "Monthly check-in confirms continued participation",
  },
];

function buildMilestones(incrementsPerIntern: number): SubsidyMilestone[] {
  return Array.from({ length: incrementsPerIntern }, (_, index) => {
    const template = milestoneTemplates[index] ?? {
      gate: "monthly_checkin",
      label: "Monthly check-in confirms continued participation",
    };
    return {
      id: `intern-ai-subscription-${index + 1}`,
      sequence: index + 1,
      label: template.label,
      gate: template.gate,
      amountUsdCents: INCREMENT_USD_CENTS,
    };
  });
}

function buildInternAiSubscriptionSubsidyProgram(
  input: Pick<BuildSubsidyPrototypeInput, "cohortSize" | "incrementsPerIntern">
): SubsidyProgram {
  const poolAmountUsdCents =
    input.cohortSize * input.incrementsPerIntern * INCREMENT_USD_CENTS;
  return {
    id: "intern-ai-subscription-subsidy",
    name: "Intern AI Subscription Subsidy",
    purpose:
      "DAO-funded USDC subsidy for intern AI tool subscriptions, released in fixed increments after interview and contribution gates.",
    managerLegalActor:
      "Cogni DAO or future Cogni Delaware LLC operator profile",
    asset: {
      symbol: "USDC",
      chainId: CHAIN_ID,
      decimals: 6,
    },
    cohortSize: input.cohortSize,
    incrementsPerIntern: input.incrementsPerIntern,
    incrementUsdCents: INCREMENT_USD_CENTS,
    poolAmountUsdCents,
    milestones: buildMilestones(input.incrementsPerIntern),
  };
}

export async function buildSubsidyPrototype(
  input: BuildSubsidyPrototypeInput,
  deps: BuildSubsidyPrototypeDeps
): Promise<InternshipSubsidyPrototypeOutput> {
  const program = buildInternAiSubscriptionSubsidyProgram({
    cohortSize: input.cohortSize,
    incrementsPerIntern: input.incrementsPerIntern,
  });
  const drafts = await Promise.all(
    Object.values(deps.rails).map((rail) => rail.draftProgram(program))
  );
  const selectedRail =
    drafts.find((draft) => draft.rail === input.rail) ?? drafts[0];
  if (!selectedRail) {
    throw new Error("No subsidy distribution rails configured");
  }

  return {
    generatedAt: deps.now(),
    program: {
      ...program,
      milestones: [...program.milestones],
    },
    selectedRail: {
      ...selectedRail,
      contractSurface: [...selectedRail.contractSurface],
      cogniResponsibilities: [...selectedRail.cogniResponsibilities],
      avoidedResponsibilities: [...selectedRail.avoidedResponsibilities],
      actions: [...selectedRail.actions],
      riskNotes: [...selectedRail.riskNotes],
    },
    railOptions: drafts.map((draft) => ({
      rail: draft.rail,
      label: draft.label,
      fit: draft.fit,
    })),
  };
}
