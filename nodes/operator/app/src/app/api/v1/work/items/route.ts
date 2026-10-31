// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/route`
 * Purpose: HTTP endpoints for listing and creating work items.
 * Scope: Auth-protected GET (list from one configured backend) and POST (create — Doltgres only).
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, AUTH_VIA_GETSESSIONUSER, ID_RANGE_RESERVED, CODED_WRITE_ERRORS.
 * Side-effects: IO (HTTP response, filesystem read via port, Doltgres read/write)
 * Links: contracts/work.items.{list,create}.v1.contract, work/items/task.0423.doltgres-work-items-source-of-truth.md
 * @public
 */

import {
  workItemsCreateOperation,
  workItemsListOperation,
} from "@cogni/node-contracts";
import { normalizeWorkItemOrder, type WorkItemOrder } from "@cogni/work-items";
import { NextResponse } from "next/server";

import {
  createWorkItem,
  InvalidCursorError,
  listWorkItems,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  EVENT_NAMES,
  logEvent,
  WORK_ITEMS_LIST_ERROR_CODES,
} from "@/shared/observability";

import { workItemsWriteErrorResponse } from "./_errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/items — List work items with optional query filters.
 *
 * Query params: types, statuses (comma-separated), text, projectId, node (single
 * or comma-separated), limit, cursor, sortBy and sortDirection. Ordering and
 * pagination belong to the shared store; configured Doltgres is authoritative.
 */
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "work.items.list", auth: { mode: "required", getSessionUser } },
  async (ctx, request) => {
    const startedAt = performance.now();
    let status = 500;
    let count = 0;
    let hasMore = false;
    let order: WorkItemOrder | undefined;
    let errorCode:
      | (typeof WORK_ITEMS_LIST_ERROR_CODES)[keyof typeof WORK_ITEMS_LIST_ERROR_CODES]
      | undefined = WORK_ITEMS_LIST_ERROR_CODES.INTERNAL_ERROR;
    try {
      const url = new URL(request.url);

      const typesParam = url.searchParams.get("types");
      const statusesParam = url.searchParams.get("statuses");
      const textParam = url.searchParams.get("text");
      const actorParam = url.searchParams.get("actor");
      const projectIdParam = url.searchParams.get("projectId");
      const nodeParam = url.searchParams.get("node");
      const limitParam = url.searchParams.get("limit");
      const cursorParam = url.searchParams.get("cursor");

      const parsed = workItemsListOperation.input.safeParse({
        sortBy: url.searchParams.get("sortBy") ?? undefined,
        sortDirection: url.searchParams.get("sortDirection") ?? undefined,
        types: typesParam ? typesParam.split(",") : undefined,
        statuses: statusesParam ? statusesParam.split(",") : undefined,
        text: textParam ?? undefined,
        actor: actorParam ?? undefined,
        projectId: projectIdParam ?? undefined,
        node: nodeParam
          ? nodeParam.includes(",")
            ? nodeParam.split(",")
            : nodeParam
          : undefined,
        limit: limitParam ? Number(limitParam) : undefined,
        cursor: cursorParam ?? undefined,
        labels: url.searchParams.get("labels")?.split(","),
        labelPrefix: url.searchParams.get("labelPrefix") ?? undefined,
        scored: url.searchParams.has("scored")
          ? url.searchParams.get("scored") === "true"
            ? true
            : url.searchParams.get("scored") === "false"
              ? false
              : url.searchParams.get("scored")
          : undefined,
      });

      if (!parsed.success) {
        status = 400;
        errorCode = WORK_ITEMS_LIST_ERROR_CODES.INVALID_INPUT;
        return NextResponse.json(
          { error: "invalid input", issues: parsed.error.issues },
          { status }
        );
      }
      const input = parsed.data;
      order = normalizeWorkItemOrder({
        ...(input.sortBy !== undefined && { sortBy: input.sortBy }),
        ...(input.sortDirection !== undefined && {
          sortDirection: input.sortDirection,
        }),
      });
      let result: Awaited<ReturnType<typeof listWorkItems>>;
      try {
        result = await listWorkItems(input);
      } catch (e) {
        if (e instanceof InvalidCursorError) {
          status = 400;
          errorCode = WORK_ITEMS_LIST_ERROR_CODES.INVALID_CURSOR;
          return NextResponse.json(
            {
              error: "invalid cursor",
              code: "invalid_cursor",
              message: "Restart pagination using the selected sort order.",
            },
            { status: 400 }
          );
        }
        if (e instanceof WorkItemsBackendNotReadyError) {
          status = 503;
          errorCode = WORK_ITEMS_LIST_ERROR_CODES.BACKEND_UNAVAILABLE;
          return NextResponse.json(
            { error: "Work items backend unavailable" },
            { status }
          );
        }
        throw e;
      }

      const response = NextResponse.json(
        workItemsListOperation.output.parse(result)
      );
      status = 200;
      errorCode = undefined;
      count = result.items.length;
      hasMore = result.pageInfo?.hasMore ?? false;
      return response;
    } catch {
      status = 500;
      errorCode = WORK_ITEMS_LIST_ERROR_CODES.INTERNAL_ERROR;
      // Keep one safe terminal event instead of duplicating wrapper errors.
      return NextResponse.json({ error: "Internal server error" }, { status });
    } finally {
      logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_LIST_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        durationMs: performance.now() - startedAt,
        outcome: errorCode ? "error" : "success",
        count,
        hasMore,
        ...order,
        ...(errorCode && { errorCode }),
      });
    }
  }
);

/**
 * POST /api/v1/work/items — Create a new work item in Doltgres.
 *
 * Server allocates an ID in the reserved 5000+ range per type
 * (ID_RANGE_RESERVED). Author is derived from `getSessionUser` and embedded in
 * the dolt_log commit message (AUTHOR_ATTRIBUTED).
 */
export const POST = wrapRouteHandlerWithLogging(
  { routeId: "work.items.create", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const parseResult = workItemsCreateOperation.input.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parseResult.error.issues },
        { status: 400 }
      );
    }

    try {
      const created = await createWorkItem(parseResult.data, {
        id: sessionUser.id,
        displayName: sessionUser.displayName,
      });
      ctx.log.info(
        { workItemId: created.id, node: created.node },
        "work.items.create_success"
      );
      return NextResponse.json(workItemsCreateOperation.output.parse(created), {
        status: 201,
      });
    } catch (e) {
      // Coded responses: 400 work_item_scores_invalid (story.5111), 403
      // authz_denied (permanent), 503 work_items_busy (retryable), 503
      // not-ready, 409 exists. Anything unrecognized rethrows
      // to the wrapper's 500 — the catch is NOT broadened (bug.5408).
      const coded = workItemsWriteErrorResponse(ctx, e);
      if (coded) return coded;
      throw e;
    }
  }
);
