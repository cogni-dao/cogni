// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/ai.chat.v1.contract`
 * Purpose: Validates ai.chat.v1 contract schema for P1 input format (single message string).
 * Scope: Tests Zod schema compliance for { message, modelRef, graphName, stateKey? } input. Does not test route handler or LLM adapter behavior.
 * Invariants: Schema must correctly validate/reject input structures per field constraints.
 * Side-effects: none
 * Notes: P1 wire format — client sends message string, not messages[].
 * Links: @/contracts/ai.chat.v1.contract
 * @internal
 */

import { AssistantUiInputSchema } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ai.chat.v1 contract validation", () => {
  describe("valid inputs", () => {
    it("accepts minimal valid input", () => {
      const payload = {
        message: "Hello",
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
        graphName: "langgraph:poet",
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("accepts input with stateKey", () => {
      const payload = {
        message: "What time is it?",
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
        graphName: "sandbox:openclaw",
        stateKey: "abc123_XYZ-456",
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("accepts message at max length (16000 chars)", () => {
      const payload = {
        message: "x".repeat(16_000),
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
        graphName: "chat",
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    it("rejects empty message", () => {
      const payload = {
        message: "",
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
        graphName: "chat",
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it("rejects message exceeding 16000 chars", () => {
      const payload = {
        message: "x".repeat(16_001),
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
        graphName: "chat",
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it("rejects missing message field", () => {
      const payload = {
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
        graphName: "chat",
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it("rejects missing modelRef field", () => {
      const payload = {
        message: "Hello",
        graphName: "chat",
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it("rejects missing graphName field", () => {
      const payload = {
        message: "Hello",
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it("rejects stateKey with unsafe characters", () => {
      const payload = {
        message: "Hello",
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
        graphName: "chat",
        stateKey: "key with spaces!",
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("safe characters");
      }
    });

    it("rejects stateKey exceeding 128 chars", () => {
      const payload = {
        message: "Hello",
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
        graphName: "chat",
        stateKey: "x".repeat(129),
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it("rejects old messages[] format", () => {
      const payload = {
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }] },
        ],
        modelRef: { providerKey: "platform", modelId: "gpt-4" },
        graphName: "chat",
      };

      const result = AssistantUiInputSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });
});
