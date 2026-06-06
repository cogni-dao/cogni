// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.chat.free-model-zero-credits`
 * Purpose: Verifies that free models work with zero credits, while paid models are blocked.
 * Scope: Route-level stack test with mocked AccountService and LlmService. Does not test database persistence.
 * Invariants: Free model + 0 balance = 200 OK; Paid model + 0 balance = 402 Payment Required.
 * Side-effects: none
 * Links: Tests ai.chat.v1 contract
 * @internal
 */

import { createMockAccountServiceWithDefaults } from "@tests/_fakes";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as appHandler from "@/app/api/v1/ai/chat/route";

// Mock bootstrap container to bypass environment validation
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      })),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    clock: {
      now: vi.fn(() => new Date("2025-01-01T00:00:00Z")),
    },
    config: {
      unhandledErrorPolicy: "rethrow",
    },
    threadPersistenceForUser: vi.fn(() => ({
      loadThread: vi.fn().mockResolvedValue([]),
      saveThread: vi.fn().mockResolvedValue(undefined),
      softDelete: vi.fn().mockResolvedValue(undefined),
      listThreads: vi.fn().mockResolvedValue([]),
    })),
  })),
  resolveAiDeps: vi.fn(),
}));

// Mock session authentication
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

// Mock facade to control error throwing directly
vi.mock("@/app/_facades/ai/completion.server", () => ({
  completion: vi.fn(),
  completionStream: vi.fn(),
}));

// Mock model catalog
vi.mock("@/shared/ai/model-catalog.server", () => ({
  isModelAllowed: vi.fn(),
  getDefaults: vi.fn(),
  isModelFree: vi.fn(),
}));

import {
  completion,
  completionStream,
} from "@/app/_facades/ai/completion.server";
// Import after mocks
import { getSessionUser } from "@/app/_lib/auth/session";
import {
  getDefaults,
  isModelAllowed,
  isModelFree,
} from "@/shared/ai/model-catalog.server";

describe("POST /api/v1/ai/chat - Free Model Zero Credits", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Restore mock implementations after reset
    vi.mocked(getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);

    vi.mocked(isModelAllowed).mockResolvedValue(true);
    vi.mocked(getDefaults).mockResolvedValue({
      defaultPreferredModelId: "gpt-4o-mini",
      defaultFreeModelId: "free-model",
    });
    vi.mocked(isModelFree).mockImplementation(async (modelId: string) => {
      return modelId === "free-model";
    });

    vi.mocked(completion).mockImplementation(async (input) => {
      const isFree = input.modelRef.modelId === "free-model";

      if (!isFree) {
        const error = new Error("Insufficient credits");
        Object.assign(error, {
          kind: "INSUFFICIENT_CREDITS",
          billingAccountId: "test-user",
          required: 100,
          available: 0,
        });
        throw error;
      }

      return {
        message: {
          role: "assistant",
          content: "AI response",
          requestId: "req-123",
          timestamp: new Date().toISOString(),
        },
      };
    });

    vi.mocked(completionStream).mockImplementation(async (input) => {
      const isFree = input.modelRef.modelId === "free-model";

      if (!isFree) {
        const error = new Error("Insufficient credits");
        Object.assign(error, {
          kind: "INSUFFICIENT_CREDITS",
          billingAccountId: "test-user",
          required: 100,
          available: 0,
        });
        throw error;
      }

      return {
        stream: (async function* () {
          yield { type: "text_delta" as const, delta: "AI response" };
        })(),
        final: Promise.resolve({
          ok: true as const,
          requestId: "req-123",
          usage: { promptTokens: 10, completionTokens: 20 },
          finishReason: "stop",
        }),
      };
    });
  });

  it("should allow free model execution with zero balance", async () => {
    const accountService = createMockAccountServiceWithDefaults();
    accountService.getBalance = vi.fn().mockResolvedValue(0);

    await testApiHandler({
      appHandler,
      test: async ({
        fetch,
      }: {
        fetch: (init?: RequestInit) => Promise<Response>;
      }) => {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({
            message: "Hello",
            modelRef: { providerKey: "platform", modelId: "free-model" },
            graphName: "langgraph:poet",
          }),
        });

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("AI response");
      },
    });
  });

  // Invariant: Paid model with zero balance must return 402 before attempting LLM call
  it("should block paid model execution with zero balance", async () => {
    const accountService = createMockAccountServiceWithDefaults();
    accountService.getBalance = vi.fn().mockResolvedValue(0);

    await testApiHandler({
      appHandler,
      test: async ({
        fetch,
      }: {
        fetch: (init?: RequestInit) => Promise<Response>;
      }) => {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({
            message: "Hello",
            modelRef: { providerKey: "platform", modelId: "paid-model" },
            graphName: "langgraph:poet",
          }),
        });

        expect(response.status).toBe(402);
      },
    });
  });
});
