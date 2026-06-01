// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/subsidy-distribution-rail`
 * Purpose: Rail-neutral port for drafting subsidy distribution execution plans.
 * Scope: Describes how an OSS web3 rail would execute a subsidy program without binding callers to a protocol.
 * Invariants: SEMANTIC_PORT; no transaction signing; no provider-specific SDK types leak through the boundary.
 * Side-effects: none (interface definition only)
 * Links: adapters/server/subsidies/*
 * @public
 */

export type SubsidyDistributionRailKind = "allo" | "sablier-flow";

export type SubsidyEligibilityGate =
  | "interview_passed"
  | "contributor_started"
  | "first_accepted_contribution"
  | "monthly_checkin";

export interface SubsidyAsset {
  readonly symbol: "USDC";
  readonly chainId: number;
  readonly decimals: 6;
}

export interface SubsidyMilestone {
  readonly id: string;
  readonly sequence: number;
  readonly label: string;
  readonly gate: SubsidyEligibilityGate;
  readonly amountUsdCents: number;
}

export interface SubsidyProgram {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly managerLegalActor: string;
  readonly asset: SubsidyAsset;
  readonly cohortSize: number;
  readonly incrementsPerIntern: number;
  readonly incrementUsdCents: number;
  readonly poolAmountUsdCents: number;
  readonly milestones: readonly SubsidyMilestone[];
}

export interface SubsidyRailAction {
  readonly id: string;
  readonly label: string;
  readonly actor: "derek" | "dao" | "operator" | "recipient";
  readonly timing: "setup" | "approval" | "per_recipient" | "per_milestone";
  readonly details: string;
}

export interface SubsidyRailDraft {
  readonly rail: SubsidyDistributionRailKind;
  readonly label: string;
  readonly fit: "recommended" | "viable" | "fallback";
  readonly status: "prototype";
  readonly ossProjectUrl: string;
  readonly contractSurface: readonly string[];
  readonly cogniResponsibilities: readonly string[];
  readonly avoidedResponsibilities: readonly string[];
  readonly actions: readonly SubsidyRailAction[];
  readonly riskNotes: readonly string[];
}

export interface SubsidyDistributionRailPort {
  readonly rail: SubsidyDistributionRailKind;

  draftProgram(program: SubsidyProgram): Promise<SubsidyRailDraft>;
}
