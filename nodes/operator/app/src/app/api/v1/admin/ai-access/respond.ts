// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Next response adapter; package errors never include tokens in logs. */
import type {
  AgentHttpDeps,
  AgentHttpResponse,
} from "@cogni-dao/agent-grants/http";
import { NextResponse } from "next/server";
export const send = (result: AgentHttpResponse) =>
  NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
export const deps = (log: {
  error: (fields: Record<string, unknown>, message: string) => void;
}): AgentHttpDeps => ({
  onUnavailable: (routeId) =>
    log.error({ routeId }, "agent access unavailable"),
});
