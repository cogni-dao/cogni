// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/layout/components/AppShell`
 * Purpose: One authenticated shell for app pages and the completed-sign-in handoff.
 * Scope: Composes sidebar, top bar and content; makes no auth or routing decisions.
 * Invariants: Both consumers reserve identical space for loading and ready content.
 * Side-effects: none
 * @public
 */

"use client";

import type { ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "@/components";

import { AppSidebar } from "./AppSidebar";
import { AppTopBar } from "./AppTopBar";

export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <AppTopBar />
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
