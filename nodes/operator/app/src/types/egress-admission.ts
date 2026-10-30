// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `egress-admission`
 * Purpose: Operator-only, credential-free immutable receipt identity and absolute-expiry policy.
 * Scope: Additive operator-only measured-admission core. No runtime activation.
 * Invariants: Existing receipt identity; no new pool, ledger or provider authority.
 * Side-effects: None at import; explicit callers own lifecycle.
 * Links: task.5385, compute-egress-measurement-writer
 * @internal
 */
export interface EgressReportIdentity {
  readonly receiptId: string;
  readonly nodeId: string;
  readonly lane: string;
  readonly compositeUid: string;
  readonly keyVersion: string;
}
export interface EgressObservation {
  readonly ipv4: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly observerOrigin: string;
}
export interface EgressReceiptObservation extends EgressObservation {
  readonly receiptId: string;
}
export type EgressPublishedPort = 5432 | 5435 | 6379 | 7233 | 4000;
export interface EgressDestination {
  readonly destination: string;
  readonly publishedPort: EgressPublishedPort;
}
export interface EgressGrant extends EgressDestination {
  readonly ipv4: string;
  readonly expiresAt: number;
}
export interface EgressObservationSnapshot {
  readonly complete: boolean;
  readonly observations: readonly EgressReceiptObservation[];
}
