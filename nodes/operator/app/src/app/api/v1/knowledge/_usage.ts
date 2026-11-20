// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/_usage`
 * Purpose: Count one HTTP atom read by an agent (story.0061).
 * Scope: Applies the bearer-only class rule and hands the read to the container's counter.
 * Invariants:
 * - AGENTS_ONLY: only a request carrying a bearer token is counted; a cookie-session human never is. An invalid
 *   bearer resolves to no identity, so the route never reaches the count; a counted caller is a verified machine key.
 * - NEVER_FAILS_THE_ROUTE: a missing or throwing counter is ignored.
 * Side-effects: none beyond `knowledgeReadCounter.count()`
 * Links: https://node-template.cognidao.org/knowledge/knowledge-usage-telemetry
 * @internal
 */

import type { SessionUser } from "@cogni/node-shared";

import { getContainer } from "@/bootstrap/container";

function isBearerRequest(request: Request): boolean {
  return (
    request.headers
      .get("authorization")
      ?.toLowerCase()
      .startsWith("bearer ") === true
  );
}

export function countAgentRead(
  request: Request,
  sessionUser: SessionUser,
  atomId: string,
  outcome: "ok" | "fail"
): void {
  if (!isBearerRequest(request)) return;
  try {
    getContainer().knowledgeReadCounter.count({
      atomId,
      outcome,
      principalId: sessionUser.id,
      principalClass: "external_agent",
    });
  } catch {
    // NEVER_FAILS_THE_ROUTE
  }
}
