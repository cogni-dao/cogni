// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/loading`
 * Purpose: Default Suspense fallback for every route under the protected
 *   `(app)` route group. Rendered inside the sidebar shell while the RSC
 *   payload streams in, so the user sees a skeleton instantly on nav
 *   instead of a frozen UI for the whole server round-trip.
 * Scope: Server component, layout-preserving. Does not fetch data.
 * Invariants: Renders inside `(app)/layout.tsx` — sidebar + top bar stay
 *   visible across nav.
 * Side-effects: none
 * Links: ./layout.tsx, src/components/kit/layout/PageSkeleton.tsx,
 *   https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming
 * @public
 */

import { PageSkeleton } from "@/components/kit/layout/PageSkeleton";

export default function AppLoading() {
  return <PageSkeleton maxWidth="2xl" />;
}
