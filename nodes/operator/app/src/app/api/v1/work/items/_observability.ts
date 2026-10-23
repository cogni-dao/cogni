// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { EVENT_NAMES, type RequestContext } from "@/shared/observability";
import { createRouteTerminalLogger } from "@/shared/observability/server";

export function workItemTerminal(
  ctx: RequestContext,
  startedAt: number,
  operation: "get" | "patch" | "delete" | "claim" | "heartbeat"
) {
  return createRouteTerminalLogger(
    ctx,
    EVENT_NAMES.WORK_ITEM_PRINCIPAL_OPERATION_COMPLETE,
    startedAt,
    { operation }
  );
}
