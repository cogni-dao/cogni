// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/publish`
 * Purpose: Build the governance-only repo-spec YAML and open a PR against the target repo via the GitHub App.
 * Scope: Owner-gated. Advances dao_formed → published when the PR is opened. Idempotent: re-opening
 *   yields the existing PR.
 * Invariants: GH_APP_INSTALL_REQUIRED, NODE_SOVEREIGNTY (PR only; never force-push), STATE_MACHINE_TOTAL.
 * Side-effects: IO (GitHub REST API, Postgres)
 * Links: src/adapters/server/vcs/github-repo-write.ts, task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { resolveAppDb } from "@/bootstrap/container";
import { withRootSpan } from "@/bootstrap/otel";
import { transition } from "@/features/nodes/state-machine";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

/**
 * Classify a node-repo-write mint failure into a stable, low-cardinality code.
 * Maps the GitHub adapter's thrown errors (octokit `status` + message) onto the
 * failure classes an operator must distinguish — so the 502 is never opaque again.
 */
type MintErrorCode =
  | "app_not_installed"
  | "forbidden"
  | "template_not_found"
  | "repo_exists"
  | "main_not_ready"
  | "unknown";

function classifyMintError(err: unknown): {
  errorCode: MintErrorCode;
  status?: number;
} {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? (err as { status?: number }).status
      : undefined;
  const message = err instanceof Error ? err.message : "";
  if (/not installed/i.test(message)) {
    return { errorCode: "app_not_installed", status };
  }
  if (
    status === 403 ||
    /administration|not accessible|forbidden/i.test(message)
  ) {
    return { errorCode: "forbidden", status };
  }
  if (/main not ready/i.test(message)) {
    return { errorCode: "main_not_ready", status };
  }
  if (status === 422 || /already exists|name already/i.test(message)) {
    return { errorCode: "repo_exists", status };
  }
  if (status === 404) {
    return { errorCode: "template_not_found", status };
  }
  return { errorCode: "unknown", status };
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, routeArgs: RouteParams) {
  return withRootSpan(
    "POST nodes.publish",
    { route_id: "nodes.publish" },
    async ({ traceId }) => {
      const startTime = performance.now();
      const session = await getServerSessionUser();
      const ctx = createRequestContext({ baseLog, clock }, request, {
        routeId: "nodes.publish",
        traceId,
        session: session ?? undefined,
      });

      if (!session) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }

      const env = serverEnv();
      if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
        return NextResponse.json(
          {
            error: "operator not configured for repo write",
            reason:
              "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
          },
          { status: 503 }
        );
      }
      // Mint owner + template home are env-scoped and FAIL CLOSED — never derived from the operator's
      // own monorepo org. A test/candidate operator must have zero access to Cogni-DAO; deriving the
      // mint target from repoOwner would let it mint into the real org. So both are required explicitly.
      const mintOwner = env.NODE_MINT_OWNER;
      const templateOwner = env.NODE_TEMPLATE_OWNER;
      if (!mintOwner || !templateOwner) {
        return NextResponse.json(
          {
            error: "operator not configured for node minting",
            reason:
              "NODE_MINT_OWNER + NODE_TEMPLATE_OWNER required (env-scoped; must not derive from the operator's own monorepo org)",
          },
          { status: 503 }
        );
      }

      const { id } = await routeArgs.params;
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

      // Idempotent: if already published, return the existing PR.
      if (
        ["published", "wallet_ready", "payments_ready", "active"].includes(
          node.status
        ) &&
        node.publishPrUrl
      ) {
        return NextResponse.json({ node, alreadyPublished: true });
      }

      const t = transition(node.status as NodeStatus, {
        type: "spec_published",
      });
      if (!t.ok) {
        return NextResponse.json(
          {
            error: "invalid state for publish",
            reason: t.reason,
            currentStatus: node.status,
          },
          { status: 409 }
        );
      }

      if (
        !node.chainId ||
        !node.daoAddress ||
        !node.pluginAddress ||
        !node.signalAddress
      ) {
        return NextResponse.json(
          {
            error: "node row missing required addresses for repo-spec emission",
          },
          { status: 409 }
        );
      }

      // Submodule birth: mint the node's own repo from the node-template template (its ~1100 files live
      // there, not inlined into the operator), then the operator authors a PR pinning it as a git
      // submodule at `nodes/<slug>` + the footprint gens — one App-authored commit, PR URL synchronous.
      const writer = createNodeRepoWriter(env);
      const identity = {
        nodeId: node.id,
        chainId: node.chainId,
        daoContract: node.daoAddress,
        pluginContract: node.pluginAddress,
        signalContract: node.signalAddress,
      };
      let pr: { prNumber: number; prUrl: string };
      try {
        const minted = await writer.generateFromTemplate({
          templateOwner,
          owner: mintOwner,
          slug: node.slug,
          ...identity,
        });
        // Submodule-PR target = the operator monorepo (nodes live at nodes/<slug> there). Non-negotiable.
        pr = await writer.openNodeSubmodulePr({
          owner: node.repoOwner,
          repo: node.repoName,
          slug: node.slug,
          ...identity,
          nodeRepoUrl: minted.cloneUrl,
          nodeRepoHeadSha: minted.headSha,
        });
      } catch (err) {
        // The mint is an external-dependency (GitHub) call. A silent 502 here was invisible in Loki
        // (this catch returned without logging). Emit an error-level terminal event with a classified
        // errorCode so the failure class (missing install / admin perm / template / collision) is
        // queryable — never an opaque 502 again. No raw message in logs; reason stays in the response.
        const { errorCode, status } = classifyMintError(err);
        ctx.log.error(
          {
            event: EVENT_NAMES.NODE_PUBLISH_COMPLETE,
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            outcome: "error",
            errorCode,
            status,
            slug: node.slug,
            durationMs: Math.round(performance.now() - startTime),
          },
          EVENT_NAMES.NODE_PUBLISH_COMPLETE
        );
        const message = err instanceof Error ? err.message : "unknown";
        return NextResponse.json(
          { error: "node-app PR authoring failed", reason: message },
          { status: 502 }
        );
      }

      const [updated] = await withTenantScope(
        db,
        userActor(session.id as UserId),
        async (tx) =>
          tx
            .update(nodes)
            .set({
              status: t.nextStatus,
              publishPrUrl: pr.prUrl,
              updatedAt: new Date(),
            })
            .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
            .returning()
      );

      logEvent(ctx.log, EVENT_NAMES.NODE_PUBLISH_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        outcome: "success",
        slug: node.slug,
        prNumber: pr.prNumber,
        durationMs: Math.round(performance.now() - startTime),
      });
      return NextResponse.json({ node: updated, pr });
    }
  );
}
