// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/components/ChatThreadsSidebarGroup`
 * Purpose: Collapsible "Threads" menu item in the global sidebar with thread sub-items.
 * Scope: Fetches thread list via useThreads, renders as collapsible SidebarMenuItem. Does not manage chat runtime state.
 * Invariants: Uses ThreadSummary from ai.threads.v1 contract; navigates to /chat on thread click when off-page.
 * Side-effects: IO (thread list fetch via React Query)
 * Links: src/features/ai/chat/components/ChatSidebarContext.tsx, src/contracts/ai.threads.v1.contract.ts
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import { ChevronDown, MessageSquare, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactElement, useState } from "react";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components";
import { useDeleteThread, useThreads } from "../hooks/useThreads";
import { useChatSidebarStore } from "./ChatSidebarContext";

export function ChatThreadsSidebarGroup(): ReactElement {
  const pathname = usePathname();
  const isChat = pathname.startsWith("/chat");
  const [open, setOpen] = useState(isChat);

  // Fetch threads directly — always available regardless of chat page mount
  const threadsQuery = useThreads();
  const threads = threadsQuery.data?.threads ?? [];

  // Read callbacks from Zustand store (only non-null when chat page is mounted)
  const chatStore = useChatSidebarStore();
  const deleteThread = useDeleteThread();

  const handleDeleteThread = (key: string) => {
    if (chatStore.onDeleteThread) {
      chatStore.onDeleteThread(key);
    } else {
      deleteThread.mutate(key);
    }
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip="Threads"
        isActive={isChat && !open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <MessageSquare />
        <span>Threads</span>
        <ChevronDown
          className={cn(
            "ml-auto size-4 transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </SidebarMenuButton>

      <SidebarMenuAction
        onClick={() => {
          if (chatStore.onNewThread) {
            chatStore.onNewThread();
          }
        }}
        asChild
      >
        <Link href="/chat" aria-label="New thread">
          <Plus />
        </Link>
      </SidebarMenuAction>

      {open && (
        <SidebarMenuSub>
          {threads.map((thread) => {
            const isActive = chatStore.activeThreadKey === thread.stateKey;
            const title = thread.title ?? "Untitled";

            return (
              <SidebarMenuSubItem
                key={thread.stateKey}
                className="group/thread"
              >
                <SidebarMenuSubButton
                  size="sm"
                  isActive={isActive}
                  asChild={!isChat || !chatStore.onSelectThread}
                  onClick={
                    isChat && chatStore.onSelectThread
                      ? () => chatStore.onSelectThread?.(thread.stateKey)
                      : undefined
                  }
                >
                  {isChat && chatStore.onSelectThread ? (
                    <span className="truncate">{title}</span>
                  ) : (
                    <Link href={`/chat?thread=${thread.stateKey}`}>
                      <span className="truncate">{title}</span>
                    </Link>
                  )}
                </SidebarMenuSubButton>
                <button
                  type="button"
                  onClick={() => handleDeleteThread(thread.stateKey)}
                  aria-label="Delete thread"
                  className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/thread:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </SidebarMenuSubItem>
            );
          })}
          {threads.length === 0 && (
            <div className="px-3 py-2 text-center text-muted-foreground text-xs">
              No conversations yet
            </div>
          )}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}
