// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/chat/loading`
 * Purpose: Per-route Suspense fallback for `/chat`. Overrides the default
 *   `(app)/loading.tsx` because `/chat` has its own layout (`chat-viewport
 *   flex overflow-hidden`) that is NOT a `PageContainer` — the default
 *   centered skeleton would render inside the wrong shell.
 * Scope: Server component, layout-preserving inside `chat/layout.tsx`.
 * Invariants: Matches the chat-viewport flex shell — full-height,
 *   overflow-hidden, single-column messages stream + composer pinned to
 *   bottom. The thread-list lives in the global `AppSidebar`
 *   (`ChatThreadsSidebarGroup`) — NOT in a chat-route rail. Do not add a
 *   second column here; that creates a phantom split the real page never
 *   shows.
 * Side-effects: none
 * Links: ./layout.tsx, ./view.tsx,
 *   src/features/ai/chat/components/ChatThreadsSidebarGroup.tsx
 * @public
 */

import { Skeleton } from "@/components";

export default function ChatLoading() {
  return (
    <div className="flex h-full w-full flex-col">
      {/* Messages — alternating left (assistant) and right (user) bubbles. */}
      <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4">
        <Skeleton className="ml-auto h-12 w-2/3 max-w-xl rounded-lg" />
        <Skeleton className="h-20 w-full max-w-3xl rounded-lg" />
        <Skeleton className="ml-auto h-12 w-1/2 max-w-xl rounded-lg" />
        <Skeleton className="h-24 w-full max-w-3xl rounded-lg" />
      </div>

      {/* Composer — pinned to bottom, full-width inside main column. */}
      <div className="border-t p-3">
        <Skeleton className="h-14 w-full rounded-lg" />
      </div>
    </div>
  );
}
