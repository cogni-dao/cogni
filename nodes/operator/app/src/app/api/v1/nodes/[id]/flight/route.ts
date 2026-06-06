// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/flight`
 * Purpose: Node-ref flight request for externally-built submodule nodes.
 * Scope: Owner-scoped node row -> repo-spec/catalog validation -> child image + parent pin checks -> workflow dispatch.
 * Invariants:
 *   - REPO_SPEC_IS_IDENTITY_SSOT: child `.cogni/repo-spec.yaml` at sourceSha must parse.
 *   - OWNER_GATED_NODE_ID: `[id]` is the node registry UUID, never a slug.
 *   - CATALOG_IS_DEPLOY_SHAPE: catalog supplies source repo + image repository only.
 *   - NO_TENANT_INFERENCE: slug/sourceSha are deploy inputs derived after owner gating.
 * Side-effects: IO (GitHub via VcsCapability/GitHubRepoWriter, workflow dispatch).
 * Links: docs/spec/node-ci-cd-contract.md, docs/spec/identity-model.md
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { extractNodeId, parseRepoSpec } from "@cogni/repo-spec";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { nodeFlightOperation } from "@/contracts/nodes.flight.v1.contract";
import { getGithubRepo } from "@/shared/config/repoSpec.server";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import { logRequestWarn } from "@/shared/observability";

export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const NodeIdParamSchema = z.string().uuid();

const CatalogEntrySchema = z.object({
  name: z.string(),
  type: z.literal("node"),
  path_prefix: z.string(),
  source_repo: z.string().url(),
  image_repository: z
    .string()
    .regex(/^ghcr\.io\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/),
});

function parseGithubRepoUrl(value: string): { owner: string; repo: string } {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(`source_repo must be a GitHub HTTPS URL: ${value}`);
  }
  const [owner, repoWithSuffix, ...extra] = url.pathname
    .split("/")
    .filter(Boolean);
  const repo = repoWithSuffix?.replace(/\.git$/, "");
  if (!owner || !repo || extra.length > 0) {
    throw new Error(`source_repo must be https://github.com/<owner>/<repo>`);
  }
  return { owner, repo };
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "nodes.flight", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, routeContext) => {
    if (!routeContext) {
      return NextResponse.json(
        { error: "missing route context" },
        { status: 500 }
      );
    }
    const { id } = await routeContext.params;
    const nodeIdParam = NodeIdParamSchema.safeParse(id);
    if (!nodeIdParam.success) {
      return NextResponse.json(
        { error: "invalid node id", issues: nodeIdParam.error.issues },
        { status: 400 }
      );
    }

    const parsed = nodeFlightOperation.input.safeParse(await request.json());
    if (!parsed.success) {
      logRequestWarn(ctx.log, parsed.error, "VALIDATION_ERROR");
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { sourceSha, environment } = parsed.data;
    const db = resolveAppDb();
    const rows = await withTenantScope(
      db,
      userActor(sessionUser.id as UserId),
      async (tx) =>
        tx
          .select()
          .from(nodes)
          .where(
            and(
              eq(nodes.id, nodeIdParam.data),
              eq(nodes.ownerUserId, sessionUser.id)
            )
          )
          .limit(1)
    );
    const node = rows[0];
    if (!node) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const slug = node.slug;
    const { owner, repo } = getGithubRepo();
    const vcs = getContainer().vcsCapability;

    const catalogText = await vcs.fetchFileText({
      owner,
      repo,
      path: `infra/catalog/${slug}.yaml`,
      ref: "main",
    });
    if (!catalogText) {
      return NextResponse.json(
        { error: "node catalog entry not found", slug },
        { status: 404 }
      );
    }

    const catalog = CatalogEntrySchema.safeParse(parseYaml(catalogText));
    if (!catalog.success || catalog.data.name !== slug) {
      return NextResponse.json(
        {
          error: "invalid submodule node catalog entry",
          slug,
          issues: catalog.success ? [] : catalog.error.issues,
        },
        { status: 409 }
      );
    }
    if (catalog.data.path_prefix !== `nodes/${slug}/`) {
      return NextResponse.json(
        {
          error: "catalog path_prefix does not match requested slug",
          expected: `nodes/${slug}/`,
          actual: catalog.data.path_prefix,
        },
        { status: 409 }
      );
    }

    const sourceRepo = parseGithubRepoUrl(catalog.data.source_repo);
    const sourceExists = await vcs.commitExists({
      owner: sourceRepo.owner,
      repo: sourceRepo.repo,
      ref: sourceSha,
    });
    if (!sourceExists) {
      return NextResponse.json(
        {
          error: "sourceSha not found in node repo",
          sourceRepo: catalog.data.source_repo,
          sourceSha,
        },
        { status: 422 }
      );
    }

    const childRepoSpecText = await vcs.fetchFileText({
      owner: sourceRepo.owner,
      repo: sourceRepo.repo,
      path: ".cogni/repo-spec.yaml",
      ref: sourceSha,
    });
    if (!childRepoSpecText) {
      return NextResponse.json(
        {
          error: "node repo-spec not found at sourceSha",
          sourceRepo: catalog.data.source_repo,
          sourceSha,
        },
        { status: 422 }
      );
    }

    let nodeId: string;
    try {
      nodeId = extractNodeId(parseRepoSpec(childRepoSpecText));
    } catch (error) {
      logRequestWarn(ctx.log, error, "INVALID_NODE_REPO_SPEC");
      return NextResponse.json(
        {
          error: "node repo-spec is invalid at sourceSha",
          sourceRepo: catalog.data.source_repo,
          sourceSha,
        },
        { status: 422 }
      );
    }
    if (nodeId !== node.id) {
      return NextResponse.json(
        {
          error: "node repo-spec identity mismatch",
          expectedNodeId: node.id,
          actualNodeId: nodeId,
          sourceRepo: catalog.data.source_repo,
          sourceSha,
        },
        { status: 422 }
      );
    }

    const image = `${catalog.data.image_repository}:sha-${sourceSha}`;
    const writer = createNodeRepoWriter(serverEnv());
    const imageExists = await writer.packageImageTagExists({
      owner,
      repo,
      imageRepository: catalog.data.image_repository,
      tag: `sha-${sourceSha}`,
    });
    if (!imageExists) {
      return NextResponse.json(
        { error: "node image not found", image },
        { status: 422 }
      );
    }

    const pin = await writer.ensureNodeSubmodulePin({
      owner,
      repo,
      slug,
      nodeRepoUrl: catalog.data.source_repo,
      nodeRepoHeadSha: sourceSha,
    });
    if (pin.status === "pin_pr_opened") {
      return NextResponse.json(
        {
          error: "operator parent pin required before node-ref flight",
          slug,
          sourceSha,
          currentSha: pin.currentSha,
          pinPr: {
            number: pin.prNumber,
            url: pin.prUrl,
          },
        },
        { status: 409 }
      );
    }

    const dispatch = await vcs.dispatchNodeFlight({
      owner,
      repo,
      slug,
      sourceSha,
      environment,
    });

    return NextResponse.json(
      nodeFlightOperation.output.parse({
        dispatched: dispatch.dispatched,
        nodeRef: `${slug}@${sourceSha}`,
        slug,
        nodeId,
        sourceSha,
        environment,
        sourceRepo: catalog.data.source_repo,
        image,
        workflowUrl: dispatch.workflowUrl,
        message: dispatch.message,
      }),
      { status: 202 }
    );
  }
);
