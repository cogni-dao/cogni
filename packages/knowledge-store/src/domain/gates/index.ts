// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/gates`
 * Purpose: Public entry point for the knowledge write gate chain — types,
 *   chain runner, and the v0 deterministic gate set.
 * Scope: Re-exports only.
 * @public
 */

export { runGateChain } from "./chain.js";
export { provenanceGate } from "./provenance.gate.js";
export { shapeGate } from "./shape.gate.js";
export type {
  GateContext,
  GateError,
  GateResult,
  KnowledgeGate,
  KnowledgeWriteCandidate,
} from "./types.js";
export { KnowledgeGateError } from "./types.js";

import { provenanceGate } from "./provenance.gate.js";
import { shapeGate } from "./shape.gate.js";
import type { KnowledgeGate } from "./types.js";

/**
 * The v0 deterministic gate set. Order is informational (gates within a tier
 * run concurrently via `runGateChain`).
 */
export const V0_DETERMINISTIC_GATES: readonly KnowledgeGate[] = [
  shapeGate,
  provenanceGate,
];
