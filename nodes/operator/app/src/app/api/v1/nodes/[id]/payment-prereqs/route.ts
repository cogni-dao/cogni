// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/payment-prereqs`
 * Purpose: Read the node's OWN repo-spec on `main`, verify the wallet + DAO prerequisites it
 *   declares, and copy them onto the registry row (`published` -> `wallet_ready`). The ONE writer of
 *   `operatorWalletAddress` and of the `wallet_provisioned` transition (bug.5656).
 * Scope: Bearer/session auth + owner-or-developer gating (mirror of activate-payments). The request
 *   carries NO addresses: git is the source, the operator only copies it.
 * Invariants:
 *   - GIT_IS_THE_SOURCE: `operator_wallet.address` + `governance.{dao,plugin,signal}_contract` come
 *     from the repo-spec on `main` at the row's repo location; nothing is read from the request body.
 *   - FAIL_CLOSED: no EVM RPC configured, or the DAO has no code on Base -> no write.
 *   - NEVER_OVERWRITE: a non-null row address that differs from git is 409 `prereq_mismatch`.
 *   - CONDITIONAL_ADVANCE: `published -> wallet_ready` is `UPDATE ... WHERE id = ? AND status =
 *     'published'`; zero rows (a concurrent call won) is 409 `concurrent_update`, safe to retry.
 *   - OWNER_OR_DEVELOPER: node owner session OR `node.flight`.
 *   - ONE_TERMINAL_EVENT: exactly one `node.payment_prereqs.complete` per call (addresses never logged).
 * Side-effects: IO (GitHub REST read, Base RPC read, Postgres)
 * Links: src/features/nodes/payment-prereqs.ts, src/app/api/v1/nodes/[id]/activate-payments/route.ts,
 *   https://cognidao.org/knowledge/node-formation-contract, bug.5656
 * @public
 */

import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { resolveRouteIdentity } from "@/app/_lib/auth/route-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { resolveServiceDb } from "@/bootstrap/container";
import { withRootSpan } from "@/bootstrap/otel";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import {
  evaluatePaymentPrereqs,
  gatePrereqStatus,
  type PaymentPrereqAddresses,
  planPrereqRecord,
  resolveNodeSpecLocation,
} from "@/features/nodes/payment-prereqs";
import { transition } from "@/features/nodes/state-machine";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  createRequestContext,
  EVENT_NAMES,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE_ID = "v1.nodes.payment-prereqs";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

interface RouteParams {
  params: Promise<{ id: string }>;
}

type PrereqOutcome = "recorded" | "unchanged" | "no_change" | "error";

function nodePayload(node: typeof nodes.$inferSelect) {
  return {
    id: node.id,
    slug: node.slug,
    status: node.status,
    operatorWalletAddress: node.operatorWalletAddress,
    daoAddress: node.daoAddress,
    pluginAddress: node.pluginAddress,
    signalAddress: node.signalAddress,
  };
}

export async function POST(
  request: Request,
  routeArgs: RouteParams
): Promise<NextResponse> {
  return withRootSpan(
    "POST nodes.payment-prereqs",
    { route_id: ROUTE_ID },
    async ({ traceId }) => {
      const ctx = createRequestContext({ baseLog, clock }, request, {
        routeId: ROUTE_ID,
        traceId,
      });
      return handlePaymentPrereqs(routeArgs, ctx);
    }
  );
}

