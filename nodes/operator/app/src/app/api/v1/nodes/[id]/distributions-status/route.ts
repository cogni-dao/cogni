// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/distributions-status`
 * Purpose: READ the git-plane ground truth of a node's distribution activation: is
 *   `distributions.status: active` on the node repo-spec `main`, is there an OPEN (or merged)
 *   activation PR, and which distributor address does each carry. This is the refresh-safe source
 *   the node-page setup stepper derives its "record" step from (story.5004): an open activation PR
 *   must surface as "recorded — merge to persist", never as baseline "not set up".
 * Scope: Read-only sibling of POST `activate-distributions` (same auth gate: node owner session OR
 *   `node.flight`). Reads the node's OWN repo via the operator GitHub App: repo-spec on `main`, the
 *   activation PR (open or merged), and — when a PR is open — the PR branch's repo-spec so the
 *   pending `distributions.distributor_address` stays visible before the merge.
 * Invariants:
 *   - GROUND_TRUTH_ONLY: every field is read from GitHub (spec text / PR state) or chain-verified
 *     upstream — nothing is echoed from client state. A refresh re-derives the same answer.
 *   - OPEN_PR_IS_FIRST_CLASS: an unmerged activation PR is returned with number + url so the UI can
 *     link "merge to persist" (the toks3 revert-to-baseline bug).
 *   - READ_ONLY: never writes to GitHub or Postgres.
 *   - OWNER_OR_DEVELOPER: node owner session OR `node.flight` (mirror of activate-distributions).
 * Side-effects: IO (GitHub REST reads, Postgres node lookup)
 * Links: src/app/api/v1/nodes/[id]/activate-distributions/route.ts,
 *   src/adapters/server/vcs/github-repo-write.ts (getDistributionActivationStatus),
 *   src/features/nodes/distribution-setup-state.ts,
 *   src/features/nodes/DistributionsCard.client.tsx
 * @public
 */

import { NextResponse } from "next/server";
import { type Address, getAddress } from "viem";
import { parse as parseYaml } from "yaml";
import { resolveRouteIdentity } from "@/app/_lib/auth/route-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { resolveServiceDb } from "@/bootstrap/container";
import { withRootSpan } from "@/bootstrap/otel";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import { createRequestContext, makeLogger } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE_ID = "v1.nodes.distributions-status";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

interface RouteParams {
  params: Promise<{ id: string }>;
}

function checksummedAddress(value: string): Address | null {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

/**
 * Tolerant read of `distributions.distributor_address` from a repo-spec YAML text. Returns null on
 * missing/unparseable/invalid — the caller treats that plane as "no address recorded".
 */
function readSpecDistributorAddress(specText: string | null): Address | null {
  if (specText === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(specText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const distributions = (parsed as Record<string, unknown>).distributions;
  if (typeof distributions !== "object" || distributions === null) return null;
  const address = (distributions as Record<string, unknown>)
    .distributor_address;
  if (typeof address !== "string") return null;
  return checksummedAddress(address);
}

export async function GET(
  request: Request,
  routeArgs: RouteParams
): Promise<NextResponse> {
  return withRootSpan(
    "GET nodes.distributions-status",
    { route_id: ROUTE_ID },
    async ({ traceId }) => {
      const ctx = createRequestContext({ baseLog, clock }, request, {
        routeId: ROUTE_ID,
        traceId,
      });
      return handleDistributionsStatus(routeArgs, ctx);
    }
  );
}

async function handleDistributionsStatus(
  routeArgs: RouteParams,
  ctx: ReturnType<typeof createRequestContext>
): Promise<NextResponse> {
  const auth = await resolveRouteIdentity(getSessionUser);
  if (!auth.ok) {
    return auth.response;
  }
  const sessionUser = auth.user;
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await routeArgs.params;

  const env = serverEnv();
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    return NextResponse.json(
      {
        error: "operator not configured for repo read",
        reason: "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
      },
      { status: 503 }
    );
  }
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
      const responseBody =
        gate.errorCode === "authz_unavailable"
          ? {
              error: "authorization not configured",
              errorCode: gate.errorCode,
            }
          : { error: "not authorized", errorCode: gate.errorCode };
      return NextResponse.json(responseBody, { status: gate.status });
    }
  }

  // The activation record binds the node token + DAO (emissions holder). Without those the record
  // check has nothing to verify against — the card degrades to its metadata-only surface.
  const tokenAddress = checksummedAddress(node.tokenAddress ?? "");
  const daoAddress = checksummedAddress(node.daoAddress ?? "");
  if (!tokenAddress || !daoAddress) {
    return NextResponse.json(
      {
        error: "node missing token or DAO for distribution status",
        hasTokenAddress: tokenAddress !== null,
        hasDaoAddress: daoAddress !== null,
      },
      { status: 409 }
    );
  }

  try {
    const writer = createNodeRepoWriter(env);
    const status = await writer.getDistributionActivationStatus({
      owner: mintOwner,
      repo: node.slug,
      slug: node.slug,
      tokenAddress,
      emissionsHolderAddress: daoAddress,
    });

    // Recorded (main) + pending (open-PR branch) distributor addresses. The branch ref mirrors the
    // writer's activation-branch convention (`cogni-operator/activate-distributions-<slug>`) — the
    // one place outside the writer that names it; if the writer ever exposes the PR head ref on
    // DistributionActivationStatus, read it from there instead.
    const mainSpec = await writer.fetchFileText({
      owner: mintOwner,
      repo: node.slug,
      path: ".cogni/repo-spec.yaml",
      ref: "main",
    });
    const recordedDistributorAddress = readSpecDistributorAddress(mainSpec);

    let pendingDistributorAddress: Address | null = null;
    if (status.activationPr?.state === "open") {
      const branchSpec = await writer.fetchFileText({
        owner: mintOwner,
        repo: node.slug,
        path: ".cogni/repo-spec.yaml",
        ref: `cogni-operator/activate-distributions-${node.slug}`,
      });
      pendingDistributorAddress = readSpecDistributorAddress(branchSpec);
    }

    ctx.log.info(
      {
        event: "node.distribution_status.read",
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId: node.id,
        slug: node.slug,
        repoSpecActive: status.repoSpecActive,
        activationPrState: status.activationPr?.state ?? null,
        activationPrNumber: status.activationPr?.number ?? null,
        hasRecordedDistributor: recordedDistributorAddress !== null,
        hasPendingDistributor: pendingDistributorAddress !== null,
      },
      "distributions-status: read"
    );

    return NextResponse.json({
      node: { id: node.id, slug: node.slug },
      record: {
        repoSpecActive: status.repoSpecActive,
        mainSha: status.mainSha,
        activationPr: status.activationPr,
        recordedDistributorAddress,
        pendingDistributorAddress,
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    ctx.log.error(
      {
        event: "node.distribution_status.read_failed",
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId: node.id,
        slug: node.slug,
        err: reason,
        stack: err instanceof Error ? err.stack : undefined,
      },
      "distributions-status: read failed"
    );
    return NextResponse.json(
      { error: "distribution status read failed", reason },
      { status: 502 }
    );
  }
}
