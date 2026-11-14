// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/governance/lib/epoch-lifecycle-state`
 * Purpose: Pure derivation of the five human epoch checkpoints from ledger, manifest, and chain evidence.
 * Scope: No IO or React. Unknown evidence remains unknown; finalized never implies folded/published.
 * Invariants: UNKNOWN_NEVER_COMPLETE, PUBLISH_FROM_ON_CHAIN_EVIDENCE, CUMULATIVE_COVERS_PRIOR.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/distribution-lifecycle, bug.5042
 * @public
 */

import type { DistributionLifecycleOutput } from "@cogni/node-contracts";

import type { EpochView } from "@/features/governance/types";

export type EpochCheckpointState =
  | "complete"
  | "current"
  | "locked"
  | "unavailable"
  | "unknown";

export interface EpochCheckpoint {
  readonly id: "collect" | "review" | "finalize" | "publish" | "claim";
  readonly label: string;
  readonly state: EpochCheckpointState;
  readonly description: string;
}

export interface EpochLifecycleView {
  readonly steps: readonly EpochCheckpoint[];
  readonly isFolded: boolean;
  readonly isPublished: boolean;
  readonly isLatestFolded: boolean;
}

function bigintGte(left: string, right: string): boolean {
  try {
    return BigInt(left) >= BigInt(right);
  } catch {
    return false;
  }
}

export function deriveEpochLifecycle(
  epoch: Pick<EpochView, "id" | "status">,
  evidence: DistributionLifecycleOutput,
  periodEnded: boolean
): EpochLifecycleView {
  const folded = evidence.foldedEpochIds.includes(epoch.id);
  const latestFolded = evidence.latestFoldedEpochId === epoch.id;
  const published =
    folded &&
    evidence.publicationEvidence === "matched" &&
    evidence.publishedThroughEpochId !== null &&
    bigintGte(evidence.publishedThroughEpochId, epoch.id);

  if (epoch.status === "open") {
    return {
      isFolded: false,
      isPublished: false,
      isLatestFolded: false,
      steps: [
        {
          id: "collect",
          label: "Collect",
          state: periodEnded ? "complete" : "current",
          description: periodEnded
            ? "The contribution window has ended."
            : "Contributions are being collected.",
        },
        {
          id: "review",
          label: "Review",
          state: periodEnded ? "current" : "locked",
          description: periodEnded
            ? "Ready for an approver to open review."
            : "Available when the contribution window ends.",
        },
        ...lockedSettlementSteps,
      ],
    };
  }

  if (epoch.status === "review") {
    return {
      isFolded: false,
      isPublished: false,
      isLatestFolded: false,
      steps: [
        completeCollect,
        {
          id: "review",
          label: "Review",
          state: "current",
          description: "Review contributions, then sign to finalize.",
        },
        ...lockedSettlementSteps,
      ],
    };
  }

  let publish: EpochCheckpoint;
  let claim: EpochCheckpoint;
  if (!folded) {
    publish = {
      id: "publish",
      label: "Publish",
      state: "unavailable",
      description: "No cumulative distribution manifest was built.",
    };
    claim = {
      id: "claim",
      label: "Claims open",
      state: "unavailable",
      description: "Claims require a published cumulative manifest.",
    };
  } else if (published) {
    publish = {
      id: "publish",
      label: "Publish",
      state: "complete",
      description:
        evidence.publishedThroughEpochId === epoch.id
          ? "This cumulative root is live on-chain."
          : `Covered by cumulative epoch #${evidence.publishedThroughEpochId}.`,
    };
    claim = {
      id: "claim",
      label: "Claims open",
      state: "current",
      description:
        "Contributors can pull tokens from the latest cumulative root.",
    };
  } else if (evidence.publicationEvidence === "unknown") {
    publish = {
      id: "publish",
      label: "Publish",
      state: "unknown",
      description: "On-chain publication could not be verified.",
    };
    claim = {
      id: "claim",
      label: "Claims open",
      state: "unknown",
      description:
        "Claim availability is unknown until chain evidence returns.",
    };
  } else if (latestFolded) {
    publish = {
      id: "publish",
      label: "Publish",
      state: "current",
      description: "The frozen manifest is ready for the scoped executor.",
    };
    claim = {
      id: "claim",
      label: "Claims open",
      state: "locked",
      description: "Claims open after the cumulative root is live.",
    };
  } else {
    publish = {
      id: "publish",
      label: "Publish",
      state: "unavailable",
      description:
        "A newer cumulative manifest exists; this root cannot be published directly.",
    };
    claim = {
      id: "claim",
      label: "Claims open",
      state: "locked",
      description: "No matching cumulative root is proven live.",
    };
  }

  return {
    isFolded: folded,
    isPublished: published,
    isLatestFolded: latestFolded,
    steps: [
      completeCollect,
      {
        id: "review",
        label: "Review",
        state: "complete",
        description: "The contribution set was reviewed and locked.",
      },
      {
        id: "finalize",
        label: "Finalize",
        state: "complete",
        description: folded
          ? "Signed statement finalized; cumulative manifest built."
          : "Signed statement finalized; no manifest was built.",
      },
      publish,
      claim,
    ],
  };
}

const completeCollect: EpochCheckpoint = {
  id: "collect",
  label: "Collect",
  state: "complete",
  description: "Contribution collection is closed.",
};

const lockedSettlementSteps: readonly EpochCheckpoint[] = [
  {
    id: "finalize",
    label: "Finalize",
    state: "locked",
    description: "Requires a completed review and approver signature.",
  },
  {
    id: "publish",
    label: "Publish",
    state: "locked",
    description: "Requires a finalized cumulative manifest.",
  },
  {
    id: "claim",
    label: "Claims open",
    state: "locked",
    description: "Requires a root proven live on-chain.",
  },
];

/** Review backlog first, then an ended open epoch, then the newest finalized settlement. */
export function selectFinishEpoch(
  epochs: readonly EpochView[],
  nowMs: number
): EpochView | null {
  const byOldestEnd = (a: EpochView, b: EpochView) =>
    Date.parse(a.periodEnd) - Date.parse(b.periodEnd);
  const review = epochs
    .filter((epoch) => epoch.status === "review")
    .sort(byOldestEnd)[0];
  if (review) return review;

  const endedOpen = epochs
    .filter(
      (epoch) =>
        epoch.status === "open" &&
        Number.isFinite(Date.parse(epoch.periodEnd)) &&
        Date.parse(epoch.periodEnd) <= nowMs
    )
    .sort(byOldestEnd)[0];
  if (endedOpen) return endedOpen;

  const finalized = epochs
    .filter((epoch) => epoch.status === "finalized")
    .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0];
  if (finalized) return finalized;

  return epochs.find((epoch) => epoch.status === "open") ?? null;
}
