// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/gates/shape.gate`
 * Purpose: Unit coverage for the v0 deterministic shape gate — slug pattern, title length, content non-empty, tag count.
 * Scope: Pure gate tests against the exported shapeGate; covers every rejection branch + the happy-path canonical-trim sanitization. Does not call any port, Doltgres, or HTTP layer.
 * Invariants: SHAPE_IS_THE_FLOOR
 * Side-effects: none
 * Links: packages/knowledge-store/src/domain/gates/shape.gate.ts, work/projects/proj.knowledge-syntropy.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import { shapeGate } from "../../src/domain/gates/shape.gate.js";
import type { KnowledgeWriteCandidate } from "../../src/domain/gates/types.js";

function base(
  overrides: Partial<KnowledgeWriteCandidate> = {}
): KnowledgeWriteCandidate {
  return {
    id: "fed-rate-base-rate",
    domain: "prediction-market",
    title: "Fed rate cut base rate is 35% in election years",
    content: "Historical frequency since 1980 averages 35% per quarter.",
    sourceType: "external",
    sourceRef: "https://bls.gov/...",
    ...overrides,
  };
}

describe("shapeGate", () => {
  it("accepts a canonical candidate", async () => {
    const result = await shapeGate.check(base(), {});
    expect(result.ok).toBe(true);
  });

  it("trims title whitespace into the sanitized candidate", async () => {
    const result = await shapeGate.check(
      base({ title: "  Trimmed title here  " }),
      {}
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.title).toBe("Trimmed title here");
    }
  });

  it("treats id as optional but validates when present", async () => {
    const result = await shapeGate.check({ ...base(), id: undefined }, {});
    expect(result.ok).toBe(true);
  });

  describe("slug rejection (shape)", () => {
    const bad = [
      "-leading-dash",
      "trailing-dash-",
      "UPPERCASE",
      "snake_case",
      "double--dash",
      "colon:in:slug",
      "slug.with.dots",
      "one-two-three-four-five", // 5 segments, 23 chars — fails regex only
    ];
    for (const id of bad) {
      it(`rejects "${id}"`, async () => {
        const result = await shapeGate.check(base({ id }), {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.errors.some((e) => e.code === "slug_invalid")).toBe(
            true
          );
        }
      });
    }

    it("rejects real-world bloat sample (length + segment-count fail)", async () => {
      // meta-contribution-branch-flow-merkle-dag-v1 is the motivating bloat
      // case from validate-candidate. Length check fires first; regex
      // check would also fire. Either error code is acceptable evidence
      // the gate rejected it.
      const result = await shapeGate.check(
        base({ id: "meta-contribution-branch-flow-merkle-dag-v1" }),
        {}
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => e.code === "slug_invalid" || e.code === "slug_length"
          )
        ).toBe(true);
      }
    });
  });

  describe("slug rejection (length)", () => {
    it("rejects single-char slug", async () => {
      const result = await shapeGate.check(base({ id: "a" }), {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === "slug_length")).toBe(true);
      }
    });

    it("rejects too-long slug", async () => {
      const result = await shapeGate.check(base({ id: "x".repeat(41) }), {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === "slug_length")).toBe(true);
      }
    });
  });

  describe("slug acceptance", () => {
    const good = [
      "ab", // min length, single token
      "fed-rate", // 2 segments
      "fed-rate-base-rate", // 4 segments
      "validate-candidate-1356-test", // 4 segments, mixed alphanumeric
    ];
    for (const id of good) {
      it(`accepts "${id}"`, async () => {
        const result = await shapeGate.check(base({ id }), {});
        expect(result.ok).toBe(true);
      });
    }
  });

  describe("title length", () => {
    it("rejects too-short titles", async () => {
      const result = await shapeGate.check(base({ title: "ab" }), {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === "title_length")).toBe(true);
      }
    });

    it("rejects too-long titles", async () => {
      const result = await shapeGate.check(base({ title: "x".repeat(61) }), {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === "title_length")).toBe(true);
      }
    });

    it("rejects trailing punctuation", async () => {
      const result = await shapeGate.check(
        base({ title: "Atomic claim ends with a period." }),
        {}
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.code === "title_trailing_punctuation")
        ).toBe(true);
      }
    });

    describe("title section-separator rejection", () => {
      // Real-world samples from the v0 candidate-a run that motivated this rule.
      const bad = [
        "Contribution Branch Flow · Merkle DAG",
        "Knowledge Block Visuals · Rendered Primitive Inventory",
        "Open-Source AI Tooling — Multi-Tenant Capability Matrix",
        "Foo -- Bar baseline",
      ];
      for (const title of bad) {
        it(`rejects "${title}"`, async () => {
          const result = await shapeGate.check(base({ title }), {});
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(
              result.errors.some((e) => e.code === "title_section_separator")
            ).toBe(true);
          }
        });
      }

      it("does not false-positive on internal hyphens (Open-Source, Multi-Tenant)", async () => {
        const result = await shapeGate.check(
          base({ title: "Open-Source AI Tooling baseline" }),
          {}
        );
        expect(result.ok).toBe(true);
      });
    });
  });

  it("rejects empty content", async () => {
    const result = await shapeGate.check(base({ content: "" }), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "content_empty")).toBe(true);
    }
  });

  describe("tags", () => {
    it("rejects too many tags", async () => {
      const result = await shapeGate.check(
        base({ tags: Array.from({ length: 17 }, (_, i) => `tag-${i}`) }),
        {}
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === "tags_too_many")).toBe(
          true
        );
      }
    });

    it("rejects empty-string tag", async () => {
      const result = await shapeGate.check(base({ tags: [""] }), {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === "tag_length")).toBe(true);
      }
    });

    it("rejects oversized tag", async () => {
      const result = await shapeGate.check(
        base({ tags: ["x".repeat(33)] }),
        {}
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === "tag_length")).toBe(true);
      }
    });

    it("accepts well-shaped tags", async () => {
      const result = await shapeGate.check(
        base({ tags: ["macro", "fed", "rate-cut"] }),
        {}
      );
      expect(result.ok).toBe(true);
    });
  });

  it("collects multiple errors in a single response", async () => {
    const result = await shapeGate.check(
      base({ id: "BAD", title: "x", content: "" }),
      {}
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
