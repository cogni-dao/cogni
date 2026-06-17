// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/observability/logs`
 * Purpose: GUARDED STUB for north-star ② (task.5025) — the node-scoped Loki log-read for a
 *   developer-RBAC'd dev. The shipped contract is a server-side **query PROXY** pinned to
 *   `{node="<id>"}`: the dev sends a query, the operator runs it server-side constrained to the
 *   one node, and returns only that node's lines. The dev **never holds a token** → node-scoped
 *   by construction (the per-node OpenFGA check gates WHO; the server-pinned selector gates REACH).
 * Scope: Thin shell — Cogni-token auth + developer-RBAC gate (proves the gate in a live deploy),
 *   then **always 503 `observability_proxy_not_built`**. It holds NO Grafana token and returns NONE,
 *   so it cannot leak a cross-node credential — the whole point of the v0 correction.
 * Invariants:
 *   - COGNI_TOKEN_ONLY (Bearer-first); DEVELOPER_GATED (`node.flight`); fail-closed without a store.
 *   - NEVER_ISSUES_A_TOKEN: the operator is a query proxy, not a credential issuer. This route must
 *     never return a Grafana/Loki token (the rejected "shared Viewer token" design — a dormant
 *     env-wide leak whose reach the per-node check does NOT govern).
 *   - BLOCKED_ON_LOKI_NODE_LABEL: the proxy stays 503 until node Loki streams carry a `node` label
 *     (today: `app/env/service` only) — without it nothing can isolate. That label is the next task.
 * Side-effects: IO (registry read, authz check)
 * Links: docs/spec/grafana-observability-access.md (proxy-not-issuer), docs/spec/substrate-access-grant.md,
 *   flight-status/route.ts (same tuple), task.5025
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer, resolveNodeRegistry } from "@/bootstrap/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  // Consume dev1's registry: match {id} as either the repo-spec nodeId (UUID) or the slug.
  const summaries = await resolveNodeRegistry().listPublic();
  const node = summaries.find((n) => n.nodeId === id || n.slug === id);
  if (!node?.nodeId) {
    return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  }

  // Developer-gated: the SAME `node.flight` tuple as flight. Fail-closed (deny) without a store.
  const authorization = getContainer().authorization;
  if (!authorization) {
    return NextResponse.json({ error: "authz_unavailable" }, { status: 503 });
  }
  const decision = await authorization.check({
    actorId: `user:${sessionUser.id}`,
    action: "node.flight",
    resource: `node:${node.nodeId}`,
    context: { tenantId: node.nodeId, nodeId: node.nodeId },
  });
  if (decision.decision !== "allow") {
    const code: AuthzDecisionCode = decision.code;
    return NextResponse.json(
      { error: code },
      { status: code === "authz_unavailable" ? 503 : 403 }
    );
  }

  // GUARDED: the gate is proven, but the node-pinned proxy is not built — and this route will
  // NEVER hand back a token. It stays 503 until (1) node Loki streams carry a `node` label and
  // (2) the operator runs the query server-side pinned to `{node="<id>"}`. See the linked specs.
  return NextResponse.json(
    {
      error: "observability_proxy_not_built",
      message:
        "node-scoped Loki log-read proxy is not built yet. The operator will run the query " +
        'server-side pinned to {node="<id>"} and return only this node\'s lines; it will never ' +
        "issue a token. Blocked on the `node` Loki stream label (the next substrate task).",
    },
    { status: 503 }
  );
}
