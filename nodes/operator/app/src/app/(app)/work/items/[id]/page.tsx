// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/items/[id]/page`
 * Purpose: Canonical human permalink for an exact work item, rendered in the route-backed dashboard detail sheet.
 * Scope: Auth check and route parameter projection only; client view owns data fetching.
 * Invariants: Protected route; URL is the selected-item source of truth; params.id is already decoded by Next.
 * Side-effects: none
 * Links: bug.5355, [WorkDashboardView](../../view.tsx)
 * @public
 */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { WorkDashboardView } from "../../view";

export default async function WorkItemPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  const { id } = await params;
  return <WorkDashboardView selectedItemId={id} />;
}
