// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/schedules/detail/page`
 * Purpose: Render the authenticated schedule detail page.
 * Scope: Checks session and delegates presentation; does not read run transcripts.
 * Invariants: Requires authenticated session; schedule ownership enforced by the API.
 * Side-effects: IO
 * Links: https://cognidao.org/work/items/task.5356
 * @internal
 */
import { redirect } from "next/navigation";
import { getServerSessionUser } from "@/lib/auth/server";
import { ScheduleHistoryView } from "./view";

export default async function ScheduleHistoryPage({
  params,
}: {
  params: Promise<{ scheduleId: string }>;
}) {
  if (!(await getServerSessionUser())) redirect("/");
  return <ScheduleHistoryView scheduleId={(await params).scheduleId} />;
}
