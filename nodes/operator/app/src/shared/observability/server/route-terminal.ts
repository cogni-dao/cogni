// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Privacy-safe, exactly-once terminal logging for HTTP feature operations. */

import type { EventName, RequestContext } from "@cogni/node-shared";
import { logEvent } from "@cogni/node-shared";

export type RouteTerminalDimensions = Readonly<{
  operation?: string;
  action?: string;
  accessMode?: string;
  mode?: string;
  role?: string;
  targetKind?: string;
  actorKind?: string;
  decision?: string;
  code?: string;
  hasSubject?: boolean;
  conflict?: boolean;
  lane?: string;
  semanticCode?: string;
  policyStatus?: string;
  itemFound?: boolean;
  deleted?: boolean;
  grantsAvailable?: boolean;
  itemCount?: number;
  nodeCount?: number;
}>;

export type RouteTerminalInput = Readonly<{
  status: number;
  outcome: "success" | "error";
  errorCode?: string;
  reasonCode?: string;
  dimensions?: RouteTerminalDimensions;
}>;

export function createRouteTerminalLogger(
  ctx: RequestContext,
  eventName: EventName,
  startedAt: number,
  baseDimensions: RouteTerminalDimensions = {}
): {
  complete(input: RouteTerminalInput): void;
  internalError(dimensions?: RouteTerminalDimensions): void;
  emitted(): boolean;
} {
  let emitted = false;
  const complete = (input: RouteTerminalInput): void => {
    if (emitted) return;
    emitted = true;
    const errorCode =
      input.outcome === "error"
        ? (input.errorCode ?? `http_${input.status}`)
        : undefined;
    const payload = {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      status: input.status,
      durationMs: Math.round(performance.now() - startedAt),
      outcome: input.outcome,
      ...(errorCode
        ? {
            errorCode,
            reasonCode: input.reasonCode ?? errorCode,
          }
        : {}),
      ...baseDimensions,
      ...(input.dimensions ?? {}),
    };
    if (input.outcome === "success") {
      logEvent(ctx.log, eventName, payload);
    } else {
      ctx.log[input.status >= 500 ? "error" : "warn"](
        { event: eventName, ...payload },
        eventName
      );
    }
  };
  return {
    complete,
    internalError: (dimensions) =>
      complete({
        status: 500,
        outcome: "error",
        errorCode: "internal_error",
        reasonCode: "unexpected_exception",
        ...(dimensions ? { dimensions } : {}),
      }),
    emitted: () => emitted,
  };
}
