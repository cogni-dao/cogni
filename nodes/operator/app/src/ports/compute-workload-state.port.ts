// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type {
  ComputeWorkload,
  ComputeWorkloadStatus,
} from "./compute-workload.types";

export interface ComputeWorkloadStatePort {
  list(): Promise<readonly ComputeWorkload[]>;
  /** CAS the pre-I/O receipt against metadata.resourceVersion. False means another writer won. */
  claimAttempt(input: {
    resource: ComputeWorkload;
    receipt: string;
  }): Promise<boolean>;
  /** Durable wallet-wide create slot. One uncertain allocation blocks all later creates. */
  claimWalletAllocation(input: {
    attemptKey: string;
    workloadUid: string;
  }): Promise<
    | { state: "claimed"; allocationCursor?: string }
    | { state: "owned"; allocationCursor?: string }
    | { state: "blocked"; ownerAttemptKey: string }
  >;
  /** MUST reject when no live slot is owned by `attemptKey`: a preparing attempt owns its slot by construction, so absence means another writer settled it and the caller must fail closed before provider I/O. */
  prepareWalletAllocation(input: {
    attemptKey: string;
    allocationCursor: string;
  }): Promise<void>;
  /** Idempotent settle: an absent or foreign-owned slot means the work is already done. */
  completeWalletAllocation(input: { attemptKey: string }): Promise<void>;
  patchMetadata(input: {
    resource: ComputeWorkload;
    annotations?: Readonly<Record<string, string | null>>;
    finalizers?: readonly string[];
  }): Promise<void>;
  patchStatus(input: {
    resource: ComputeWorkload;
    status: ComputeWorkloadStatus;
  }): Promise<void>;
  event(input: {
    resource: ComputeWorkload;
    type: "Normal" | "Warning";
    reason: string;
    message: string;
  }): Promise<void>;
}
