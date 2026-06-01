// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/chat/page`
 * Purpose: Server entrypoint for the chat page.
 * Scope: Server component only; delegates all client-side behavior to ChatView. Suspense boundary required for useSearchParams().
 * Invariants: Auth enforced by (app) layout guard.
 * Side-effects: none (server render only)
 * Links: src/app/(app)/chat/view.tsx
 * @public
 */

import type { ReactElement } from "react";
import { Suspense } from "react";

import { ChatView } from "./view";

export default function ChatPage(): ReactElement {
  return (
    <Suspense>
      <ChatView />
    </Suspense>
  );
}
