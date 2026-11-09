// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/_lib/gate`
 * Purpose: The shared front-door checks of the node-deploy routes (record, read, game-day): node lookup,
 *   billing account, the per-env authorization gate, and the node's image-baked catalog row (task.5400).
 * Scope: Request-time checks only; reads nothing from GitHub and writes nothing.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production -> `node.promote_production`; preview -> `node.manage_envs`;
 *     candidate-a -> `node.flight` OR `node.manage_envs` (the developer proving lane, additive for
 *     env managers, bug.5574). A denial or an unavailable authorizer is a refusal. See `./authz`.
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
import { authzActionsForEnv, gateDecisionFromResults } from "./authz";

export type Gate =
  | {
      ok: true;
      node: { id: string; slug: string };
      /** The node's image-baked catalog row; undefined when the image does not know the node. */
      catalogRow: unknown;
      /**
       * True when the caller may also write this node's secrets (`node.manage_secrets`, the POST /secrets
       * check). The release facade generates missing catalog keys only then (bug.5254): deploying never
       * widens into secret authority.
       */
      mayGenerateSecrets: () => Promise<boolean>;
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
  // candidate-a allows node.flight OR node.manage_envs; short-circuit on the first allow.
  const results = [];
  for (const action of authzActionsForEnv(env)) {
    const decision = await authorization.check({
      actorId: `user:${userId}`,
      action,
      resource: `node:${node.id}`,
      context: { tenantId: billing.id, nodeId: node.id },
    });
    results.push(decision);
    if (decision.decision === "allow") break;
  }
  const verdict = gateDecisionFromResults(results);
  if (!verdict.ok) {
    const code: AuthzDecisionCode = verdict.code;
    return {
      ok: false,
      response: NextResponse.json(
        { error: code },
        { status: code === "authz_unavailable" ? 503 : 403 }
      ),
    };
  }
  const entry = await createNodeCatalog().entryFor(node.id);
  const mayGenerateSecrets = async (): Promise<boolean> =>
    (
      await authorization.check({
        actorId: `user:${userId}`,
        action: "node.manage_secrets",
        resource: `node:${node.id}`,
        context: { tenantId: billing.id, nodeId: node.id },
      })
    ).decision === "allow";
  return { ok: true, node, catalogRow: entry?.row, mayGenerateSecrets };
}
