// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/source-adapter`
 * Purpose: Re-exports ingestion port types from @cogni/ingestion-core for app-layer consumers.
 * Scope: Type re-exports only. Does not contain implementations — canonical types live in the package.
 * Invariants: No runtime code. No adapter deps.
 * Side-effects: none
 * Links: docs/spec/attribution-ledger.md#source-adapter-interface
 * @public
 */

export type {
  ActivityEvent,
  CollectParams,
  CollectResult,
  DataSourceRegistration,
  PollAdapter,
  SourceAdapter,
  StreamCursor,
  StreamDefinition,
  WebhookNormalizer,
} from "@cogni/ingestion-core";
