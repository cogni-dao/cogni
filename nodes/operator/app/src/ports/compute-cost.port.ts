// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exact provider-native amount. Fiat conversion is deliberately out of scope. */
export interface ComputeCostAmount {
  readonly amount: string;
  readonly denom: string;
}

/** Exact accepted rate in the provider's native meter. */
export interface ComputeCostRate extends ComputeCostAmount {
  readonly unit: string;
}

/** Opaque identity for one paid resource. */
export interface ComputeResourceCostIdentity {
  readonly computeProvider: string;
  /** Raw account at that provider which owns/consumes this resource; never Cogni identity. */
  readonly providerConsumerAccountId: string;
  readonly resourceId: string;
}

/**
 * Provider-neutral cost evidence for one paid resource.
 *
 * Provider account identifiers are raw infrastructure evidence. They never imply a payer,
 * sponsor, DAO, actor, user, wallet owner, or billing account.
 */
export interface ComputeResourceCostEvidence
  extends ComputeResourceCostIdentity {
  /** Raw host/provider account which supplies this provider-native resource. */
  readonly providerSupplierAccountId: string;
  readonly rate: ComputeCostRate;
  /** Provider-native chain height/meter position, not a wall-clock timestamp. */
  readonly providerOpenedAtPosition?: string;
  /** Provider-native chain height/meter position, not a wall-clock timestamp. */
  readonly providerClosedAtPosition?: string;
  readonly escrow: {
    readonly state: string;
    readonly providerSettledAtPosition?: string;
    readonly funds: readonly ComputeCostAmount[];
    /** Provider-reported cumulative transfer; actual spend evidence, not an estimate. */
    readonly transferred: readonly ComputeCostAmount[];
  };
  readonly observedAt: Date;
}

/** Read-only evidence seam implemented by a paid compute provider adapter. */
export interface ComputeCostEvidencePort {
  observeCost(input: {
    resourceId: string;
  }): Promise<ComputeResourceCostEvidence>;
}

export type ComputeCostIntervalState = "allocated" | "active" | "closed";

/** Internal node-level report. `nodeId` is infrastructure identity only. */
export interface ComputeCostReport {
  readonly nodeId: string;
  readonly allocatedIntervals: number;
  readonly activeIntervals: number;
  readonly closedIntervals: number;
  readonly transferred: readonly ComputeCostAmount[];
  readonly activeRates: readonly ComputeCostRate[];
}

export class ComputeCostInvariantError extends Error {
  override readonly name = "ComputeCostInvariantError";
}

/**
 * Durable cost facts attached to an already-authoritative allocation receipt.
 *
 * The allocation ledger remains the sole pre-transaction receipt. `bind` attaches cost state
 * only after that receipt has durably recorded the provider handle. Evidence advances
 * monotonically; close is terminal.
 */
export interface ComputeCostStorePort {
  bind(input: {
    allocationReceiptId: string;
    resource: ComputeResourceCostIdentity;
  }): Promise<void>;
  observe(input: {
    allocationReceiptId: string;
    evidence: ComputeResourceCostEvidence;
  }): Promise<void>;
  close(input: { allocationReceiptId: string }): Promise<void>;
  reportByNode(): Promise<readonly ComputeCostReport[]>;
  /**
   * Return reports for an already-authorized node set.
   *
   * Callers must resolve access before invoking this method. Implementations must push the
   * node-id restriction into the backing query; fleet-wide reads followed by application-side
   * filtering are not an acceptable implementation of this boundary.
   */
  reportByNodeIds(
    nodeIds: readonly string[]
  ): Promise<readonly ComputeCostReport[]>;
}
