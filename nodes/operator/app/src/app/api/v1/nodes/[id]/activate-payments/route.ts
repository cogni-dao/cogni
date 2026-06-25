// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/activate-payments`
 * Purpose: Open the payment-activation PR into the NODE'S OWN repo — write `node_wallet.address` +
 *   `payments_in.credits_topup.*` (95/5 at-cost) + `payments.status: active` into that repo's
 *   `.cogni/repo-spec.yaml` via the cogni-operator GitHub App. Advances `payments_ready → active`.
 * Scope: Owner-gated. The Split is deployed client-side (wagmi) and its address PATCHed onto the
 *   node row BEFORE this call; this route is the missing write-back seam — the wizard previously
 *   only hand-pasted YAML and never committed it to the node's repo (the gap this closes).
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED, NODE_SOVEREIGNTY (PR only; never force-push to node main).
 *   - SINGLE_HOME: targets the node's OWN repo (`NODE_MINT_OWNER`/slug, built like `publish` — never
 *     `getGithubRepo()` which is hardcoded to the operator monorepo), writes ONLY `.cogni/repo-spec.yaml`.
 *   - WALLET_CUSTODY: operator never holds node keys; this only records addresses.
 *   - STATE_MACHINE_TOTAL, OWNER_GATING.
 *   - IDEMPOTENT: re-running detects an already-active spec (`no_changes`) and returns the existing PR.
 * Side-effects: IO (GitHub REST API, Postgres)
 * Links: src/adapters/server/vcs/github-repo-write.ts, src/app/api/v1/nodes/[id]/publish/route.ts, task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { resolveAppDb } from "@/bootstrap/container";
import { transition } from "@/features/nodes/state-machine";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, routeArgs: RouteParams) {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await routeArgs.params;

  const env = serverEnv();
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    return NextResponse.json(
      {
        error: "operator not configured for repo write",
        reason: "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
      },
      { status: 503 }
    );
  }
  // Mint owner is env-scoped + FAIL CLOSED — the node's OWN repo is `NODE_MINT_OWNER/slug`, never
  // derived from the operator's monorepo org (mirrors publish/route.ts). A test/candidate operator
  // must have zero access to the real org.
  const mintOwner = env.NODE_MINT_OWNER;
  if (!mintOwner) {
    return NextResponse.json(
      {
        error: "operator not configured for node minting",
        reason: "NODE_MINT_OWNER required (env-scoped node-repo owner)",
      },
      { status: 503 }
    );
  }

  const db = resolveAppDb();
  const existing = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .limit(1)
  );
  const node = existing[0];
  if (!node) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Idempotent: already active → return without re-opening (mirror publish's already-published short).
  if (node.status === "active") {
    return NextResponse.json({ node, alreadyActive: true });
  }

  const t = transition(node.status as NodeStatus, {
    type: "activation_published",
  });
  if (!t.ok) {
    return NextResponse.json(
      {
        error: "invalid state for payment activation",
        reason: t.reason,
        currentStatus: node.status,
      },
      { status: 409 }
    );
  }

  // Both addresses must be present on the row: the node wallet (own Privy/operator wallet) and the
  // deployed Split. Activation cannot write a half-configured rail.
  if (!node.operatorWalletAddress || !node.splitAddress) {
    return NextResponse.json(
      {
        error: "node missing wallet or Split address for activation",
        hasNodeWallet: Boolean(node.operatorWalletAddress),
        hasSplit: Boolean(node.splitAddress),
      },
      { status: 409 }
    );
  }

  const writer = createNodeRepoWriter(env);
  let result: Awaited<ReturnType<typeof writer.openPaymentsActivationPr>>;
  try {
    result = await writer.openPaymentsActivationPr({
      owner: mintOwner,
      repo: node.slug,
      slug: node.slug,
      nodeWalletAddress: node.operatorWalletAddress,
      splitAddress: node.splitAddress,
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const reason = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: "payment activation write-back failed", reason },
      { status: typeof status === "number" ? status : 502 }
    );
  }

  // Advance to active. The PR landing + deploy is the AI dev's follow-through (like publish), but the
  // operator-side milestone — the write-back is authored — is reached here.
  const [updated] = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .update(nodes)
        .set({ status: t.nextStatus, updatedAt: new Date() })
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .returning()
  );

  return NextResponse.json({ node: updated, activation: result });
}
