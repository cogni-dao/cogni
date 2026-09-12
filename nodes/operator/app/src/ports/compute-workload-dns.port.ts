// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exact-record DNS ownership boundary for an off-cluster workload. */
export interface ComputeWorkloadDnsPort {
  reconcile(input: { hostname: string; target: string }): Promise<void>;
  /** Delete only when the live record still equals expectedTarget. */
  deleteOwned(input: {
    hostname: string;
    expectedTarget: string;
  }): Promise<"deleted" | "absent">;
}
