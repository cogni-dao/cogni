// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/schedules/page`
 * Purpose: Schedules page shell.
 * Scope: Auth check only. Does not fetch schedule data or implement business logic.
 * Invariants: Protected route (server-side auth check).
 * Side-effects: IO
 * Links: [SchedulesView](./view.tsx)
 * @public
 */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { SchedulesView } from "./view";

export default async function SchedulesPage() {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  return <SchedulesView />;
}
