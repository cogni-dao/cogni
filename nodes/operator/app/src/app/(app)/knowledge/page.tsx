// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/page`
 * Purpose: Knowledge dashboard page shell — auth check + server-side data read
 *   that seeds React Query `initialData` so the first HTML paint shows the real
 *   entry count + table (never a false "0 entries"), not a cold client fetch.
 * Scope: Server component. Auth check + parallel port reads via shared loaders
 *   (house SSR idiom, see `(app)/nodes/page.tsx`); the client view owns
 *   interaction, refetch, and mutations.
 * Invariants: Protected route (server-side auth check); SSR_SEEDS_REACT_QUERY
 *   (loaders return the exact wire shape the client fetchers do, so
 *   initialData === post-hydration refetch — no hydration shift). Graph data is
 *   only pre-read on a `?mode=graph` deep-link; otherwise it stays deferred.
 * Side-effects: IO (Doltgres reads via container port)
 * Links: [KnowledgeDashboardView](./view.tsx), ./_server/loaders.ts, docs/spec/knowledge-syntropy.md
 * @public
 */

import { redirect } from "next/navigation";

import { getContainer } from "@/bootstrap/container";
import { getServerSessionUser } from "@/lib/auth/server";
import {
  loadDomains,
  loadKnowledgeGraph,
  loadKnowledgeList,
} from "./_server/loaders";
import { KnowledgeDashboardView } from "./view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A failed/unconfigured store must not 500 the page — degrade to a client
// fetch (which now shows an honest skeleton, never "0 entries").
async function safe<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  const port = getContainer().knowledgeStorePort;
  const { mode } = await searchParams;

  const [initialList, initialDomains, initialGraph] = port
    ? await Promise.all([
        // limit=500 matches the browse client fetcher (LIST_LIMIT_PARITY).
        safe(loadKnowledgeList(port, { limit: 500 })),
        safe(loadDomains(port)),
        mode === "graph"
          ? safe(loadKnowledgeGraph(port))
          : Promise.resolve(undefined),
      ])
    : [undefined, undefined, undefined];

  return (
    <KnowledgeDashboardView
      initialList={initialList}
      initialDomains={initialDomains}
      initialGraph={initialGraph}
    />
  );
}
