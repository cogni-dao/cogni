// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** An exact provider-native amount. Conversion to fiat is deliberately out of scope. */
export interface ComputeCostAmount {
  readonly amount: string;
  readonly denom: string;
}

/** Exact rate accepted for one paid resource, in the provider's native meter. */
export interface ComputeCostRate extends ComputeCostAmount {
  readonly unit: string;
}

/** Opaque external resource identity known immediately after provider allocation. */
export interface ComputeResourceCostIdentity {
  readonly computeProvider: string;
  readonly resourceId: string;
}

/**
 * Provider-neutral cost evidence for one externally allocated compute resource.
 *
 * Provider adapters preserve native identifiers, denominations, amounts, and meter
 * units. Provider account IDs are infrastructure evidence, never economic payer,
 * sponsor, DAO, actor, or billing-account identity.
 */
export interface ComputeResourceCostEvidence
  extends ComputeResourceCostIdentity {
  /** Deployment consumer/owner identifier in the compute provider's own namespace. */
  readonly computeProviderAccountId: string;
  /** Lease supplier identifier in the compute provider's own namespace. */
  readonly computeSupplierAccountId: string;
  readonly rate: ComputeCostRate;
  /** Provider-native chain height/meter position. It is not a wall-clock timestamp. */
  readonly providerOpenedAtPosition?: string;
  /** Provider-native close height/meter position. It is not a wall-clock timestamp. */
  readonly providerClosedAtPosition?: string;
  readonly escrow?: {
    readonly state: string;
    /** Provider-native settlement height/meter position, never a Date. */
    readonly providerSettledAtPosition?: string;
    readonly funds: readonly ComputeCostAmount[];
    /** Provider-reported cumulative transfer; this is spend evidence, not an estimate. */
    readonly transferred: readonly ComputeCostAmount[];
  };
  readonly observedAt: Date;
}

/** Read-only evidence seam implemented by each paid compute provider adapter. */
export interface ComputeCostEvidencePort {
  observeCost(input: {
    resourceId: string;
  }): Promise<ComputeResourceCostEvidence>;
}
