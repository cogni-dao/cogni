// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/[id]/page`
 * Purpose: Permalink page for a single knowledge entry — the URL humans click and
 *   AI emits. Auth check + client view render.
 * Scope: Auth check only. Data fetching handled client-side via React Query.
 * Invariants: Protected route (server-side auth check).
 * Side-effects: none
 * Links: [KnowledgeEntryView](../_components/KnowledgeEntryView.tsx), docs/spec/knowledge-syntropy.md
 * @public
 */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import { KnowledgeEntryView } from "../_components/KnowledgeEntryView";

export default async function KnowledgeEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  const { id } = await params;
  return <KnowledgeEntryView id={decodeURIComponent(id)} />;
}
