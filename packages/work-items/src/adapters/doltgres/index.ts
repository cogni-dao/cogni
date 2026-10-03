// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/adapters/doltgres`
 * Purpose: Barrel export for the Doltgres work-item adapter every node serves over HTTP.
 * Scope: Re-exports only. Does not contain implementation.
 * Invariants: Curated exports — never a wildcard (CURATED_EXPORTS).
 * Side-effects: none
 * Links: docs/spec/work-items-port.md
 * @public
 */

export {
  DoltgresWorkItemAdapter,
  type DoltgresWorkItemAdapterOptions,
  OPERATOR_ID_FLOOR,
  WorkItemAlreadyExistsError,
} from "./adapter.js";
export {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  type WorkItemCursor,
} from "./cursor.js";
export type {
  WorkItemsCreateInput,
  WorkItemsDoltgresPort,
  WorkItemsPatchInput,
  WorkItemsPatchSet,
} from "./ports.js";
