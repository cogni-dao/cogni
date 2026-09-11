// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type {
  ComputeCostAmount,
  ComputeCostRate,
  ComputeResourceCostEvidence,
  ComputeResourceCostIdentity,
} from "./compute-cost-evidence.port";

export type ComputeCostIntervalState =
  | "prepared"
  | "allocated"
  | "active"
  | "closed";

/** Git/Kubernetes resource context known before any provider mutation. */
export interface ComputeResourceCostContext {
  readonly attemptKey: string;
  readonly nodeId: string;
  readonly environment: string;
  readonly workloadUid: string;
  readonly workloadGeneration: number;
  readonly sourceSha: string;
  /** Value-free resource declaration used to explain cost differences later. */
  readonly resourceShape: Readonly<Record<string, unknown>>;
  readonly preparedAt: Date;
}

export interface ComputeCostInterval extends ComputeResourceCostContext {
  readonly state: ComputeCostIntervalState;
  readonly resource?: ComputeResourceCostIdentity;
  readonly evidence?: ComputeResourceCostEvidence;
  /** Controller observation time; present even if the final provider evidence read failed. */
  readonly closedRecordedAt?: Date;
}

export class ComputeCostInvariantError extends Error {
  override readonly name = "ComputeCostInvariantError";
}

/**
 * Durable resource-to-node infrastructure allocation boundary for paid compute.
 *
 * `prepare` must complete before provider create I/O. `bind` attaches the paid
 * resource identity. All operations are idempotent for equivalent input and reject
 * identity/rate regression or decreasing cumulative spend.
 */
export interface ComputeCostStorePort {
  prepare(input: ComputeResourceCostContext): Promise<ComputeCostInterval>;
  bind(input: {
    attemptKey: string;
    resource: ComputeResourceCostIdentity;
  }): Promise<ComputeCostInterval>;
  observe(input: {
    attemptKey: string;
    evidence: ComputeResourceCostEvidence;
  }): Promise<ComputeCostInterval>;
  close(input: {
    attemptKey: string;
    closedRecordedAt: Date;
  }): Promise<ComputeCostInterval>;
  findByResource(input: {
    computeProvider: string;
    resourceId: string;
  }): Promise<ComputeCostInterval | null>;
}

export interface ComputeCostReport {
  readonly nodeId: string;
  readonly preparedIntervals: number;
  readonly allocatedIntervals: number;
  readonly activeIntervals: number;
  readonly closedIntervals: number;
  readonly transferred: readonly ComputeCostAmount[];
  readonly activeRates: readonly ComputeCostRate[];
}

/**
 * Internal fleet report grouped only by infrastructure node_id. This is neither
 * payment tenancy nor an assertion about a DAO, actor, sponsor, or economic payer.
 */
export interface ComputeCostReportPort {
  reportByNode(): Promise<readonly ComputeCostReport[]>;
}
