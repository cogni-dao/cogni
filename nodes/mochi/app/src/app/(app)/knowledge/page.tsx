// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/page`
 * Purpose: Knowledge dashboard page shell — auth check + client view render.
 * Scope: Auth check only. Data fetching handled client-side via React Query.
 * Invariants: Protected route (server-side auth check).
 * Side-effects: none
 * Links: [KnowledgeDashboardView](./view.tsx), docs/spec/knowledge-syntropy.md
 * @public
 */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { KnowledgeDashboardView } from "./view";

export default async function KnowledgePage() {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  return <KnowledgeDashboardView />;
}
