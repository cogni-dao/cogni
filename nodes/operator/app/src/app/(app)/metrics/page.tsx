// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/metrics/page`
 * Purpose: Metrics route (story.0039): goals, their KPIs and the metrics that serve each KPI. Server auth gate plus one SSR seed of the goal read.
 * Scope: Auth check and one `loadGoalsProgress()` seed (2 s budget), parsed with the metrics contract. A failed, slow or unconfigured read degrades to the client fetch, never a 500. Renders no Metrics markup: the package owns the view.
 * Invariants: Protected route; the seed has the exact wire shape of `GET /api/v1/metrics/goals`.
 * Side-effects: IO (goal progress read)
 * Links: ./view.tsx, app/src/app/_facades/metrics.server.ts
 * @public
 */

import { GoalsProgressSchema } from "@cogni-dao/metrics/contracts";
import { redirect } from "next/navigation";

import { loadGoalsProgress } from "@/app/_facades/metrics.server";
import { getServerSessionUser } from "@/lib/auth/server";
import { MetricsView } from "./view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Longest the server waits for the goal read before it hands the fetch to the client. */
const SEED_BUDGET_MS = 2000;

export default async function MetricsPage() {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }
  // A slow store must not hold the first paint: past the budget the client fetches it.
  let seed: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    seed = await Promise.race([
      loadGoalsProgress(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, SEED_BUDGET_MS, undefined);
      }),
    ]);
  } catch {
    seed = undefined;
  } finally {
    clearTimeout(timer);
  }
  return <MetricsView initialData={GoalsProgressSchema.safeParse(seed).data} />;
}
