// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ingestion-core`
 * Purpose: Pure domain types, port interface, and helpers for activity ingestion source adapters.
 * Scope: Purpose-neutral — shared across ledger and governance consumers. Does not contain adapter deps, I/O, or framework code.
 * Invariants:
 * - ADAPTERS_NOT_IN_CORE: Only types + pure helpers here. Implementations in services/.
 * - No imports from src/ or services/. Pure domain package.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

// Pure helpers
export { buildEventId, canonicalJson, hashCanonicalPayload } from "./helpers";
// Model types
export type {
  ActivityEvent,
  CollectParams,
  CollectResult,
  StreamCursor,
  StreamDefinition,
} from "./model";
// Port interfaces
export type {
  DataSourceRegistration,
  PollAdapter,
  SourceAdapter,
  WebhookNormalizer,
} from "./port";
export type { VcsTokenProvider, VcsTokenResult } from "./vcs-token-provider";
// Source adapter version constants
export { GITHUB_ADAPTER_VERSION } from "./versions";
