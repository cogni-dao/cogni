// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/gates/chain`
 * Purpose: Unit coverage for the gate-chain runner — tier short-circuiting, intra-tier parallelism + error accumulation, candidate sanitization flow across tiers.
 * Scope: Pure tests against runGateChain with hand-rolled fake gates. Does not exercise the production shape/provenance gates (those have their own coverage). Does not call any port.
 * Invariants: GATES_FAIL_CLOSED, SAME_TIER_PARALLEL
 * Side-effects: none
 * Links: packages/knowledge-store/src/domain/gates/chain.ts, work/projects/proj.knowledge-syntropy.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import { runGateChain } from "../../src/domain/gates/chain.js";
import { V0_DETERMINISTIC_GATES } from "../../src/domain/gates/index.js";
import type {
  GateContext,
  GateResult,
  KnowledgeGate,
  KnowledgeWriteCandidate,
} from "../../src/domain/gates/types.js";

function base(
  overrides: Partial<KnowledgeWriteCandidate> = {}
): KnowledgeWriteCandidate {
  return {
    id: "test-claim",
    domain: "test",
    title: "test claim title",
    content: "test content body",
    ...overrides,
  };
}

function fakeGate(
  name: string,
  tier: "v0" | "v1" | "v2",
  impl: (c: KnowledgeWriteCandidate) => Promise<GateResult> | GateResult
): KnowledgeGate {
  return {
    name,
    tier,
    check: async (c: KnowledgeWriteCandidate, _ctx: GateContext) => impl(c),
  };
}

const accept: (name: string, tier: "v0" | "v1" | "v2") => KnowledgeGate = (
  name,
  tier
) => fakeGate(name, tier, (c) => ({ ok: true, candidate: c }));

const rejectWith = (
  name: string,
  tier: "v0" | "v1" | "v2",
  code: string
): KnowledgeGate =>
  fakeGate(name, tier, () => ({
    ok: false,
    errors: [{ gate: name, code, message: `${name} says ${code}` }],
  }));

describe("runGateChain", () => {
  it("returns ok with the original candidate when chain is empty", async () => {
    const result = await runGateChain([], base(), {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.id).toBe("test-claim");
    }
  });

  it("returns ok when all gates pass", async () => {
    const result = await runGateChain(
      [accept("a", "v0"), accept("b", "v0")],
      base(),
      {}
    );
    expect(result.ok).toBe(true);
  });

  it("accumulates errors from all gates in the failing tier", async () => {
    const result = await runGateChain(
      [rejectWith("a", "v0", "a_failed"), rejectWith("b", "v0", "b_failed")],
      base(),
      {}
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors.map((e) => e.code).sort()).toEqual([
        "a_failed",
        "b_failed",
      ]);
    }
  });

  it("short-circuits on first failing tier — v1 gates do not run after v0 fails", async () => {
    let v1Ran = false;
    const v1Sentinel = fakeGate("v1-sentinel", "v1", (c) => {
      v1Ran = true;
      return { ok: true, candidate: c };
    });
    const result = await runGateChain(
      [rejectWith("a", "v0", "a_failed"), v1Sentinel],
      base(),
      {}
    );
    expect(result.ok).toBe(false);
    expect(v1Ran).toBe(false);
  });

  it("runs v0 then v1 when v0 passes", async () => {
    let v1Ran = false;
    const v1Sentinel = fakeGate("v1-sentinel", "v1", (c) => {
      v1Ran = true;
      return { ok: true, candidate: c };
    });
    const result = await runGateChain(
      [accept("a", "v0"), v1Sentinel],
      base(),
      {}
    );
    expect(result.ok).toBe(true);
    expect(v1Ran).toBe(true);
  });

  it("flows sanitized candidate from earlier tier into later tier", async () => {
    const v0Sanitize = fakeGate("v0-sanitize", "v0", (c) => ({
      ok: true,
      candidate: { ...c, title: `[v0]${c.title}` },
    }));
    let observedTitle = "";
    const v1Observe = fakeGate("v1-observe", "v1", (c) => {
      observedTitle = c.title;
      return { ok: true, candidate: c };
    });
    await runGateChain([v0Sanitize, v1Observe], base(), {});
    expect(observedTitle).toBe("[v0]test claim title");
  });
});

describe("V0_DETERMINISTIC_GATES", () => {
  it("exposes shape + provenance in that order", () => {
    expect(V0_DETERMINISTIC_GATES.map((g) => g.name)).toEqual([
      "shape",
      "provenance",
    ]);
  });

  it("end-to-end accepts a canonical candidate", async () => {
    const result = await runGateChain(
      V0_DETERMINISTIC_GATES,
      {
        id: "well-formed-id",
        domain: "prediction-market",
        title: "Atomic claim about the world",
        content: "Backed by sources",
        sourceType: "external",
        sourceRef: "https://example.com",
      },
      {}
    );
    expect(result.ok).toBe(true);
  });

  it("end-to-end rejects a bad candidate with errors from both gates in same tier", async () => {
    const result = await runGateChain(
      V0_DETERMINISTIC_GATES,
      {
        id: "BAD",
        domain: "x",
        title: "ab",
        content: "ok",
        sourceType: "external",
        sourceRef: "",
      },
      {}
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const gates = new Set(result.errors.map((e) => e.gate));
      expect(gates.has("shape")).toBe(true);
      expect(gates.has("provenance")).toBe(true);
    }
  });
});
