// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/runs/[runId]/stream`
 * Purpose: SSE reconnection endpoint for graph run event streams.
 * Scope: Session-authenticated GET endpoint that subscribes to a Redis Stream for a given runId
 *   and pipes events to the client as SSE. Supports Last-Event-ID header for cursor-based replay.
 * Invariants:
 *   - SSE_FROM_REDIS_NOT_MEMORY: reads from Redis Streams, not in-process memory
 *   - REDIS_IS_STREAM_PLANE: Redis holds only ephemeral stream data; loss = stream interruption
 *   - Auth: session-required, verifies requestedBy matches authenticated user
 * Side-effects: IO (Redis stream subscription, HTTP SSE response)
 * Links: docs/spec/unified-graph-launch.md §4 (Reconnection), RunStreamPort, GraphRunRepository
 * @public
 */

import { toUserId, userActor } from "@cogni/ids";
import { RunStreamParamsSchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Terminal run statuses — stream is complete, may or may not still be in Redis. */
const TERMINAL_STATUSES = new Set(["success", "error", "skipped", "cancelled"]);

/** AiEvent types that are internal-only and should not be forwarded to clients. */
const INTERNAL_EVENT_TYPES = new Set(["usage_report", "assistant_final"]);

interface RouteParams {
  params: Promise<{ runId: string }>;
}

/**
 * GET /api/v1/ai/runs/{runId}/stream
 *
 * SSE endpoint for reconnecting to a graph run's event stream.
 * Accepts Last-Event-ID header for cursor-based replay from a Redis Stream position.
 *
 * HTTP responses:
 * - 200: SSE stream (text/event-stream)
 * - 400: Invalid runId format
 * - 403: Run does not belong to the authenticated user
 * - 404: Run not found
 * - 410: Stream expired (Redis TTL elapsed)
 */
export const GET = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "ai.runs.stream", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, routeParams) => {
    const log = ctx.log;

    // --- 1. Parse and validate runId ---
    if (!routeParams) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const rawParams = await routeParams.params;
    const parseResult = RunStreamParamsSchema.safeParse(rawParams);
    if (!parseResult.success) {
      return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
    }
    const { runId } = parseResult.data;

    // --- 2. Look up run and verify ownership ---
    const container = getContainer();
    const actorId = userActor(toUserId(sessionUser.id));
    const run = await container.graphRunRepository.getRunByRunId(
      actorId,
      runId
    );

    if (!run) {
      log.warn({ runId }, "Run not found for stream reconnection");
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    if (run.requestedBy !== sessionUser.id) {
      log.warn(
        { runId, requestedBy: run.requestedBy, sessionUserId: sessionUser.id },
        "Stream access denied — user does not own this run"
      );
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // --- 3. Check for expired stream ---
    // If the run is terminal and the Redis stream has been cleaned up, return 410.
    if (TERMINAL_STATUSES.has(run.status)) {
      const length = await container.runStream.streamLength(runId);
      if (length === 0) {
        log.info(
          { runId, status: run.status },
          "Stream expired — returning 410"
        );
        return NextResponse.json({ error: "Stream expired" }, { status: 410 });
      }
    }

    // --- 4. Parse Last-Event-ID for cursor-based replay ---
    const lastEventId = request.headers.get("last-event-id") ?? undefined;

    log.info(
      { runId, lastEventId, runStatus: run.status },
      "Starting stream reconnection"
    );

    // --- 5. Subscribe to Redis stream and pipe as SSE ---
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        function safeClose() {
          if (!closed) {
            closed = true;
            controller.close();
          }
        }

        try {
          const subscription = container.runStream.subscribe(
            runId,
            request.signal,
            lastEventId
          );

          for await (const entry of subscription) {
            if (request.signal.aborted) break;

            // Filter internal events
            if (INTERNAL_EVENT_TYPES.has(entry.event.type)) continue;

            // Format as SSE: id + event type + JSON data
            const sseMessage =
              `id: ${entry.id}\n` +
              `event: ${entry.event.type}\n` +
              `data: ${JSON.stringify(entry.event)}\n\n`;

            controller.enqueue(encoder.encode(sseMessage));
          }

          safeClose();
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            log.info({ runId }, "Stream client disconnected");
          } else {
            log.error({ runId, err: error }, "Stream subscription error");
          }
          safeClose();
        }
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
);
