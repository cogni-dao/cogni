// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `egress-receipt.port`
 * Purpose: Narrow additive operations on the existing receipt ledger; never provider authority.
 * Scope: Additive operator-only measured-admission core. No runtime activation.
 * Invariants: Existing receipt identity; no new pool, ledger or provider authority.
 * Side-effects: None at import; explicit callers own lifecycle.
 * Links: task.5385, compute-egress-measurement-writer
 * @internal
 */
import type {
  EgressObservationSnapshot,
  EgressReportIdentity,
} from "@/types/egress-admission";
export interface EgressReceiptPort {
  /** Pin once, or return the previous immutable version. Identity mismatch fails closed. */
  pin(identity: EgressReportIdentity): Promise<string>;
  /** Called only after strict MAC verification and independently trusted peer extraction. */
  report(
    identity: EgressReportIdentity,
    observedIpv4: string,
    observerOrigin: string
  ): Promise<void>;
  /** Entire bounded wallet snapshot, or rejection. A limited success is never complete. */
  snapshot(): Promise<EgressObservationSnapshot>;
  /** Stop new work and request cancellation; original query still owns its slot. */
  stop(): void;
}
