// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/artifacts`
 * Purpose: POST records an immutable triage, review or validation artifact on a work item; GET lists them, newest first (task.0028).
 *   `GET ?view=refs&cursor=` returns one page of 20 refs and `nextCursor` (story.0058); without `view` the answer is unchanged.
 * Scope: Thin shells: session check, id, body parse, one `@cogni/work-items` handler call, one log event, response. PASS-grade and the insert live in the package.
 * Invariants:
 *   - SAME_AUTH_AS_PATCH: POST needs the same authenticated principal `PATCH /work/items/{id}` needs (session or agent bearer through `getSessionUser`); the operator runs no separate same-door grant check on work items. GET needs a session, like history.
 *   - AUTHOR_IS_STAMPED: the author is `sessionUser.id`; a body never names one.
 *   - Errors, each with an `errorCode`: 400 `invalid_input` (an invalid JSON body too), 403 grant, 404 `not_found`, 409 `work_item_write_outcome_unknown` (inspect, never replay), 503 `artifacts_unavailable` (no store wired too). Nothing is written in the 400, 404 and 503 cases. The author is stamped for audit; no check compares it with the subject's author.
 *   - One terminal log event per call (codes and counts only): `work.items.artifact_recorded` on success, `work.items.artifact_refused` on every other write outcome, `work.items.artifacts_read` for the list. A failure carries its `errorName` on that same terminal line.
 * Side-effects: IO (HTTP response, Doltgres read and write)
 * Links: @cogni-dao/work-items recordWorkItemArtifact, hub work-cicd-gates-design
 * @public
 */

import {
  artifactInvalidJson,
  artifactsNotConfigured,
  listWorkItemArtifacts,
  recordWorkItemArtifact,
} from "@cogni/work-items";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

import { respond } from "./_respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.artifacts.create",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;
    const startedAt = Date.now();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond(ctx, startedAt, artifactInvalidJson(id));
    }

    const deps = getContainer().workItemArtifacts;
    if (!deps)
      return respond(ctx, startedAt, artifactsNotConfigured(id, "write"));

    return respond(
      ctx,
      startedAt,
      await recordWorkItemArtifact(deps, id, sessionUser.id, body)
    );
  }
);

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.artifacts.list",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const startedAt = Date.now();

    const deps = getContainer().workItemArtifacts;
    if (!deps)
      return respond(ctx, startedAt, artifactsNotConfigured(id, "read"));

    const params = new URL(request.url).searchParams;
    return respond(
      ctx,
      startedAt,
      await listWorkItemArtifacts(deps, id, {
        view: params.get("view"),
        cursor: params.get("cursor"),
      })
    );
  }
);
