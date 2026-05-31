// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/attribution-store`
 * Purpose: Re-exports AttributionStore port and related types from @cogni/attribution-ledger.
 * Scope: Type re-exports only. Does not contain implementations.
 * Invariants: Named exports only, no runtime coupling.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/store.ts, docs/spec/attribution-ledger.md
 * @public
 */

export type {
  AttributionEpoch,
  AttributionPoolComponent,
  AttributionSelection,
  AttributionStatement,
  AttributionStatementSignature,
  AttributionStore,
  EpochUserProjection,
  IngestionCursor,
  IngestionReceipt,
  InsertPoolComponentParams,
  InsertReceiptParams,
  InsertSignatureParams,
  InsertStatementParams,
  InsertUserProjectionParams,
  UpsertSelectionParams,
} from "@cogni/attribution-ledger";
