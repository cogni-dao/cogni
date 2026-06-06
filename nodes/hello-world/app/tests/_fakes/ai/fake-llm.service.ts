// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/ai/fake-llm.service`
 * Purpose: Controllable LLM service mock for testing AI completion flows.
 * Scope: Mock responses and call logging. Does NOT test real LLM integration.
 * Invariants: All calls logged; responses configurable; deterministic behavior.
 * Side-effects: none
 * Notes: Supports delay simulation and error injection for testing.
 * Links: LlmService port
 * @public
 */

import type { Message } from "@cogni/node-core";
import type { LlmCaller, LlmCompletionResult, LlmService } from "@/ports";

export interface FakeLlmOptions {
  shouldThrow?: boolean;
  errorMessage?: string;
  responseContent?: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  delay?: number;
  /** Custom promptHash to return (tests canonical hash propagation) */
  promptHash?: string;
}

export class FakeLlmService implements LlmService {
  private options: FakeLlmOptions;
  public callLog: {
    messages: Message[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    caller: LlmCaller;
  }[] = [];

  constructor(options: FakeLlmOptions = {}) {
    this.options = {
      responseContent: "Mock AI response",
      finishReason: "stop",
      ...options,
    };
  }

  async completion(params: {
    messages: Message[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    caller: LlmCaller;
  }): Promise<LlmCompletionResult> {
    // Log the call for assertions
    this.callLog.push({ ...params });

    // Simulate delay if configured
    if (this.options.delay) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delay));
    }

    // Throw error if configured
    if (this.options.shouldThrow) {
      throw new Error(this.options.errorMessage ?? "Mock LLM error");
    }

    // Return mock response with all fields per LlmCompletionResult
    const response: LlmCompletionResult = {
      message: {
        role: "assistant" as const,
        content: this.options.responseContent ?? "Default mock response",
        timestamp: new Date().toISOString(),
      },
      providerMeta: {
        model: params.model ?? "mock-model",
        provider: "fake",
        requestId: "fake-request-id",
      },
      providerCostUsd: 0.0001, // Small fixed cost for billing tests
      // New fields per AI_SETUP_SPEC.md
      litellmCallId: "fake-litellm-call-id",
      promptHash: this.options.promptHash ?? "fake-prompt-hash-sha256",
      resolvedProvider: "fake",
      resolvedModel: params.model ?? "mock-model",
    };

    if (this.options.finishReason) {
      response.finishReason = this.options.finishReason;
    }

    if (this.options.usage) {
      response.usage = this.options.usage;
    }

    return response;
  }

  async completionStream(
    params: Parameters<LlmService["completionStream"]>[0]
  ): ReturnType<LlmService["completionStream"]> {
    this.callLog.push(params);
    if (this.options.shouldThrow) {
      throw new Error(this.options.errorMessage ?? "Fake LLM error");
    }

    const content = this.options.responseContent ?? "Fake AI response";
    const usage = this.options.usage ?? {
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
    };
    const providerCostUsd = 0.0002;

    const stream = (async function* () {
      yield { type: "text_delta", delta: content } as const;
      yield { type: "done" } as const;
    })();

    return {
      stream: stream as AsyncIterable<import("@/ports").ChatDeltaEvent>,
      final: Promise.resolve({
        message: {
          role: "assistant",
          content,
        },
        usage,
        ...(this.options.finishReason
          ? { finishReason: this.options.finishReason }
          : {}),
        providerMeta: {
          model: params.model ?? "mock-model",
          provider: "fake",
          requestId: "fake-request-id",
        },
        providerCostUsd,
        // New fields per AI_SETUP_SPEC.md
        litellmCallId: "fake-litellm-call-id",
        promptHash: this.options.promptHash ?? "fake-prompt-hash-sha256",
        resolvedProvider: "fake",
        resolvedModel: params.model ?? "mock-model",
      }),
    };
  }

  // Test utilities
  reset(): void {
    this.callLog = [];
  }

  wasCalled(): boolean {
    return this.callLog.length > 0;
  }

  getLastCall(): (typeof this.callLog)[0] | undefined {
    return this.callLog[this.callLog.length - 1];
  }
}
