// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/node/stream`
 * Purpose: SSE endpoint for real-time node-level event streams (health, CI, deploy, domain events).
 * Scope: Session-authenticated GET endpoint that subscribes to a Redis Stream and pipes events as SSE. Does not filter or transform events.
 * Invariants:
 *   - SSE_RESUME_SAFE: Supports Last-Event-ID header for cursor-based replay
 *   - ONE_STREAM_PER_NODE: Single stream key per node, multiplexed by event.type
 * Side-effects: IO (Redis stream subscription, HTTP SSE response)
 * Links: docs/spec/data-streams.md, @cogni/node-streams
 * @public
 */

import { encodeSSE } from "@cogni/node-streams";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/node/stream
 *
 * SSE endpoint for real-time node events.
 * Accepts Last-Event-ID header for cursor-based replay.
 *
 * HTTP responses:
 * - 200: SSE stream (text/event-stream)
 * - 401: Not authenticated
 * - 503: Node stream not configured
 */
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "node.stream", auth: { mode: "required", getSessionUser } },
  async (ctx, request) => {
    const container = getContainer();

    if (!container.nodeStream) {
      return NextResponse.json(
        { error: "Node stream not configured" },
        { status: 503 }
      );
    }

    const streamKey = `node:${container.nodeId}:events`;
    const lastEventId = request.headers.get("last-event-id") ?? undefined;

    ctx.log.info(
      { streamKey, lastEventId },
      "Starting node stream subscription"
    );

    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort());

    const events = container.nodeStream.subscribe(
      streamKey,
      controller.signal,
      lastEventId
    );
    const body = encodeSSE(events, controller.signal);

    return new NextResponse(body, {
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
