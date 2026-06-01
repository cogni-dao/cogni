// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/ai/prompt-hash.test`
 * Purpose: Unit tests for prompt hash stability and canonicalization.
 * Scope: Verify hash is deterministic and stable across construction order variations. Does NOT test LLM integration.
 * Invariants: Per AI_SETUP_SPEC.md Test Gates - P0 required tests.
 * Side-effects: none
 * Notes: Uses existing message builders from _fakes.
 * Links: AI_SETUP_SPEC.md, shared/ai/prompt-hash.ts
 * @internal
 */

import {
  computePromptHash,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from "@cogni/node-shared";
import { TEST_MODEL_ID } from "@tests/_fakes";
import { describe, expect, it } from "vitest";

describe("shared/ai/prompt-hash", () => {
  // Reusable base payload
  const basePayload = {
    model: TEST_MODEL_ID,
    messages: [{ role: "user", content: "Hello" }],
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
  };

  describe("canonicalization stability (P0 invariant)", () => {
    it("produces identical hash regardless of object key insertion order", () => {
      // Payload A: standard order
      const payloadA = { ...basePayload };

      // Payload B: different construction order (same values)
      const payloadB = {
        maxTokens: DEFAULT_MAX_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
        model: TEST_MODEL_ID,
        messages: [{ content: "Hello", role: "user" }],
      };

      expect(computePromptHash(payloadA)).toBe(computePromptHash(payloadB));
    });

    it("returns 64-char hex string (SHA-256)", () => {
      expect(computePromptHash(basePayload)).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("hash sensitivity", () => {
    it("changes when model changes", () => {
      const hashA = computePromptHash(basePayload);
      const hashB = computePromptHash({ ...basePayload, model: "other-model" });
      expect(hashA).not.toBe(hashB);
    });

    it("changes when temperature changes", () => {
      const hashA = computePromptHash(basePayload);
      const hashB = computePromptHash({ ...basePayload, temperature: 0.9 });
      expect(hashA).not.toBe(hashB);
    });

    it("changes when message content changes", () => {
      const hashA = computePromptHash(basePayload);
      const hashB = computePromptHash({
        ...basePayload,
        messages: [{ role: "user", content: "Goodbye" }],
      });
      expect(hashA).not.toBe(hashB);
    });
  });

  describe("edge cases", () => {
    // Skip: tools excluded from P1 hash per AI_SETUP_SPEC.md - will be added soon
    it.skip("handles empty tools array (excluded from hash)", () => {
      const withoutTools = computePromptHash(basePayload);
      // @ts-expect-error tools not yet in PromptHashInput
      const withEmptyTools = computePromptHash({ ...basePayload, tools: [] });
      expect(withoutTools).toBe(withEmptyTools);
    });
  });
});
