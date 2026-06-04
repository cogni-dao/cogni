// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/review/pr-context`
 * Purpose: Internal GitHub-plane route that builds the full PR review context —
 *   PR reads + repo-spec + rules + owning-domain resolution — via the operator's
 *   GitHub App auth. Called by the scheduler-worker; worker holds no credential
 *   (bug.5000).
 * Scope: Thin — parse contract, delegate to the review adapter, return.
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Bearer SCHEDULER_API_TOKEN.
 *   - Returns the resolved owningNode; the worker activity emits the
 *     `review.routed` structured log for the deploy_verified loop.
 * Side-effects: IO (GitHub REST via adapter).
 * Links: review.pr-context.internal.v1 contract, docs/spec/node-ci-cd-contract.md
 * @internal
 */

import { InternalReviewPrContextInputSchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { resolveReviewRoute } from "@/bootstrap/review/resolve-review-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "review.pr-context.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const resolved = resolveReviewRoute(request, ctx.log);
    if (!resolved.ok) return resolved.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = InternalReviewPrContextInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const context = await resolved.adapter.fetchPrContext(parsed.data);
    return NextResponse.json(context, { status: 200 });
  }
);
