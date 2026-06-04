// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/page`
 * Purpose: Work dashboard page shell — auth check and client view render.
 * Scope: Auth check only. Data fetching handled client-side via React Query.
 * Invariants: Protected route (server-side auth check).
 * Side-effects: none
 * Links: [WorkDashboardView](./view.tsx)
 * @public
 */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { WorkDashboardView } from "./view";

export default async function WorkPage() {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  return <WorkDashboardView />;
}
