// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/activate-payments`
 * Purpose: Open the payment-activation PR into the NODE'S OWN repo - write `node_wallet.address` +
 *   `payments_in.credits_topup.*` (95/5 at-cost) + `payments.status: active` into that repo's
 *   `.cogni/repo-spec.yaml` via the cogni-operator GitHub App.
 * Scope: Bearer/session auth + owner-or-developer gating. The Split is deployed client-side (wagmi)
 *   and its address PATCHed onto the node row BEFORE this call; this route is the missing
 *   write-back path - the wizard previously only hand-pasted YAML and never committed it to the
 *   node's repo (the gap this closes).
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED, NODE_SOVEREIGNTY (PR only; never force-push to node main).
 *   - SINGLE_HOME: targets the node's OWN repo (`NODE_MINT_OWNER`/slug, built like `publish` - never
 *     `getGithubRepo()` which is hardcoded to the operator monorepo), writes ONLY `.cogni/repo-spec.yaml`.
 *   - WALLET_CUSTODY: operator never holds node keys; this only records addresses.
 *   - OWNER_OR_DEVELOPER: node owner session OR `node.flight` authorizes activation.
 *   - IDEMPOTENT: re-running detects an already-active spec (`no_changes`) and returns the existing PR.
 *   - NO_FALSE_READY: opening a PR is not readiness. Status advances only after repo-spec main and
 *     production deployment are verified by a server-side follow-up.
 * Side-effects: IO (GitHub REST API, Postgres)
 * Links: src/adapters/server/vcs/github-repo-write.ts, src/app/api/v1/nodes/[id]/publish/route.ts, task.5083
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { resolveServiceDb } from "@/bootstrap/container";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function activationNodePayload(node: typeof nodes.$inferSelect) {
  return {
    id: node.id,
    slug: node.slug,
    status: node.status,
    operatorWalletAddress: node.operatorWalletAddress,
    splitAddress: node.splitAddress,
    repoUrl: node.repoUrl,
  };
}

export async function POST(_request: Request, routeArgs: RouteParams) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
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
  // Mint owner is env-scoped + FAIL CLOSED - the node's OWN repo is `NODE_MINT_OWNER/slug`, never
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

  const db = resolveServiceDb();
  const existing = await db
    .select()
    .from(nodes)
    .where(nodeIdOrSlug(id))
    .limit(1);
  const node = existing[0];
  if (!node) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const isOwner = node.ownerUserId === sessionUser.id;
  if (!isOwner) {
    const gate = await resolveNodeAndAuthorize({
      id: node.id,
      userId: sessionUser.id,
      action: "node.flight",
    });
    if (!gate.ok) {
      const body =
        gate.errorCode === "authz_unavailable"
          ? {
              error: "authorization not configured",
              errorCode: gate.errorCode,
            }
          : { error: "not authorized", errorCode: gate.errorCode };
      return NextResponse.json(body, { status: gate.status });
    }
  }

  // Idempotent: already active means return without re-opening (mirror publish's already-published short).
  if (node.status === "active") {
    return NextResponse.json({
      node: activationNodePayload(node),
      alreadyActive: true,
    });
  }

  if (node.status !== "wallet_ready" && node.status !== "payments_ready") {
    return NextResponse.json(
      {
        error: "invalid state for payment activation",
        reason:
          "payment activation can only run after the operator wallet exists",
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

  return NextResponse.json({
    node: activationNodePayload(node),
    activation: result,
  });
}
