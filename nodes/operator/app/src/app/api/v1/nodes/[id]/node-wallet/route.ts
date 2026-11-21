// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/node-wallet`
 * Purpose: Create the node's wallet from the wizard (story.0083). The node owner's browser makes a
 *   P-256 key, saves it as a recovery file and sends ONLY the public key (base64 SPKI). The operator
 *   creates a Privy wallet whose OWNER is that key, records it as PENDING on the registry row, and opens
 *   a PR into the node's own repo that writes `operator_wallet.address`.
 * Scope: Cookie session ONLY (bearer and API keys are refused), the registry owner only, same-origin
 *   only. Creates wallets; signs nothing and grants no signer.
 * Invariants:
 *   - SESSION_OWNER_ONLY: no `Authorization` header is accepted; `node.ownerUserId` must equal the
 *     session user. A developer role does not create the owner's wallet.
 *   - SAME_ORIGIN: the `Origin` header must equal this app's own origin.
 *   - PUBLIC_KEY_ONLY: the body is exactly `{ ownerPublicKey }`, a P-256 SPKI public key. The key is
 *     never logged; err.message is never logged (err.name only).
 *   - ONE_WALLET_PER_NODE_AND_LANE: the key hash is pinned on the row with `UPDATE ... WHERE
 *     pending_node_wallet_key_sha256 IS NULL`; a retry with the same key returns the recorded wallet, a
 *     different key is 409 `key_mismatch`. Privy creation carries `privy-idempotency-key` =
 *     `node-wallet:<env>:<row id>:<key sha256>`; a pending row with no wallet id first adopts a wallet
 *     Privy already lists for that owner key.
 *   - ONE_KEY_ONE_NODE: an owner key pinned on another node row is 409 `key_in_use` (no cross-node adoption).
 *   - SINGLE_WRITER_OF_OPERATOR_WALLET_ADDRESS: this route writes only the `pending_node_wallet_*`
 *     columns. `operator_wallet_address` stays written by payment-prereqs, from the repo-spec on main.
 *   - NEVER_OVERWRITE: a row with `operator_wallet_address`, or a repo-spec on main that names
 *     `operator_wallet.address`, is 409 `already_has_wallet`.
 *   - FAIL_CLOSED: Privy, GitHub App, mint-owner or deploy-environment config missing -> 503, no write.
 *   - ONE_TERMINAL_EVENT: exactly one `node.wallet_create.complete` per call.
 * Side-effects: IO (Postgres, Privy REST, GitHub REST)
 * Links: src/features/nodes/node-wallet.ts, src/adapters/server/vcs/github-repo-write.ts,
 *   https://node-template.cognidao.org/knowledge/set-up-operator-wallet, story.0083
 * @public
 */

