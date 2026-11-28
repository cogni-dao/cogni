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
 * Links: https://node-template.cognidao.org/knowledge/knowledge-recall-path
 * @public
 */

/** The tool-facing capability: the host binds the run attribution to each write (task.0133), so a tool never builds one. */
export type {
  ChainDirection,
  ChainNodeEntry,
  DecideParams,
  EdoSourceType,
  EdoToolCapability as EdoCapability,
  GetChainParams,
  GetChainResult,
  HypothesizeParams,
  RecordOutcomeParams,
  RecordOutcomeResult,
} from "@cogni/shared-knowledge-store/contracts";
