// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/gates/provenance.gate`
 * Purpose: Unit coverage for the v0 deterministic provenance gate — known source_type set + source_ref required for external/derived classes.
 * Scope: Pure gate tests; exercises every accept + reject branch including the conservative "unset sourceType passes" default that lets the external-contribution adapter stamp provenance after the gate runs. Does not call any port, Doltgres, or HTTP layer.
 * Invariants: ENTRY_HAS_PROVENANCE
 * Side-effects: none
 * Links: packages/knowledge-store/src/domain/gates/provenance.gate.ts, work/projects/proj.knowledge-syntropy.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import { provenanceGate } from "../../src/domain/gates/provenance.gate.js";
import type { KnowledgeWriteCandidate } from "../../src/domain/gates/types.js";

function base(
  overrides: Partial<KnowledgeWriteCandidate> = {}
): KnowledgeWriteCandidate {
  return {
    id: "fed-rate-base-rate",
    domain: "prediction-market",
    title: "Fed rate cut base rate is 35% in election years",
    content: "Historical frequency since 1980 averages 35% per quarter.",
    ...overrides,
  };
}

describe("provenanceGate", () => {
  it("accepts unset sourceType (contribution path — adapter stamps later)", async () => {
    const result = await provenanceGate.check(base(), {});
    expect(result.ok).toBe(true);
  });

  it("accepts known sourceType without ref for human and agent", async () => {
    for (const sourceType of ["human", "agent", "analysis_signal"]) {
      const result = await provenanceGate.check(base({ sourceType }), {});
      expect(result.ok).toBe(true);
    }
  });

  it("rejects unknown sourceType", async () => {
    const result = await provenanceGate.check(
      base({ sourceType: "bogus" }),
      {}
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "source_type_unknown")).toBe(
        true
      );
    }
  });

  it("requires sourceRef when sourceType is external", async () => {
    const result = await provenanceGate.check(
      base({ sourceType: "external", sourceRef: undefined }),
      {}
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "source_ref_required")).toBe(
        true
      );
    }
  });

  it("requires sourceRef when sourceType is derived", async () => {
    const result = await provenanceGate.check(
      base({ sourceType: "derived", sourceRef: "   " }),
      {}
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "source_ref_required")).toBe(
        true
      );
    }
  });

  it("accepts external + valid sourceRef", async () => {
    const result = await provenanceGate.check(
      base({ sourceType: "external", sourceRef: "https://example.com/paper" }),
      {}
    );
    expect(result.ok).toBe(true);
  });

  it("accepts derived + valid sourceRef", async () => {
    const result = await provenanceGate.check(
      base({ sourceType: "derived", sourceRef: "signal:abc123" }),
      {}
    );
    expect(result.ok).toBe(true);
  });
});
