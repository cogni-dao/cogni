// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/inbox/[contributionId]/page`
 * Purpose: Permalink page for a single inbox contribution — the URL humans click
 *   and AI emits. Auth check + client view render.
 * Scope: Auth check only. Data fetching handled client-side via React Query.
 * Invariants: Protected route (server-side auth check).
 * Side-effects: none
 * Links: [ContributionView](../../_components/ContributionView.tsx), docs/spec/knowledge-syntropy.md
 * @public
 */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { ContributionView } from "../../_components/ContributionView";

export default async function ContributionPermalinkPage({
  params,
}: {
  params: Promise<{ contributionId: string }>;
}) {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  const { contributionId } = await params;
  return <ContributionView id={decodeURIComponent(contributionId)} />;
}
