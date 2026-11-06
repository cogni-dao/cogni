// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/layout`
 * Purpose: Sidebar navigation shell for protected application pages.
 * Scope: Client layout component providing sidebar + top bar shell for all routes under (app). Does not handle authentication — proxy.ts guarantees only authenticated users reach this layout.
 * Invariants: Auth enforced at proxy level; this layout is a pure UI shell.
 * Side-effects: none
 * Links: docs/spec/security-auth.md, src/proxy.ts
 * @public
 */

"use client";

import type { ReactNode } from "react";

import { AppShell } from "@/features/layout";

export default function AppLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return <AppShell>{children}</AppShell>;
}
