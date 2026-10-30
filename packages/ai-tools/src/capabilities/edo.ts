// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/edo`
 * Purpose: EdoCapability interface and parameter types for atomic four-beat operations on the hypothesis loop.
 * Scope: Interface + parameter types only. Does not contain I/O, implementations, or framework dependencies.
 * Invariants:
 *   - AUTH_VIA_CAPABILITY_INTERFACE: tools receive this, never a DSN.
 *   - EDO_TOOLS_ATOMIC: each method writes entry + edges + commit in one call.
 * Side-effects: none
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

export type {
  EdoSourceType,
  HypothesizeParams,
  DecideParams,
  RecordOutcomeParams,
  RecordOutcomeResult,
  ChainDirection,
  GetChainParams,
  ChainNodeEntry,
  GetChainResult,
  EdoCapability,
} from "@cogni/shared-knowledge-store/contracts";
