// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/chat-page-zero-credits.spec`
 * Purpose: Validates that chat page does NOT show paid model when user has zero credits.
 * Scope: Unit tests for chat page credit-based model selection. Does not test payment/auth flows.
 * Invariants: INV-UI-NO-PAID-DEFAULT-WHEN-ZERO - UI must not display paid model when credits are 0 or loading.
 * Side-effects: none (mocked dependencies)
 * Links: src/app/(app)/chat/page.tsx, tests/_fixtures/ai/fixtures.ts, src/core/chat/rules.ts
 * @vitest-environment jsdom
 * @internal
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { SessionProvider } from "next-auth/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  createModelsPaidOnly,
  createModelsWithFree,
} from "@tests/_fixtures/ai/fixtures";
import { ChatView as ChatPage } from "@/app/(app)/chat/view";

// Mock components and localStorage utilities (use real hooks with seeded QueryClient)
vi.mock("@/features/ai/public", async () => {
  const actual = await vi.importActual("@/features/ai/public");
  return {
    ...actual,
    getPreferredModelId: vi.fn(() => null),
    setPreferredModelId: vi.fn(),
    ChatComposerExtras: (props: {
      selectedModel: string;
      defaultModelId: string;
    }) => (
      <div data-testid="composer-extras">
        <div data-testid="selected-model">{props.selectedModel}</div>
        <div data-testid="default-model">{props.defaultModelId}</div>
      </div>
    ),
  };
});

vi.mock("@/features/ai/chat/providers/ChatRuntimeProvider.client", () => ({
  ChatRuntimeProvider: (props: {
    children: React.ReactNode;
    modelRef: { providerKey: string; modelId: string; connectionId?: string };
    defaultModelId: string;
    disabled: boolean;
  }) => (
    <div data-testid="runtime-provider">
      <div data-testid="provider-selected-model">{props.modelRef.modelId}</div>
      <div data-testid="provider-default-model">{props.defaultModelId}</div>
      <div data-testid="provider-disabled">{String(props.disabled)}</div>
      {props.children}
    </div>
  ),
}));

vi.mock("@/components", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
  Sheet: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
  SheetContent: (props: { children: React.ReactNode }) => (
    <div>{props.children}</div>
  ),
  SheetTitle: (props: { children: React.ReactNode }) => (
    <div>{props.children}</div>
  ),
  Thread: (props: { composerLeft: React.ReactNode }) => (
    <div data-testid="thread">{props.composerLeft}</div>
  ),
  ErrorAlert: (props: { code: string; message: string }) => (
    <div data-testid="error-alert">
      <div data-testid="error-code">{props.code}</div>
      <div data-testid="error-message">{props.message}</div>
    </div>
  ),
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: React.ReactNode }) => (
    <>{props.children}</>
  ),
  TooltipContent: (props: { children: React.ReactNode }) => (
    <span>{props.children}</span>
  ),
}));

vi.mock("next-auth/react", () => ({
  SessionProvider: (props: { children: React.ReactNode }) => props.children,
  signOut: vi.fn(),
}));

// Mock payments feature boundary - controls useCreditsSummary behavior per test
const mockUseCreditsSummary = vi.fn();
vi.mock("@/features/payments/public", () => ({
  useCreditsSummary: () => mockUseCreditsSummary(),
}));

describe("ChatPage - Zero Credits Invariant", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it("MUST NOT show paid model label during loading phase", async () => {
    // Simulate loading state
    mockUseCreditsSummary.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    const { container } = render(
      <SessionProvider session={null}>
        <QueryClientProvider client={queryClient}>
          <ChatPage />
        </QueryClientProvider>
      </SessionProvider>
    );

    // Should show loading state, NOT render chat with any model
    expect(screen.queryByTestId("runtime-provider")).toBeNull();
    expect(screen.queryByTestId("composer-extras")).toBeNull();

    // Verify no paid model names appear anywhere in DOM
    expect(container.textContent).not.toContain("GPT-5 Nano");
    expect(container.textContent).not.toContain("gpt-5-nano");
  });

  it("MUST NOT pass paid defaultModelId when user has zero credits", async () => {
    // Mock zero credits state
    mockUseCreditsSummary.mockReturnValue({
      data: { balanceCredits: 0, ledger: [] },
      isLoading: false,
    });

    const modelsData = createModelsWithFree();
    queryClient.setQueryData(["ai-models"], modelsData);

    render(
      <SessionProvider session={null}>
        <QueryClientProvider client={queryClient}>
          <ChatPage />
        </QueryClientProvider>
      </SessionProvider>
    );

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-provider")).toBeInTheDocument();
    });

    // CRITICAL: defaultModelId prop passed to components MUST NOT be the paid model
    const defaultModelElement = screen.queryByTestId("provider-default-model");
    expect(defaultModelElement?.textContent).toBe("free-model-123");
    expect(defaultModelElement?.textContent).not.toBe("paid-model-456");

    const composerDefaultElement = screen.queryByTestId("default-model");
    expect(composerDefaultElement?.textContent).toBe("free-model-123");
    expect(composerDefaultElement?.textContent).not.toBe("paid-model-456");

    // Verify free model is selected
    const selectedModelElement = screen.getByTestId("provider-selected-model");
    expect(selectedModelElement.textContent).toBe("free-model-123");
  });

  it("MUST block interaction when zero credits and no free models", async () => {
    // Mock zero credits state
    mockUseCreditsSummary.mockReturnValue({
      data: { balanceCredits: 0, ledger: [] },
      isLoading: false,
    });

    const modelsData = createModelsPaidOnly();
    queryClient.setQueryData(["ai-models"], modelsData);

    render(
      <SessionProvider session={null}>
        <QueryClientProvider client={queryClient}>
          <ChatPage />
        </QueryClientProvider>
      </SessionProvider>
    );

    await waitFor(() => {
      expect(screen.queryByTestId("error-alert")).toBeInTheDocument();
    });

    // Should NOT render chat provider at all in blocked state
    expect(screen.queryByTestId("runtime-provider")).toBeNull();

    // Should show error
    expect(screen.getByTestId("error-code").textContent).toBe("NO_FREE_MODELS");
  });
});
