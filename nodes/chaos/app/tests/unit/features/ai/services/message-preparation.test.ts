// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/services/message-preparation`
 * Purpose: Unit tests for message-preparation module.
 * Scope: Tests module-specific behavior (hash determinism, system prompt). Does NOT test core functions (filter, trim, validate) - those are tested in @/core.
 * Invariants: PROMPTHASH_DUAL_RESOLUTION - fallbackPromptHash available for error paths.
 * Side-effects: none
 * Notes: MVP tests only - core functions (filter, trim, validate) tested in @/core.
 * Links: message-preparation.ts, COMPLETION_REFACTOR_PLAN.md
 * @public
 */

import { createUserMessage, TEST_MODEL_ID } from "@tests/_fakes";
import { describe, expect, it } from "vitest";

import { prepareMessages } from "@/features/ai/services/message-preparation";

describe("prepareMessages", () => {
  it("returns deterministic fallbackPromptHash for identical input", () => {
    const input = [createUserMessage("hello")];

    const a = prepareMessages(input, TEST_MODEL_ID);
    const b = prepareMessages(input, TEST_MODEL_ID);

    // PROMPTHASH_DUAL_RESOLUTION: hash must be available for error path telemetry
    expect(a.fallbackPromptHash).toBe(b.fallbackPromptHash);
    expect(a.fallbackPromptHash).toHaveLength(64); // SHA-256 hex
  });

  it("prepends system prompt to output messages", () => {
    const input = [createUserMessage("hello")];

    const { messages } = prepareMessages(input, TEST_MODEL_ID);

    // System prompt is first, user message preserved
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("You are Cogni");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toBe("hello");
  });
});
