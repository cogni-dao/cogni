// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/external/ai/openai-compatible-llm.adapter.external.test`
 * Purpose: External integration test for OpenAiCompatibleLlmAdapter against a local OpenAI-compatible endpoint (Ollama).
 * Scope: Validates LlmService contract (completion + streaming). Opt-in via `pnpm test:external`; skipped when Ollama is unreachable or its first model cannot serve a completion.
 * Invariants: Requires Ollama at `$OLLAMA_URL` (default localhost:11434) with a working pulled model. Not part of default CI.
 * Side-effects: IO (HTTP to local Ollama)
 * Links: src/adapters/server/ai/openai-compatible/openai-compatible-llm.adapter.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import { OpenAiCompatibleLlmAdapter } from "@/adapters/server/ai/openai-compatible/openai-compatible-llm.adapter";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

// Skip unless Ollama is up, has a pulled model, AND that model can actually
// serve a completion. Previous probe (`fetch(/)`) unskipped on any HTTP
// response, so a crashing model let these tests run and redden the default
// lane. Probing an end-to-end tiny completion is the only reliable signal.
async function probeOllama(): Promise<boolean> {
  try {
    const modelsRes = await fetch(`${OLLAMA_URL}/v1/models`);
    if (!modelsRes.ok) return false;
    const models = (await modelsRes.json().catch(() => null)) as {
      data?: Array<{ id?: string }>;
    } | null;
    const firstModel = models?.data?.[0]?.id;
    if (!firstModel) return false;
    const completionRes = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: firstModel,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
    });
    return completionRes.ok;
  } catch {
    return false;
  }
}

const ollamaAvailable = await probeOllama();

const caller = {
  billingAccountId: "test-ba",
  virtualKeyId: "test-vk",
  requestId: "test-req",
  traceId: "test-trace",
};

describe.skipIf(!ollamaAvailable)(
  "OpenAiCompatibleLlmAdapter (local Ollama)",
  () => {
    let modelId: string;

    // Discover first available model
    it("discovers models via /v1/models", async () => {
      const res = await fetch(`${OLLAMA_URL}/v1/models`);
      expect(res.ok).toBe(true);
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const models = data.data;
      if (!models || models.length === 0) {
        throw new Error("expected at least one model from /v1/models");
      }
      const firstModel = models[0];
      if (!firstModel) {
        throw new Error("expected first model to be defined");
      }
      modelId = firstModel.id;
    });

    it("completion() returns valid LlmCompletionResult", async () => {
      const adapter = new OpenAiCompatibleLlmAdapter({ baseUrl: OLLAMA_URL });
      const result = await adapter.completion({
        messages: [{ role: "user", content: "Say hello." }],
        model: modelId,
        caller,
      });

      expect(result.message.role).toBe("assistant");
      expect(result.message.content.length).toBeGreaterThan(0);
      expect(result.usage.promptTokens).toBeGreaterThan(0);
      expect(result.resolvedProvider).toBe("openai-compatible");
      expect(result.resolvedModel).toBeTruthy();
    }, 60_000);

    it("completionStream() yields text_delta events and resolves final", async () => {
      const adapter = new OpenAiCompatibleLlmAdapter({ baseUrl: OLLAMA_URL });
      const { stream, final } = await adapter.completionStream({
        messages: [{ role: "user", content: "Count 1 2 3." }],
        model: modelId,
        caller,
      });

      let chunks = 0;
      let text = "";
      for await (const event of stream) {
        if (event.type === "text_delta") {
          text += event.delta;
          chunks++;
        }
      }

      expect(chunks).toBeGreaterThan(0);
      expect(text.length).toBeGreaterThan(0);

      const finalResult = await final;
      expect(finalResult.message.role).toBe("assistant");
      expect(finalResult.message.content).toBe(text);
      // Usage may be 0 if server doesn't support stream_options.include_usage
      expect(finalResult.usage).toBeDefined();
      expect(finalResult.finishReason).toBeTruthy();
    }, 60_000);
  }
);