async function handlePaymentPrereqs(
  routeArgs: RouteParams,
  ctx: ReturnType<typeof createRequestContext>
): Promise<NextResponse> {
  const startTime = performance.now();
  let nodeId: string | undefined;
  let previousStatus: string | undefined;

  type TerminalFields = {
    outcome: PrereqOutcome;
    nextStatus?: string;
    missingKey?: string;
    errorCode?: string;
  };

  // ONE_TERMINAL_EVENT: every exit goes through `emit` (directly or via `finish`). `logEvent` only
  // accepts the shared EventName union, so the operator-local registry constant is logged directly
  // (same as activate-distributions).
  const emit = (status: number, fields: TerminalFields): void => {
    ctx.log.info(
      {
        event: EVENT_NAMES.NODE_PAYMENT_PREREQS_COMPLETE,
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId,
        outcome: fields.outcome,
        missingKey: fields.missingKey,
        previousStatus,
        nextStatus: fields.nextStatus ?? previousStatus,
        status,
        ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
        durationMs: Math.round(performance.now() - startTime),
      },
      "payment-prereqs: complete"
    );
  };
  const finish = (
    status: number,
    body: Record<string, unknown>,
    fields: TerminalFields
  ): NextResponse => {
    emit(status, fields);
    return NextResponse.json(body, { status });
  };

  try {
    const auth = await resolveRouteIdentity(getSessionUser);
    if (!auth.ok) {
      emit(auth.response.status, {
        outcome: "error",
        errorCode: "unauthorized",
      });
      return auth.response;
    }
    const sessionUser = auth.user;
    if (!sessionUser) {
      return finish(
        401,
        { error: "unauthorized" },
        { outcome: "error", errorCode: "unauthorized" }
      );
    }

    const { id } = await routeArgs.params;

    const db = resolveServiceDb();
    const existing = await db
      .select()
      .from(nodes)
      .where(nodeIdOrSlug(id))
      .limit(1);
    const node = existing[0];
    if (!node) {
      return finish(
        404,
        { error: "not found" },
        { outcome: "error", errorCode: "node_not_found" }
      );
    }
    nodeId = node.id;
    previousStatus = node.status;

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
        return finish(gate.status, body, {
          outcome: "error",
          errorCode: gate.errorCode,
        });
      }
    }

    // State gate first: later statuses never re-read git or the chain.
    const statusGate = gatePrereqStatus(node.status);
    if (statusGate.action === "invalid_state") {
      return finish(
        409,
        {
          error: "invalid_state",
          reason:
            "payment prerequisites can only be read once the node is published",
          currentStatus: node.status,
        },
        { outcome: "error", errorCode: "invalid_state" }
      );
    }
    if (statusGate.action === "no_change") {
      return finish(
        200,
        { node: nodePayload(node), outcome: "no_change" },
        { outcome: "no_change" }
      );
    }

    const env = serverEnv();
    if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
      return finish(
        503,
        {
          error: "operator not configured for repo read",
          reason:
            "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
        },
        { outcome: "error", errorCode: "repo_read_unconfigured" }
      );
    }
    const location = resolveNodeSpecLocation(node, env.NODE_MINT_OWNER);
    if (!location) {
      return finish(
        503,
        {
          error: "operator not configured for node minting",
          reason: "NODE_MINT_OWNER required (env-scoped node-repo owner)",
        },
        { outcome: "error", errorCode: "mint_owner_unconfigured" }
      );
    }
    if (!env.EVM_RPC_URL) {
      return finish(
        503,
        {
          error: "operator not configured for on-chain verification",
          reason: "EVM_RPC_URL required for the DAO contract code check",
        },
        { outcome: "error", errorCode: "evm_rpc_unconfigured" }
      );
    }

    let specText: string | null;
    try {
      specText = await createNodeRepoWriter(env).fetchFileText({
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
        "payment-prereqs: repo-spec read failed"
      );
      return finish(
        502,
        { error: "repo_spec_read_failed" },
        { outcome: "error", errorCode: "repo_spec_read_failed" }
      );
    }
    if (specText === null) {
      return finish(
        409,
        { error: "prereq_missing", missingKey: "repo-spec" },
        {
          outcome: "error",
          errorCode: "prereq_missing",
          missingKey: "repo-spec",
        }
      );
    }

    const evaluation = evaluatePaymentPrereqs(specText);
    if (!evaluation.ok) {
      if (evaluation.kind === "missing") {
        return finish(
          409,
          { error: "prereq_missing", missingKey: evaluation.missingKey },
          {
            outcome: "error",
            errorCode: "prereq_missing",
            missingKey: evaluation.missingKey,
          }
        );
      }
      if (evaluation.kind === "invalid") {
        return finish(
          409,
          {
            error: "prereq_invalid",
            invalidKey: evaluation.invalidKey,
            reason: evaluation.reason,
          },
          {
            outcome: "error",
            errorCode: "prereq_invalid",
          }
        );
      }
      return finish(
        422,
        { error: "repo_spec_invalid" },
        { outcome: "error", errorCode: "repo_spec_invalid" }
      );
    }
    const git: PaymentPrereqAddresses = evaluation.addresses;

    const plan = planPrereqRecord(node, git);
    if (plan.kind === "mismatch") {
      return finish(
        409,
        {
          error: "prereq_mismatch",
          mismatchedKeys: plan.mismatchedKeys,
          git,
          row: {
            operatorWalletAddress: node.operatorWalletAddress,
            daoAddress: node.daoAddress,
            pluginAddress: node.pluginAddress,
            signalAddress: node.signalAddress,
          },
        },
        { outcome: "error", errorCode: "prereq_mismatch" }
      );
    }
    if (plan.kind === "unchanged") {
      return finish(
        200,
        { node: nodePayload(node), outcome: "unchanged", git },
        { outcome: "unchanged" }
      );
    }

    // FAIL_CLOSED: the DAO must have code on Base before anything is recorded.
    try {
      const client = createPublicClient({
        chain: base,
        transport: http(env.EVM_RPC_URL),
      });
      const code = await client.getBytecode({ address: git.daoAddress });
      if (!code || code === "0x") {
        return finish(
          409,
          {
            error: "prereq_invalid",
            invalidKey: "governance.dao_contract",
            reason: "no_code_on_base",
          },
          {
            outcome: "error",
            errorCode: "prereq_invalid",
          }
        );
      }
    } catch (err) {
      ctx.log.warn(
        {
          routeId: ctx.routeId,
          errClass: err instanceof Error ? err.name : "unknown",
        },
        "payment-prereqs: dao code check failed"
      );
      return finish(
        502,
        { error: "rpc_unavailable" },
        { outcome: "error", errorCode: "rpc_unavailable" }
      );
    }

    if (plan.kind === "record_null_columns") {
      // wallet_ready: fill only the NULL columns, status unchanged.
      const rows = await db
        .update(nodes)
        .set({ ...plan.columns, updatedAt: new Date() })
        .where(
          and(
            eq(nodes.id, node.id),
            eq(nodes.status, "wallet_ready"),
            // The target columns must still be NULL: never overwrite a value a concurrent call wrote.
            ...(Object.keys(plan.columns) as (keyof typeof plan.columns)[]).map(
              (column) => isNull(nodes[column])
            )
          )
        )
        .returning();
      const updated = rows[0];
      if (!updated) {
        return finish(
          409,
          { error: "concurrent_update", retry: true },
          { outcome: "error", errorCode: "concurrent_update" }
        );
      }
      return finish(
        200,
        { node: nodePayload(updated), outcome: "recorded", git },
        { outcome: "recorded", nextStatus: updated.status }
      );
    }

    // published -> wallet_ready through the state machine, as ONE conditional write.
    const next = transition("published", { type: "wallet_provisioned" });
    if (!next.ok) {
      return finish(
        409,
        {
          error: "invalid_state",
          reason: next.reason,
          currentStatus: node.status,
        },
        { outcome: "error", errorCode: "invalid_state" }
      );
    }
    const rows = await db
      .update(nodes)
      .set({
        operatorWalletAddress: git.operatorWalletAddress,
        daoAddress: git.daoAddress,
        pluginAddress: git.pluginAddress,
        signalAddress: git.signalAddress,
        status: next.nextStatus,
        updatedAt: new Date(),
      })
      .where(and(eq(nodes.id, node.id), eq(nodes.status, "published")))
      .returning();
    const updated = rows[0];
    if (!updated) {
      return finish(
        409,
        { error: "concurrent_update", retry: true },
        { outcome: "error", errorCode: "concurrent_update" }
      );
    }
    return finish(
      200,
      { node: nodePayload(updated), outcome: "recorded", git },
      { outcome: "recorded", nextStatus: updated.status }
    );
  } catch (err) {
    ctx.log.error(
      {
        routeId: ctx.routeId,
        errClass: err instanceof Error ? err.name : "unknown",
      },
      "payment-prereqs: unexpected failure"
    );
    return finish(
      500,
      { error: "payment prerequisites read failed" },
      { outcome: "error", errorCode: "prereqs_failed" }
    );
  }
}
