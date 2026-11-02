// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@types/akash-native-state`
 * Purpose: App-private public-chain evidence DTOs; independent of Console lifecycle enums.
 * Scope: Types only. No health, closure, spending or recovery policy.
 * Invariants: lossless DSEQ; full lease identity including bseq zero; independent coverage.
 * Side-effects: none
 * Links: bug.5556; Akash chain-sdk 23a32e89.
 * @internal
 */
export type NativeReadErrorCode =
  | "owner_unavailable"
  | "invalid_handle"
  | "invalid_response"
  | "identity_mismatch"
  | "http_error"
  | "timeout"
  | "budget_exceeded"
  | "aborted"
  | "network_error"
  | "response_too_large"
  | "pagination_incomplete"
  | "conflicting_read"
  | "not_requested"
  | "reader_unavailable"
  | "height_mismatch"
  | "inventory_overflow";

export interface NativeLeaseState {
  readonly id: {
    readonly owner: string;
    readonly dseq: string;
    readonly gseq: number;
    readonly oseq: number;
    readonly provider: string;
    readonly bseq: number;
  };
  readonly state: "active" | "insufficient_funds" | "closed" | "reclaiming";
  readonly observedAt: string;
}

export interface AkashNativeObservation {
  readonly source: string | null;
  /** End of this observation window, not a chain snapshot or ledger time. */
  readonly observedAt: string | null;
  readonly deploymentState: "active" | "closed" | null;
  readonly deploymentCoverage: "complete" | "unknown";
  readonly deploymentObservedAt: string | null;
  readonly leaseStates: readonly NativeLeaseState[];
  readonly leaseCoverage: "complete" | "partial" | "unknown";
  readonly leasePages: readonly {
    readonly observedAt: string;
    readonly count: number;
  }[];
  readonly errorCode: NativeReadErrorCode | null;
}

/** Complete owner ACTIVE inventory at one consensus height; never a financial verdict. */
export interface AkashNativeWalletInventory {
  readonly owner: string;
  readonly height: string;
  readonly observedAt: string;
  readonly targets: readonly {
    readonly dseq: string;
    readonly groups: readonly {
      readonly gseq: number;
      readonly state: string;
    }[];
    readonly orders: readonly {
      readonly gseq: number;
      readonly oseq: number;
      readonly state: string;
    }[];
    readonly leases: readonly NativeLeaseState[];
  }[];
}
export interface AkashNativeAdmissionReader {
  readWalletInventory(input: {
    signal?: AbortSignal;
    deadlineAt: number;
  }): Promise<AkashNativeWalletInventory>;
  readOwnClosed(input: {
    dseq: string;
    signal?: AbortSignal;
    deadlineAt: number;
  }): Promise<{ owner: string; dseq: string; height: string; closed: boolean }>;
}
