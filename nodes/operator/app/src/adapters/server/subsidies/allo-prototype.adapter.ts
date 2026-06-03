// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/subsidies/allo-prototype`
 * Purpose: Allo Protocol prototype adapter for milestone-based subsidy distribution planning.
 * Scope: Produces rail-specific execution drafts; does not call Allo contracts or SDKs.
 * Invariants: NO_TX_SIGNING; OSS_MAXIMIZING; protocol details stay behind SubsidyDistributionRailPort.
 * Side-effects: none
 * Links: https://docs.allo.gitcoin.co/overview
 * @public
 */

import type { SubsidyDistributionRailPort, SubsidyRailDraft } from "@/ports";

export class AlloPrototypeSubsidyRailAdapter
  implements SubsidyDistributionRailPort
{
  readonly rail = "allo" as const;

  async draftProgram(): Promise<SubsidyRailDraft> {
    return {
      rail: this.rail,
      label: "Allo Protocol grant pool",
      fit: "recommended",
      status: "prototype",
      ossProjectUrl: "https://github.com/allo-protocol/allo-v2",
      contractSurface: [
        "Allo.sol pool management",
        "Registry.sol profile and recipient identity",
        "Existing or cloneable milestone/direct-grants strategy",
      ],
      cogniResponsibilities: [
        "Track applicant, interview, GitHub, and wallet identity state off-chain",
        "Draft DAO proposal metadata for pool creation and funding",
        "Approve recipient milestones from interview/contribution evidence",
        "Record Allo pool, recipient, and distribution references in the financial ledger",
      ],
      avoidedResponsibilities: [
        "No Cogni-owned subsidy smart contract",
        "No Cogni-owned Merkle claim contract",
        "No custom recipient registry contract",
      ],
      actions: [
        {
          id: "allo-profile",
          label: "Create or reuse Cogni operator profile",
          actor: "operator",
          timing: "setup",
          details:
            "Use Allo Registry profile for the DAO or future Delaware LLC operator entity that administers the subsidy.",
        },
        {
          id: "allo-pool",
          label: "Create subsidy pool",
          actor: "dao",
          timing: "approval",
          details:
            "DAO vote authorizes a USDC pool for intern AI subscription subsidies with Derek as reviewer and operator-controlled manager policy.",
        },
        {
          id: "allo-fund",
          label: "Fund pool with USDC",
          actor: "derek",
          timing: "approval",
          details:
            "Derek sends USDC to the DAO/Safe, then governance funds the Allo pool after proposal approval.",
        },
        {
          id: "allo-register-recipient",
          label: "Register eligible contributor",
          actor: "operator",
          timing: "per_recipient",
          details:
            "After interview and wallet linking, register the intern as an Allo recipient tied to Cogni's identity record.",
        },
        {
          id: "allo-distribute-milestone",
          label: "Release $200 milestone",
          actor: "operator",
          timing: "per_milestone",
          details:
            "When a milestone gate passes, submit the strategy-specific distribution for the recipient's $200 USDC increment.",
        },
      ],
      riskNotes: [
        "Strategy selection is the integration risk: prefer an existing direct-grants or milestone strategy before writing any strategy contract.",
        "Allo owns allocation/distribution mechanics, but Cogni still owns off-chain interview evidence and approval policy.",
      ],
    };
  }
}
