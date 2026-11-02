// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/chat/loading`
 * Purpose: Per-route Suspense fallback for `/chat`. Overrides the default
 *   `(app)/loading.tsx` because `/chat` has its own layout (`chat-viewport
 *   flex overflow-hidden`) that is NOT a `PageContainer` — the default
 *   centered skeleton would render inside the wrong shell.
 * Scope: Server component, layout-preserving inside `chat/layout.tsx`.
 * Invariants: Uses the same wordless indicator as chat readiness gates.
 * Side-effects: none
 * Links: ./layout.tsx, ./view.tsx,
 *   src/features/ai/chat/components/ChatThreadsSidebarGroup.tsx
 * @public
 */

import { BrainLoading } from "@/components/kit/feedback/BrainLoading";

export default function ChatLoading() {
  return <BrainLoading />;
}
