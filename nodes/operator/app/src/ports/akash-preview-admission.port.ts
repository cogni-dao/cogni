// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { AkashTxAllocationRecord } from "./akash-tx.port";

/** Preview lifetime policy is distinct from custody of a possibly-paid allocation. */
export interface AkashPreviewAdmissionInput {
  readonly deploymentId: string;
  readonly nodeId: string;
  readonly environment: string;
  readonly requestKey: string;
  readonly payloadHash: string;
  readonly sourceSha: string;
  readonly artifactRef: string;
  readonly bundleRef: string;
  readonly expiresAt: Date;
}

export interface AkashPreviewAdmission extends AkashPreviewAdmissionInput {
  readonly stateSlot: 0 | 1;
  readonly resetGeneration?: string;
  readonly resolvedSdlHash?: string;
  readonly revokedAt?: Date;
  readonly closureObservedAt?: Date;
}

export class AkashPreviewAdmissionError extends Error {
  constructor(
    readonly reason:
      | "missing"
      | "terminal"
      | "expired"
      | "conflict"
      | "capacity"
      | "unresolved"
  ) {
    super(`preview_admission_${reason}`);
  }
}

/** Optional pilot capability; ordinary allocations do not consult this store. */
export interface AkashPreviewAdmissionPort {
  admit(input: AkashPreviewAdmissionInput): Promise<AkashPreviewAdmission>;
  /** Atomic absent-request cancellation; frozen input is required before any admission exists. */
  cancel(input: AkashPreviewAdmissionInput): Promise<AkashPreviewAdmission>;
  /** Holds the same fence as provider submission through bounded pair reset/migration. */
  withUnallocatedStateReservation<T extends { resetGeneration: string }>(
    deploymentId: string,
    stateSlot: 0 | 1,
    action: () => Promise<T>
  ): Promise<T>;
  /** Fence a bounded migration Job ensure against retirement and later pair reuse. */
  withActiveState<T>(
    input: { deploymentId: string; stateSlot: 0 | 1; resetGeneration: string },
    action: () => Promise<T>
  ): Promise<T>;
  /** Bind private resolved SDL bytes once; public request identity never exposes secrets. */
  bindResolvedSpec(input: {
    deploymentId: string;
    sourceSha: string;
    artifactRef: string;
    sdlHash: string;
  }): Promise<void>;
  read(deploymentId: string): Promise<AkashPreviewAdmission | null>;
  revoke(deploymentId: string): Promise<AkashPreviewAdmission>;
  assertActive(input: {
    deploymentId: string;
    nodeId: string;
    environment: string;
  }): Promise<void>;
  /** Durable submission intent linearizes before revocation; cancellation then remains pending. */
  beforeProviderTransaction(input: {
    deploymentId: string;
    cogniKey: string;
    phase: "deployment" | "lease";
  }): Promise<void>;
  finishDispatch(input: {
    deploymentId: string;
    cogniKey: string;
  }): Promise<void>;
  receipts(deploymentId: string): Promise<readonly AkashTxAllocationRecord[]>;
  /** Caller supplies ONLY receipt ids whose handles it independently observed closed. */
  finishRetirement(input: {
    deploymentId: string;
    observedClosedReceiptIds: readonly string[];
  }): Promise<AkashPreviewAdmission>;
}

export interface AkashPreviewRetirement {
  readonly deploymentId: string;
  readonly closed: boolean;
  readonly pendingReceiptIds: readonly string[];
}
