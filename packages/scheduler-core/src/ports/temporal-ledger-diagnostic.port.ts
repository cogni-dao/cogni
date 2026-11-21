// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/ports/temporal-ledger-diagnostic`
 * Purpose: Read-only finite diagnostic interface, accepting only an admitted server binding.
 * Scope: Pure port; does not accept native SDK objects or identifiers from callers.
 * Invariants: Safe DTO output, bounded request-local cancellation.
 * Side-effects: none (interface)
 * Links: https://cognidao.org/knowledge/node-temporal-health-contract
 * @public
 */
import type {
  LedgerDiagnosticBinding,
  LedgerDiagnosticV1,
} from "../ledger-diagnostic";
export interface TemporalLedgerDiagnosticPort {
  read(
    binding: LedgerDiagnosticBinding,
    options: { readonly signal: AbortSignal; readonly deadline: number }
  ): Promise<LedgerDiagnosticV1>;
}
