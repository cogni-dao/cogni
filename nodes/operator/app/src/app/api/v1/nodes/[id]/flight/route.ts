// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/flight`
 * Purpose: Node-ref flight request for externally-built submodule nodes.
 * Scope: Auth -> repo-spec/catalog validation -> child image check -> workflow dispatch.
 * Invariants:
 *   - REPO_SPEC_IS_IDENTITY_SSOT: child `.cogni/repo-spec.yaml` at sourceSha must parse.
 *   - CATALOG_IS_DEPLOY_SHAPE: catalog supplies source repo + image repository only.
 *   - NO_TENANT_INFERENCE: slug/sourceSha are deploy inputs, not owner identity.
 * Side-effects: IO (GitHub via VcsCapability, GHCR registry probe, workflow dispatch).
 * Links: docs/spec/node-ci-cd-contract.md, docs/spec/identity-model.md
 * @public
 */

import { extractNodeId, parseRepoSpec } from "@cogni/repo-spec";
import { NextResponse } from "next/server";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { nodeFlightOperation } from "@/contracts/nodes.flight.v1.contract";
import { getGithubRepo } from "@/shared/config/repoSpec.server";
import { logRequestWarn } from "@/shared/observability";

export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const SlugSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

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

function ghcrManifestUrl(imageRepository: string, sourceSha: string): string {
  const imagePath = imageRepository.replace(/^ghcr\.io\//, "");
  return `https://ghcr.io/v2/${imagePath}/manifests/sha-${sourceSha}`;
}

async function ghcrImageExists(
  imageRepository: string,
  sourceSha: string
): Promise<boolean> {
  const url = ghcrManifestUrl(imageRepository, sourceSha);
  const headers = {
    Accept:
      "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json",
  };
  const response = await fetch(url, { method: "HEAD", headers });
  if (response.ok) return true;
  if (response.status === 405) {
    const getResponse = await fetch(url, { method: "GET", headers });
    return getResponse.ok;
  }
  return false;
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "nodes.flight", auth: { mode: "required", getSessionUser } },
  async (ctx, request, _sessionUser, routeContext) => {
    if (!routeContext) {
      return NextResponse.json(
        { error: "missing route context" },
        { status: 500 }
      );
    }
    const { id } = await routeContext.params;
    const slug = SlugSchema.safeParse(id);
    if (!slug.success) {
      return NextResponse.json({ error: "invalid slug" }, { status: 400 });
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
    const { owner, repo } = getGithubRepo();
    const vcs = getContainer().vcsCapability;

    const catalogText = await vcs.fetchFileText({
      owner,
      repo,
      path: `infra/catalog/${slug.data}.yaml`,
      ref: "main",
    });
    if (!catalogText) {
      return NextResponse.json(
        { error: "node catalog entry not found", slug: slug.data },
        { status: 404 }
      );
    }

    const catalog = CatalogEntrySchema.safeParse(parseYaml(catalogText));
    if (!catalog.success || catalog.data.name !== slug.data) {
      return NextResponse.json(
        {
          error: "invalid submodule node catalog entry",
          slug: slug.data,
          issues: catalog.success ? [] : catalog.error.issues,
        },
        { status: 409 }
      );
    }
    if (catalog.data.path_prefix !== `nodes/${slug.data}/`) {
      return NextResponse.json(
        {
          error: "catalog path_prefix does not match requested slug",
          expected: `nodes/${slug.data}/`,
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

    const image = `${catalog.data.image_repository}:sha-${sourceSha}`;
    const imageExists = await ghcrImageExists(
      catalog.data.image_repository,
      sourceSha
    );
    if (!imageExists) {
      return NextResponse.json(
        { error: "node image not found", image },
        { status: 422 }
      );
    }

    const dispatch = await vcs.dispatchNodeFlight({
      owner,
      repo,
      slug: slug.data,
      sourceSha,
      environment,
    });

    return NextResponse.json(
      nodeFlightOperation.output.parse({
        dispatched: dispatch.dispatched,
        nodeRef: `${slug.data}@${sourceSha}`,
        slug: slug.data,
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
