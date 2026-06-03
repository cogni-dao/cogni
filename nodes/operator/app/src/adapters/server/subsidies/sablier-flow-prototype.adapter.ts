// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/subsidies/sablier-flow-prototype`
 * Purpose: Sablier Flow prototype adapter for continuous subsidy distribution planning.
 * Scope: Produces rail-specific execution drafts; does not call Sablier contracts or SDKs.
 * Invariants: NO_TX_SIGNING; protocol details stay behind SubsidyDistributionRailPort.
 * Side-effects: none
 * Links: https://docs.sablier.com/concepts/flow/overview
 * @public
 */

import type { SubsidyDistributionRailPort, SubsidyRailDraft } from "@/ports";

export class SablierFlowPrototypeSubsidyRailAdapter
  implements SubsidyDistributionRailPort
{
  readonly rail = "sablier-flow" as const;

  async draftProgram(): Promise<SubsidyRailDraft> {
    return {
      rail: this.rail,
      label: "Sablier Flow stream",
      fit: "viable",
      status: "prototype",
      ossProjectUrl: "https://github.com/sablier-labs/flow",
      contractSurface: [
        "Sablier Flow stream",
        "USDC stream deposits and withdrawals",
        "Pause, refund, and void controls",
      ],
      cogniResponsibilities: [
        "Track applicant, interview, GitHub, and wallet identity state off-chain",
        "Create a stream only after the contributor starts",
        "Top up, pause, or void streams based on milestone evidence",
        "Record stream IDs, deposits, pauses, and withdrawals in the financial ledger",
      ],
      avoidedResponsibilities: [
        "No Cogni-owned streaming contract",
        "No custom vesting logic",
        "No per-recipient escrow contract",
      ],
      actions: [
        {
          id: "sablier-approve",
          label: "Approve stream policy",
          actor: "dao",
          timing: "approval",
          details:
            "DAO vote authorizes USDC streams for intern AI subscription subsidies and defines pause/void policy.",
        },
        {
          id: "sablier-create-stream",
          label: "Create contributor stream",
          actor: "operator",
          timing: "per_recipient",
          details:
            "Create one Sablier Flow stream after interview pass, wallet link, and active contributor start.",
        },
        {
          id: "sablier-top-up",
          label: "Top up $200 coverage",
          actor: "operator",
          timing: "per_milestone",
          details:
            "Deposit enough USDC to cover the next subsidy increment; recipient withdraws accrued funds.",
        },
        {
          id: "sablier-pause-or-void",
          label: "Pause or void inactive streams",
          actor: "operator",
          timing: "per_milestone",
          details:
            "Pause during missing check-ins; void when the contributor leaves the program.",
        },
      ],
      riskNotes: [
        "Sablier is stronger for ongoing subscriptions than discrete interview-gated grants.",
        "Streaming UX may be less legible to first-time interns than fixed $200 grant releases.",
      ],
    };
  }
}
