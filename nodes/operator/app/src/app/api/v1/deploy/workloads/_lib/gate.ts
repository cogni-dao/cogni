// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/_lib/gate`
 * Purpose: The shared front-door checks of the node-deploy routes (record, read, game-day): node lookup,
 *   billing account, the per-env authorization gate, and the node's image-baked catalog row (task.5400).
 * Scope: Request-time checks only; reads nothing from GitHub and writes nothing.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production -> `node.promote_production`; preview -> `node.manage_envs`;
 *     candidate-a -> `node.flight` (the developer proving lane, bug.5574). A denial or an unavailable
 *     authorizer is a refusal.
 *   - CATALOG_ROW_AFTER_AUTHZ: the node's catalog row (the lane refusals in `./lane` decide from it) is
 *     read from the image only after the authorization check allows.
 * Side-effects: IO (Postgres reads, authz check)
 * @internal
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { billingAccounts } from "@cogni/db-schema/refs";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { createNodeCatalog } from "@/bootstrap/capabilities/node-catalog";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { nodes } from "@/shared/db/nodes";
import { authzActionForEnv } from "./authz";

export type Gate =
  | {
      ok: true;
      node: { id: string; slug: string };
      /** The node's image-baked catalog row; undefined when the image does not know the node. */
      catalogRow: unknown;
    }
  | { ok: false; response: NextResponse };

/** Node lookup + billing account + per-env authorization, shared by POST and GET. */
export async function gate(
  userId: string,
  nodeRef: string,
  env: "candidate-a" | "preview" | "production"
): Promise<Gate> {
  const db = resolveServiceDb();
  const [node] = await db
    .select({ id: nodes.id, slug: nodes.slug })
    .from(nodes)
    .where(nodeIdOrSlug(nodeRef))
    .limit(1);
  if (!node)
    return {
      ok: false,
      response: NextResponse.json({ error: "node_not_found" }, { status: 404 }),
    };
  const [billing] = await db
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(eq(billingAccounts.ownerUserId, userId))
    .limit(1);
  if (!billing)
    return {
      ok: false,
      response: NextResponse.json(
        { error: "billing_account_missing" },
        { status: 403 }
      ),
    };
  const authorization = getContainer().authorization;
  if (!authorization)
    return {
      ok: false,
      response: NextResponse.json(
        { error: "authz_unavailable" },
        { status: 503 }
      ),
    };
  const decision = await authorization.check({
    actorId: `user:${userId}`,
    action: authzActionForEnv(env),
    resource: `node:${node.id}`,
    context: { tenantId: billing.id, nodeId: node.id },
  });
  if (decision.decision !== "allow") {
    const code: AuthzDecisionCode = decision.code;
    return {
      ok: false,
      response: NextResponse.json(
        { error: code },
        { status: code === "authz_unavailable" ? 503 : 403 }
      ),
    };
  }
  const entry = await createNodeCatalog().entryFor(node.id);
  return { ok: true, node, catalogRow: entry?.row };
}
