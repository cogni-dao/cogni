// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/secrets-redaction.test`
 * Purpose: Unit tests for secrets redaction before thread persistence.
 * Scope: Tests credential redaction in UIMessage text and tool parts. Does not test persistence.
 * Invariants: Pure function tests, no mutation of input
 * Side-effects: none
 * Links: src/features/ai/services/secrets-redaction.ts
 * @internal
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { redactSecretsInMessages } from "@/features/ai/public.server";

function makeMessage(
  role: "user" | "assistant",
  parts: UIMessage["parts"]
): UIMessage {
  return { id: "msg-1", role, parts };
}

describe("redactSecretsInMessages", () => {
  it("masks API keys in text parts", () => {
    const msgs: UIMessage[] = [
      makeMessage("user", [
        { type: "text", text: "My key is sk-abc123456789012345678901" },
      ]),
    ];
    const masked = redactSecretsInMessages(msgs);
    expect(masked[0]?.parts[0]).toEqual({
      type: "text",
      text: "My key is [REDACTED_API_KEY]",
    });
  });

  it("masks AWS access keys", () => {
    const msgs: UIMessage[] = [
      makeMessage("user", [
        { type: "text", text: "AWS key: AKIAIOSFODNN7EXAMPLE" },
      ]),
    ];
    const masked = redactSecretsInMessages(msgs);
    const part = masked[0]?.parts[0];
    expect(part && "text" in part && part.text).toContain("[REDACTED_AWS_KEY]");
  });

  it("masks Bearer tokens", () => {
    const msgs: UIMessage[] = [
      makeMessage("user", [
        {
          type: "text",
          text: "Auth: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
        },
      ]),
    ];
    const masked = redactSecretsInMessages(msgs);
    const part = masked[0]?.parts[0];
    expect(part && "text" in part && part.text).toContain(
      "Bearer [REDACTED_TOKEN]"
    );
  });

  it("masks GitHub tokens", () => {
    const msgs: UIMessage[] = [
      makeMessage("user", [
        {
          type: "text",
          text: "Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        },
      ]),
    ];
    const masked = redactSecretsInMessages(msgs);
    const part = masked[0]?.parts[0];
    expect(part && "text" in part && part.text).toContain(
      "[REDACTED_GH_TOKEN]"
    );
  });

  it("does not mutate input", () => {
    const original = "sk-abc123456789012345678901";
    const msgs: UIMessage[] = [
      makeMessage("user", [{ type: "text", text: original }]),
    ];
    redactSecretsInMessages(msgs);
    const part = msgs[0]?.parts[0];
    expect(part && "text" in part && part.text).toBe(original);
  });

  it("preserves non-secret text", () => {
    const msgs: UIMessage[] = [
      makeMessage("user", [{ type: "text", text: "Hello, how are you?" }]),
    ];
    const masked = redactSecretsInMessages(msgs);
    const part = masked[0]?.parts[0];
    expect(part && "text" in part && part.text).toBe("Hello, how are you?");
  });

  it("masks secrets in tool outputs", () => {
    const msgs: UIMessage[] = [
      makeMessage("assistant", [
        {
          type: "dynamic-tool",
          toolCallId: "tc-1",
          toolName: "test",
          state: "output-available",
          input: { query: "test" },
          output: { result: "key is sk-secret12345678901234567890" },
        } as UIMessage["parts"][number],
      ]),
    ];
    const masked = redactSecretsInMessages(msgs);
    const part = masked[0]?.parts[0];
    expect(part && "output" in part && JSON.stringify(part.output)).toContain(
      "[REDACTED_API_KEY]"
    );
  });
});
