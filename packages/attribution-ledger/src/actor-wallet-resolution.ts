// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Read-only actor-beneficiary wallet resolution contract for distribution folds. */

import type { ActorContributionAllocationRecord } from "./store";

export interface ActorWalletBindingEvidence {
  readonly bindingId: string;
  readonly evidenceEventId: string;
  readonly actorId: string;
  readonly provider: "wallet";
  readonly externalId: string;
  readonly bindingCreatedAt: string;
  readonly bindingEvidence: Readonly<Record<string, unknown>>;
}

export type ActorWalletResolutionFailureCode =
  | "beneficiary_actor_inactive"
  | "beneficiary_wallet_unbound"
  | "beneficiary_wallet_ambiguous"
  | "beneficiary_wallet_invalid";

export interface ActorWalletResolutionFailureEvidence {
  readonly code: ActorWalletResolutionFailureCode;
  readonly beneficiaryActorId: string;
  readonly observedBindingIds: readonly string[];
}

export type ActorBeneficiaryWalletResolution =
  | {
      readonly allocationRef: string;
      readonly beneficiaryActorId: string;
      readonly wallet: `0x${string}`;
      readonly bindingEvidence: ActorWalletBindingEvidence;
      readonly failureEvidence: null;
    }
  | {
      readonly allocationRef: string;
      readonly beneficiaryActorId: string;
      readonly wallet: null;
      readonly bindingEvidence: null;
      readonly failureEvidence: ActorWalletResolutionFailureEvidence;
    };

/**
 * Resolves only the beneficiary frozen into each signed allocation. The full
 * allocation record is supplied so adapters can retain provenance in traces,
 * but implementations must not derive a replacement beneficiary from mutable
 * parent, billing, OBO, account, or node ownership state.
 */
export interface ActorBeneficiaryWalletResolver {
  resolveBeneficiaryWallets(
    allocations: readonly ActorContributionAllocationRecord[]
  ): Promise<readonly ActorBeneficiaryWalletResolution[]>;
}
