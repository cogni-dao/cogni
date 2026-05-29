// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/gates/provenance`
 * Purpose: Cross-field gate enforcing ENTRY_HAS_PROVENANCE — `source_type` is always set; `source_ref` is required when `source_type ∈ {external, derived}` because those classes are unverifiable without an origin pointer.
 * Scope: Pure cross-field validation tying source_type to source_ref. Does not validate the contents of source_ref itself (URL, DOI, signal ID, etc are all accepted as opaque strings at this layer).
 * Invariants:
 *   - ENTRY_HAS_PROVENANCE (knowledge-syntropy.md): no knowledge without origin.
 * Side-effects: none
 * Links: work/projects/proj.knowledge-syntropy.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import type {
  GateError,
  GateResult,
  KnowledgeGate,
  KnowledgeWriteCandidate,
} from "./types.js";

const KNOWN_SOURCE_TYPES = new Set([
  "human",
  "agent",
  "analysis_signal",
  "external",
  "derived",
]);

const REQUIRES_REF = new Set(["external", "derived"]);

export const provenanceGate: KnowledgeGate = {
  name: "provenance",
  tier: "v0",
  async check(input: KnowledgeWriteCandidate): Promise<GateResult> {
    const errors: GateError[] = [];

    // External contributions may omit sourceType at the edit layer; the
    // adapter stamps "external" and a contribution:<id>:<seq> ref on write.
    // For the gate to be uniform, we treat unset as "agent" (the conservative
    // default for any bearer-token call) and require a ref only when the
    // caller explicitly claimed external/derived.
    const sourceType = input.sourceType?.trim() ?? "";

    if (sourceType.length > 0 && !KNOWN_SOURCE_TYPES.has(sourceType)) {
      errors.push({
        gate: "provenance",
        field: "sourceType",
        code: "source_type_unknown",
        message: `sourceType must be one of ${Array.from(KNOWN_SOURCE_TYPES).join(", ")} (got "${sourceType}")`,
      });
    }

    if (REQUIRES_REF.has(sourceType)) {
      const ref = input.sourceRef?.trim() ?? "";
      if (ref.length === 0) {
        errors.push({
          gate: "provenance",
          field: "sourceRef",
          code: "source_ref_required",
          message: `sourceRef is required when sourceType="${sourceType}" — external and derived claims must be traceable to an origin`,
        });
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true, candidate: input };
  },
};
