// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/chat-page-no-hardcoded-models.spec`
 * Purpose: Validates that chat page never invents model IDs not provided by server API.
 * Scope: Unit tests for chat page model selection with zero credits. Does not test network/auth layers.
 * Invariants: INV-NO-CLIENT-INVENTED-MODEL-IDS - Client must only use model IDs from API response.
 * Side-effects: none (mocked dependencies)
 * Links: src/app/(app)/chat/page.tsx, tests/_fixtures/ai/fixtures.ts
 * @vitest-environment jsdom
 * @internal
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { SessionProvider } from "next-auth/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  createModelsClaudeOnly,
  createModelsWithFree,
} from "@tests/_fixtures/ai/fixtures";
import { ChatView as ChatPage } from "@/app/(app)/chat/view";

// Mock components only (use real hooks with seeded QueryClient)
vi.mock("@/features/ai/public", async () => {
  const actual = await vi.importActual("@/features/ai/public");
  return {
    ...actual,
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
  }) => (
    <div data-testid="runtime-provider">
      <div data-testid="provider-selected-model">{props.modelRef.modelId}</div>
      <div data-testid="provider-default-model">{props.defaultModelId}</div>
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

describe("ChatPage - No Client-Invented Model IDs", () => {
  let queryClient: QueryClient;

  beforeEach(async () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it("MUST NOT render any model ID that is not in server's models list", async () => {
    // Mock positive credits state
    mockUseCreditsSummary.mockReturnValue({
      data: { balanceCredits: 100, ledger: [] },
      isLoading: false,
    });

    // Server returns ONLY claude models (no gpt-4o-mini!)
    const modelsData = createModelsClaudeOnly();
    queryClient.setQueryData(["ai-models"], modelsData);

    const { container } = render(
      <SessionProvider session={null}>
        <QueryClientProvider client={queryClient}>
          <ChatPage />
        </QueryClientProvider>
      </SessionProvider>
    );

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-provider")).toBeInTheDocument();
    });

    // CRITICAL: UI must NEVER contain "gpt-4o-mini" since server didn't send it
    expect(container.textContent).not.toContain("gpt-4o-mini");

    // Verify rendered model IDs are from server's list
    const providerSelected = screen.getByTestId("provider-selected-model");
    const providerDefault = screen.getByTestId("provider-default-model");

    const validIds = ["claude-haiku-free", "claude-sonnet-paid"];
    expect(validIds).toContain(providerSelected.textContent);
    expect(validIds).toContain(providerDefault.textContent);
  });

  it("MUST use free model default when balance is zero", async () => {
    // Mock zero credits state
    mockUseCreditsSummary.mockReturnValue({
      data: { balanceCredits: 0, ledger: [] },
      isLoading: false,
    });

    // Server returns both free and paid, default is paid
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

    // CRITICAL: defaultModelId passed to components MUST be the free model
    const providerDefault = screen.getByTestId("provider-default-model");
    const composerDefault = screen.getByTestId("default-model");

    expect(providerDefault.textContent).toBe("free-model-123");
    expect(composerDefault.textContent).toBe("free-model-123");

    // Selected model should also be free
    const providerSelected = screen.getByTestId("provider-selected-model");
    expect(providerSelected.textContent).toBe("free-model-123");
  });
});
