// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads` (test)
 * Purpose: Pin that `POST /api/v1/deploy/workloads` deploys a node from ITS OWN repo (chosen from the
 *   catalog baked into the operator image, the same on every env: a candidate-a config whose parent
 *   repo is the test org still resolves a canonical node, story.5137), lowers an image of `.` to the digest node CI built at the sha, and refuses before
 *   any write when that image is absent or the repo-spec names another node (story.5127).
 * Scope: Mocked IO collaborators (gate, declaration reader, image resolver, store); the REAL image
 *   catalog resolution (this repo's `infra/catalog`) and the REAL declaration check and lowering
 *   (`features/node-deploy/declarations`, `@cogni/repo-spec`) run unchanged.
 * Side-effects: filesystem read of the checked-in catalog, root repo-spec and canary manifest
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BuiltImageRegistryError } from "@/ports";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const TOKS5_ID = "f66b260b-4633-41e2-8711-b7c1b8449cc1";
const SHA = "3521b6422693fbbe1c7f80fe9ed9f476721e0970";
const DIGEST = `sha256:${"cd".repeat(32)}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../../../../../../..");
// The route resolves nodes from the catalog baked into the image; point it at this repo's catalog.
// biome-ignore lint/style/noProcessEnv: test setup for the image-root override the resolver reads
process.env.COGNI_IMAGE_ROOT = ROOT;
const OPERATOR_REPO_SPEC = readFileSync(
  path.join(ROOT, ".cogni/repo-spec.yaml"),
  "utf8"
);
// toks5's own repo-spec names toks5, not the operator.
const REPO_SPEC = OPERATOR_REPO_SPEC.replaceAll(NODE_ID, TOKS5_ID);
const CANARY = readFileSync(
  path.join(ROOT, ".cogni/workloads/canary.yaml"),
  "utf8"
);
// The same manifest, but its image is "the image node CI built at this sha".
const CANARY_BUILT = CANARY.replace(/^ {4}image: .*$/m, '    image: "."');

const gate = vi.fn();
const fetchFileText = vi.fn();
const listDirectoryEntries = vi.fn();
const resolveBuiltImage = vi.fn();
const recordRelease = vi.fn();
const getDesired = vi.fn();

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        {
          reqId: "req-1",
          routeId: "deploy.workloads.record",
          log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        },
        request,
        { id: "user-1" }
      ),
}));
vi.mock("./_lib/gate", () => ({
  gate: (...args: unknown[]) => gate(...args),
  envNotServed: () => undefined,
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    // The candidate's test parent: it holds NO canonical node catalog rows.
    NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
    DEPLOY_ENVIRONMENT: "candidate-a",
  }),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => NODE_ID }));
vi.mock(
  "@/bootstrap/capabilities/node-source-resolver",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/bootstrap/capabilities/node-source-resolver")
    >()),
    createDeclarationReader: () => ({ fetchFileText, listDirectoryEntries }),
  })
);
vi.mock("@/bootstrap/capabilities/built-image-resolver", () => ({
  createBuiltImageResolver: () => ({ resolveBuiltImage }),
}));
vi.mock("@/bootstrap/capabilities/node-deploy-store", () => ({
  createNodeDeployStore: () => ({ recordRelease, getDesired }),
}));

const post = async (): Promise<Response> => {
  const { POST } = await import("./route");
  return POST(
    new Request("https://operator.example/api/v1/deploy/workloads", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "node-ref",
        env: "candidate-a",
        workload: "canary",
        sourceSha: SHA,
      }),
    }) as NextRequest,
    {} as never
  );
};

function repoServes(manifest: string, repoSpec = REPO_SPEC): void {
  fetchFileText.mockImplementation(async ({ path: p }: { path: string }) =>
    p === ".cogni/repo-spec.yaml"
      ? repoSpec
      : p === ".cogni/workloads/canary.yaml"
        ? manifest
        : null
  );
  listDirectoryEntries.mockResolvedValue([
    { name: "canary.yaml", type: "file", size: manifest.length },
  ]);
}

describe("POST /api/v1/deploy/workloads: a node deploys from its own repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.mockResolvedValue({
      ok: true,
      node: { id: TOKS5_ID, slug: "toks5" },
    });
    resolveBuiltImage.mockResolvedValue(`ghcr.io/cogni-dao/toks5@${DIGEST}`);
    recordRelease.mockImplementation(async (input: { spec: unknown }) => ({
      release: { id: "11111111-1111-4111-8111-111111111111", spec: input.spec },
      desired: { state: "running" },
    }));
    repoServes(CANARY_BUILT);
  });

  it("resolves a canonical node from the image catalog on a candidate-a config (test-org parent), reads its repo at the sha, and pins the built image", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    for (const call of fetchFileText.mock.calls)
      expect(call[0]).toMatchObject({
        owner: "cogni-dao",
        repo: "toks5",
        ref: SHA,
      });
    expect(listDirectoryEntries).toHaveBeenCalledWith({
      owner: "cogni-dao",
      repo: "toks5",
      path: ".cogni/workloads",
      ref: SHA,
    });
    expect(resolveBuiltImage).toHaveBeenCalledWith({
      imageRepository: "ghcr.io/cogni-dao/toks5",
      sourceSha: SHA,
    });
    expect(recordRelease).toHaveBeenCalledTimes(1);
    expect(recordRelease.mock.calls[0]?.[0]).toMatchObject({
      nodeId: TOKS5_ID,
      env: "candidate-a",
      workload: "canary",
      sourceSha: SHA,
      spec: { name: "canary", image: `ghcr.io/cogni-dao/toks5@${DIGEST}` },
    });
  });

  it("returns 422 built_image_not_found and writes nothing when the image was never built", async () => {
    resolveBuiltImage.mockResolvedValue(null);
    const response = await post();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "built_image_not_found",
    });
    expect(recordRelease).not.toHaveBeenCalled();
  });

  it("returns a retryable 502 when the image registry fails", async () => {
    resolveBuiltImage.mockRejectedValue(
      new BuiltImageRegistryError("ghcr 503")
    );
    const response = await post();
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "built_image_lookup_failed",
    });
    expect(recordRelease).not.toHaveBeenCalled();
  });

  it("does not look up an image when every manifest image is already digest-pinned", async () => {
    repoServes(CANARY);
    const response = await post();
    expect(response.status).toBe(200);
    expect(resolveBuiltImage).not.toHaveBeenCalled();
  });

  it("keeps an in-repo node (the operator) on the parent repo and refuses an image of '.'", async () => {
    gate.mockResolvedValue({
      ok: true,
      node: { id: NODE_ID, slug: "operator" },
    });
    repoServes(CANARY_BUILT, OPERATOR_REPO_SPEC);
    const response = await post();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "workload_manifest_refused",
      issues: [{ code: "built_image_unresolved" }],
    });
    expect(resolveBuiltImage).not.toHaveBeenCalled();
    expect(fetchFileText.mock.calls[0]?.[0]).toMatchObject({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
    });

    repoServes(CANARY, OPERATOR_REPO_SPEC);
    expect((await post()).status).toBe(200);
  });

  it("refuses a repo-spec that names another node (node_mismatch) before any image lookup or write", async () => {
    // toks5 is in the catalog, but the repo at this sha declares the operator's node id.
    repoServes(CANARY_BUILT, OPERATOR_REPO_SPEC);
    const response = await post();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "node_mismatch",
    });
    expect(resolveBuiltImage).not.toHaveBeenCalled();
    expect(recordRelease).not.toHaveBeenCalled();
  });

  it("returns 404 catalog_missing when the image catalog does not know the node", async () => {
    gate.mockResolvedValue({
      ok: true,
      node: { id: "00000000-0000-4000-8000-000000000000", slug: "ghost" },
    });
    const response = await post();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "catalog_missing",
    });
    expect(fetchFileText).not.toHaveBeenCalled();
  });

  it("returns 502 declaration_read_failed without echoing the source error", async () => {
    fetchFileText.mockRejectedValue(new Error("Bad credentials: ghs_secret"));
    const response = await post();
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("declaration_read_failed");
    expect(text).not.toContain("ghs_secret");
  });
});

describe("image catalog source resolution (the route's resolver)", () => {
  const parent = {
    parentOwner: "cogni-test-org",
    parentRepo: "cogni-monorepo",
  };

  it("refuses an image repository that does not match the source repo", async () => {
    const { ImageCatalogNodeSource } = await import("@/adapters/server");
    const bad = new ImageCatalogNodeSource({
      entryFor: async () => ({
        slug: "toks5",
        row: {
          name: "toks5",
          type: "node",
          path_prefix: "nodes/toks5/",
          source_repo: "https://github.com/cogni-dao/toks5.git",
          image_repository: "ghcr.io/evil/other",
        },
      }),
    });
    await expect(
      bad.resolveNodeSource({ nodeId: TOKS5_ID, ...parent })
    ).rejects.toMatchObject({ code: "image_repository_mismatch" });
  });

  it("resolves a canonical node to its own repo and image repository, and the operator to the given parent", async () => {
    const { createNodeSourceResolver } = await vi.importActual<
      typeof import("@/bootstrap/capabilities/node-source-resolver")
    >("@/bootstrap/capabilities/node-source-resolver");
    const resolver = createNodeSourceResolver();
    await expect(
      resolver.resolveNodeSource({ nodeId: TOKS5_ID, ...parent })
    ).resolves.toEqual({
      owner: "cogni-dao",
      repo: "toks5",
      imageRepository: "ghcr.io/cogni-dao/toks5",
    });
    await expect(
      resolver.resolveNodeSource({ nodeId: NODE_ID, ...parent })
    ).resolves.toEqual({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      imageRepository: null,
    });
  });
});