import { and, eq, isNull, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { createNodeWalletProvisioner } from "@/bootstrap/capabilities/node-wallet-provisioner";
import { resolveServiceDb } from "@/bootstrap/container";
import { withRootSpan } from "@/bootstrap/otel";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import {
  isSameOriginRequest,
  nodeWalletIdempotencyKey,
  parseOwnerPublicKey,
  requestPublicOrigin,
} from "@/features/nodes/node-wallet";
import { resolveNodeSpecLocation } from "@/features/nodes/payment-prereqs";
import { getServerSessionUser } from "@/lib/auth/server";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import { specNamesOperatorWallet } from "@/shared/node-app-scaffold/gens";
import {
  createRequestContext,
  EVENT_NAMES,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE_ID = "v1.nodes.node-wallet";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

interface RouteParams {
  params: Promise<{ id: string }>;
}

type WalletOutcome = "created" | "adopted" | "existing" | "error";

interface TerminalFields {
  outcome: WalletOutcome;
  errorCode?: string;
  walletAddress?: string;
}

export async function POST(
  request: Request,
  routeArgs: RouteParams
): Promise<NextResponse> {
  return withRootSpan(
    "POST nodes.node-wallet",
    { route_id: ROUTE_ID },
    async ({ traceId }) => {
      const ctx = createRequestContext({ baseLog, clock }, request, {
        routeId: ROUTE_ID,
        traceId,
      });
      return handleNodeWallet(request, routeArgs, ctx);
    }
  );
}

async function handleNodeWallet(
  request: Request,
  routeArgs: RouteParams,
  ctx: ReturnType<typeof createRequestContext>
): Promise<NextResponse> {
  const startTime = performance.now();
  let nodeId: string | undefined;
  let actorUserId: string | undefined;

  // ONE_TERMINAL_EVENT: every exit goes through `finish`. Only public facts are logged.
  const finish = (
    status: number,
    body: Record<string, unknown>,
    fields: TerminalFields
  ): NextResponse => {
    ctx.log.info(
      {
        event: EVENT_NAMES.NODE_WALLET_CREATE_COMPLETE,
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId,
        actorUserId,
        outcome: fields.outcome,
        status,
        ...(fields.walletAddress
          ? { walletAddress: fields.walletAddress }
          : {}),
        ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
        durationMs: Math.round(performance.now() - startTime),
      },
      "node-wallet: complete"
    );
    return NextResponse.json(body, { status });
  };
  const refuse = (
    status: number,
    errorCode: string,
    extra: Record<string, unknown> = {},
    walletAddress?: string
  ): NextResponse =>
    finish(
      status,
      { error: errorCode, ...extra },
      {
        outcome: "error",
        errorCode,
        ...(walletAddress ? { walletAddress } : {}),
      }
    );

  try {
    // SESSION_OWNER_ONLY: a bearer / API key never reaches the session lookup.
    if (request.headers.get("authorization")) {
      return refuse(401, "session_required");
    }

    const env = serverEnv();

    // SAME_ORIGIN: the browser page on this app's own origin is the only caller.
    const allowedOrigins = [requestPublicOrigin(request)];
    if (env.APP_BASE_URL) allowedOrigins.push(new URL(env.APP_BASE_URL).origin);
    if (
      !isSameOriginRequest({
        origin: request.headers.get("origin"),
        allowedOrigins,
      })
    ) {
      return refuse(403, "origin_mismatch");
    }

    const session = await getServerSessionUser();
    if (!session) return refuse(401, "unauthorized");
    actorUserId = session.id;

    const { id } = await routeArgs.params;
    const db = resolveServiceDb();
    const found = await db
      .select()
      .from(nodes)
      .where(nodeIdOrSlug(id))
      .limit(1);
    let node = found[0];
    if (!node) return refuse(404, "node_not_found");
    nodeId = node.id;

    if (node.ownerUserId !== session.id) {
      return refuse(403, "not_node_owner");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return refuse(400, "invalid_body");
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("ownerPublicKey" in body)
    ) {
      return refuse(400, "invalid_body");
    }
    const key = parseOwnerPublicKey(
      (body as { ownerPublicKey: unknown }).ownerPublicKey
    );
    if (!key.ok) return refuse(400, key.reason);

    // NEVER_OVERWRITE (row): `operator_wallet_address` already recorded.
    if (node.operatorWalletAddress) {
      return refuse(409, "already_has_wallet", { source: "registry" });
    }
    if (node.status !== "published") {
      return refuse(409, "invalid_state", {
        reason: "a node wallet can only be created once the node is published",
        currentStatus: node.status,
      });
    }

    // FAIL_CLOSED: every dependency is checked before the first write.
    const provisioner = createNodeWalletProvisioner(env);
    if (!provisioner) {
      return refuse(503, "privy_unconfigured", {
        reason: "PRIVY_APP_ID + PRIVY_APP_SECRET required",
      });
    }
    if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
      return refuse(503, "repo_write_unconfigured", {
        reason: "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
      });
    }
    const deployEnvironment = env.DEPLOY_ENVIRONMENT;
    if (!deployEnvironment) {
      return refuse(503, "deploy_environment_unconfigured", {
        reason:
          "DEPLOY_ENVIRONMENT required to scope the wallet idempotency key",
      });
    }
    const location = resolveNodeSpecLocation(node, env.NODE_MINT_OWNER);
    if (!location) {
      return refuse(503, "mint_owner_unconfigured", {
        reason: "NODE_MINT_OWNER required (env-scoped node-repo owner)",
      });
    }
    const writer = createNodeRepoWriter(env);

    // NEVER_OVERWRITE (git): the node repo-spec on main must not already name a wallet.
    let specText: string | null;
    try {
      specText = await writer.fetchFileText({
        owner: location.owner,
        repo: location.repo,
        path: location.path,
        ref: "main",
      });
    } catch (err) {
      ctx.log.warn(
        {
          routeId: ctx.routeId,
          errClass: err instanceof Error ? err.name : "unknown",
        },
        "node-wallet: repo-spec read failed"
      );
      return refuse(502, "repo_spec_read_failed");
    }
    if (specText === null) {
      return refuse(409, "prereq_missing", { missingKey: "repo-spec" });
    }
    if (specNamesOperatorWallet(specText)) {
      return refuse(409, "already_has_wallet", { source: "repo-spec" });
    }

    // ONE_WALLET_PER_NODE_AND_LANE: pin the owner-key hash once.
    if (node.pendingNodeWalletKeySha256 === null) {
      // ONE_KEY_ONE_NODE: an owner key already pinned on ANOTHER node row must not be pinned here, or
      // adoption below would hand that node's wallet to this one (a recovery file loaded on the wrong node).
      const keyInUse = await db
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.pendingNodeWalletKeySha256, key.keySha256),
            ne(nodes.id, node.id)
          )
        )
        .limit(1);
      if (keyInUse[0]) return refuse(409, "key_in_use");
      const pinned = await db
        .update(nodes)
        .set({
          pendingNodeWalletKeySha256: key.keySha256,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(nodes.id, node.id),
            isNull(nodes.pendingNodeWalletKeySha256),
            isNull(nodes.operatorWalletAddress)
          )
        )
        .returning();
      const won = pinned[0];
      if (won) {
        node = won;
      } else {
        // A concurrent call pinned first (or the wallet was recorded): judge against the winner.
        const reread = (
          await db.select().from(nodes).where(eq(nodes.id, node.id)).limit(1)
        )[0];
        if (!reread) return refuse(404, "node_not_found");
        if (reread.operatorWalletAddress) {
          return refuse(409, "already_has_wallet", { source: "registry" });
        }
        node = reread;
      }
    }
    if (node.pendingNodeWalletKeySha256 !== key.keySha256) {
      return refuse(409, "key_mismatch", {
        reason:
          "this node already has a wallet owned by a different key; load the original recovery file",
      });
    }

    // Resolve the wallet: recorded -> adopt a Privy-listed one -> create.
    let walletAddress: string;
    let outcome: "created" | "adopted" | "existing";
    if (node.pendingNodeWalletAddress && node.pendingNodeWalletId) {
      walletAddress = node.pendingNodeWalletAddress;
      outcome = "existing";
    } else {
      let wallet: { id: string; address: string };
      try {
        // Adoption is safe: the key is generated per node in the browser, and ONE_KEY_ONE_NODE above
        // guarantees no other row in this lane has it pinned, so a wallet Privy lists for this owner key
        // can only be this node's interrupted create.
        const listed = await provisioner.findByOwnerKey(key.spkiBase64);
        if (listed.length > 1) {
          return refuse(409, "wallet_ambiguous", {
            reason: "more than one wallet already uses this owner key",
          });
        }
        const adopted = listed[0];
        if (adopted) {
          wallet = adopted;
          outcome = "adopted";
        } else {
          wallet = await provisioner.createOwned({
            ownerPublicKey: key.spkiBase64,
            idempotencyKey: nodeWalletIdempotencyKey({
              env: deployEnvironment,
              rowId: node.id,
              keySha256: key.keySha256,
            }),
          });
          outcome = "created";
        }
      } catch (err) {
        ctx.log.warn(
          {
            routeId: ctx.routeId,
            errClass: err instanceof Error ? err.name : "unknown",
          },
          "node-wallet: privy call failed"
        );
        return refuse(502, "privy_unavailable");
      }

      const recorded = await db
        .update(nodes)
        .set({
          pendingNodeWalletId: wallet.id,
          pendingNodeWalletAddress: wallet.address,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(nodes.id, node.id),
            eq(nodes.pendingNodeWalletKeySha256, key.keySha256),
            isNull(nodes.pendingNodeWalletId)
          )
        )
        .returning();
      if (recorded[0]) {
        walletAddress = wallet.address;
      } else {
        // A concurrent call recorded first: its wallet is the node's wallet.
        const reread = (
          await db.select().from(nodes).where(eq(nodes.id, node.id)).limit(1)
        )[0];
        if (!reread?.pendingNodeWalletAddress) {
          return refuse(500, "wallet_record_failed");
        }
        walletAddress = reread.pendingNodeWalletAddress;
        outcome = "existing";
      }
    }

    // Record in git: PR into the node's own repo, `operator_wallet.address` only.
    try {
      const pr = await writer.openNodeWalletPr({
        owner: location.owner,
        repo: location.repo,
        slug: node.slug,
        walletAddress,
      });
      return finish(
        200,
        { walletAddress, outcome, pr },
        { outcome, walletAddress }
      );
    } catch (err) {
      ctx.log.warn(
        {
          routeId: ctx.routeId,
          errClass: err instanceof Error ? err.name : "unknown",
        },
        "node-wallet: pr open failed"
      );
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "wallet_already_declared") {
        return refuse(409, "already_has_wallet", { source: "repo-spec" });
      }
      // The wallet exists and is recorded: a retry with the same key reopens the PR.
      return refuse(
        502,
        "pr_open_failed",
        { walletAddress, retry: true },
        walletAddress
      );
    }
  } catch (err) {
    ctx.log.error(
      {
        routeId: ctx.routeId,
        errClass: err instanceof Error ? err.name : "unknown",
      },
      "node-wallet: unexpected failure"
    );
    return refuse(500, "node_wallet_failed");
  }
}
