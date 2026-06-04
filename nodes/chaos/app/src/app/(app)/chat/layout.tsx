// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/chat/layout`
 * Purpose: Chat-specific layout that creates a fixed-height viewport container.
 * Scope: Wraps chat page with height constraints to pin composer to bottom. Uses `flex` (horizontal) to support sidebar + chat area layout. Does not affect other routes.
 * Invariants: Height is exactly viewport minus top bar; overflow-hidden prevents document scroll.
 * Side-effects: none
 * Notes: Uses --app-header-h CSS variable via chat-viewport utility. Same approach as before sidebar migration.
 * Links: src/app/(app)/chat/page.tsx
 * @public
 */

import type { ReactNode } from "react";

export default function ChatLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>): ReactNode {
  return <div className="chat-viewport flex overflow-hidden">{children}</div>;
}
