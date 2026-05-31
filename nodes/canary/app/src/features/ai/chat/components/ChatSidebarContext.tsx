// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/components/ChatSidebarContext`
 * Purpose: Zustand store bridging chat thread state to the global AppSidebar.
 * Scope: Provides register/unregister for chat page to push thread state. Does not render UI or fetch data.
 * Invariants: Uses ThreadSummary from ai.threads.v1 contract; callbacks nullable when unregistered.
 * Side-effects: none
 * Links: src/features/ai/chat/components/ChatThreadsSidebarGroup.tsx, src/contracts/ai.threads.v1.contract.ts
 * @public
 */

"use client";

import type { ThreadSummary } from "@cogni/node-contracts";
import { create } from "zustand";

interface ChatSidebarState {
  threads: ThreadSummary[];
  activeThreadKey: string | null;
  onSelectThread: ((key: string) => void) | null;
  onNewThread: (() => void) | null;
  onDeleteThread: ((key: string) => void) | null;
}

interface ChatSidebarStore extends ChatSidebarState {
  register: (state: ChatSidebarState) => void;
  unregister: () => void;
}

export const useChatSidebarStore = create<ChatSidebarStore>((set) => ({
  threads: [],
  activeThreadKey: null,
  onSelectThread: null,
  onNewThread: null,
  onDeleteThread: null,
  register: (state) => set(state),
  unregister: () =>
    set({
      threads: [],
      activeThreadKey: null,
      onSelectThread: null,
      onNewThread: null,
      onDeleteThread: null,
    }),
}));
