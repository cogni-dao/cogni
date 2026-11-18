// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/artifacts/[artifactId]`
 * Purpose: GET one artifact of one work item in full, with its `rows`, `body` and `url` (story.0058: refs first, then one read).
 * Scope: Thin shell: session check, ids, one `@cogni/work-items` `readWorkItemArtifact` call, one log event, response.
 * Invariants:
 *   - ONE_ARTIFACT_OF_THIS_ITEM: an artifact id of another item is a 404, never that item's artifact.
 *   - One terminal log event per call: `work.items.artifacts_read` (codes and counts only).
 * Side-effects: IO (HTTP response, Doltgres read)
 * Links: @cogni-dao/work-items readWorkItemArtifact, hub work-item-artifacts
 * @public
 */

import {
  artifactsNotConfigured,
  readWorkItemArtifact,
} from "@cogni/work-items";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

import { respond } from "../_respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string; artifactId: string }>;
}>(
  {
    routeId: "work.items.artifacts.get",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!context) throw new Error("context required for dynamic routes");
    const { id, artifactId } = await context.params;
    const startedAt = Date.now();

    const deps = getContainer().workItemArtifacts;
    if (!deps)
      return respond(ctx, startedAt, artifactsNotConfigured(id, "read"));

    return respond(
      ctx,
      startedAt,
      await readWorkItemArtifact(deps, id, artifactId)
    );
  }
);
