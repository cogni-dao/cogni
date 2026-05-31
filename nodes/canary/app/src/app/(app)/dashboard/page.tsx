// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/page`
 * Purpose: Live operations dashboard page shell.
 * Scope: Auth check only. Does not fetch data or implement business logic.
 * Invariants: Protected route (server-side auth check).
 * Side-effects: IO
 * Links: [DashboardView](./view.tsx)
 * @public
 */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { DashboardView } from "./view";

export default async function DashboardPage() {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  return <DashboardView />;
}
