// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads` (test)
 * Purpose: Pin that `POST /api/v1/deploy/workloads` is ONE front door for every env (story.5137): it resolves a
 *   node's own repo from the catalog baked into the operator image (the same on every env), refuses a lane it
 *   does not serve or the catalog has not handed to the verb BEFORE any read or write, never waits on node CI
 *   (an image of `.` lowers to the pending tag `<image_repository>:sha-<sha>`; the sequencer pins the digest),
 *   and refuses a repo-spec that names another node.
 * Scope: Mocked IO collaborators (gate, lane refusals, declaration reader, store); the REAL image catalog
 *   resolution (this repo's `infra/catalog`) and the REAL declaration check and lowering
 *   (`features/node-deploy/declarations`, `@cogni/repo-spec`) run unchanged.
 * Side-effects: filesystem read of the checked-in catalog, root repo-spec and canary manifest
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const TOKS5_ID = "f66b260b-4633-41e2-8711-b7c1b8449cc1";
const SHA = "3521b6422693fbbe1c7f80fe9ed9f476721e0970";
const PENDING = `ghcr.io/cogni-dao/toks5:sha-${SHA}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../../../../../../..");
const OPERATOR_REPO_SPEC = readFileSync(
  path.join(ROOT, ".cogni/repo-spec.yaml"),
  "utf8"
);
// toks5's own repo-spec names toks5, not the operator.
const REPO_SPEC = OPERATOR_REPO_SPEC.replaceAll(NODE_ID, TOKS5_ID);
const OPERATOR_CANARY = readFileSync(
  path.join(ROOT, ".cogni/workloads/canary.yaml"),
  "utf8"
);
const CANARY = OPERATOR_CANARY.replaceAll(
  "node-deploy-canary.cognidao.org",
  "toks5.cognidao.org"
);
// The same manifest, but its image is "the image node CI built at this sha".
const CANARY_BUILT = CANARY.replace(/^ {4}image: .*$/m, '    image: "."');
const TOKS5_ROW = {
  name: "toks5",
  compute_api: { "candidate-a": "node-deploy" },
};

const zoneConfig = vi.hoisted(() => ({
  value: "cognidao.org" as string | undefined,
}));
const gate = vi.fn();
const envNotServed = vi.fn();
const nodeNotOnDeployVerb = vi.fn();
const fetchFileText = vi.fn();
const listDirectoryEntries = vi.fn();
const recordRelease = vi.fn();
const getDesired = vi.fn();
const ensureGeneratedKeys = vi.fn();

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
}));
vi.mock("./_lib/lane", () => ({
  envNotServed: (...args: unknown[]) => envNotServed(...args),
  nodeNotOnDeployVerb: (...args: unknown[]) => nodeNotOnDeployVerb(...args),
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    // Canonical control fleet serves canonical nodes in every environment.
    NODE_SUBMODULE_PARENT_OWNER: "cogni-dao",
    NODE_SUBMODULE_PARENT_REPO: "cogni",
    NODE_DEPLOY_WORKLOAD_ZONE: zoneConfig.value,
    DEPLOY_ENVIRONMENT: "production",
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
vi.mock("@/bootstrap/capabilities/node-deploy-store", () => ({
  createNodeDeployStore: () => ({ recordRelease, getDesired }),
}));
vi.mock("@/bootstrap/capabilities/operator-secrets-plane", () => ({
  createOperatorSecretsPlane: () => ({ ensureGeneratedKeys }),
}));

const post = async (env = "candidate-a"): Promise<Response> => {
  const { POST } = await import("./route");
  return POST(
    new Request("https://operator.example/api/v1/deploy/workloads", {
      method: "POST",
      body: JSON.stringify({
        nodeId: "node-ref",
        env,
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

const recorded = () => recordRelease.mock.calls[0]?.[0];

describe("POST /api/v1/deploy/workloads: one front door, a node deploys from its own repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    zoneConfig.value = "cognidao.org";
    gate.mockResolvedValue({
      ok: true,
      node: { id: TOKS5_ID, slug: "toks5" },
      catalogRow: TOKS5_ROW,
    });
    envNotServed.mockReturnValue(undefined);
    nodeNotOnDeployVerb.mockReturnValue(undefined);
    recordRelease.mockImplementation(async (input: { spec: unknown }) => ({
      release: { id: "11111111-1111-4111-8111-111111111111", spec: input.spec },
      desired: { state: "running" },
    }));
    repoServes(CANARY_BUILT);
  });

  it.each([
    undefined,
    "https://invalid/zone",
  ])("refuses new intent before source reads or store writes with %s zone", async (zone) => {
    zoneConfig.value = zone;
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "workload_zone_not_configured",
    });
    expect(fetchFileText).not.toHaveBeenCalled();
    expect(recordRelease).not.toHaveBeenCalled();
  });

  it("resolves a canonical node from the image catalog for its candidate-a lane, reads its repo at the sha, and records the PENDING image (ALWAYS_DEFER)", async () => {
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
    expect(recordRelease).toHaveBeenCalledTimes(1);
    expect(recorded()).toMatchObject({
      nodeId: TOKS5_ID,
      env: "candidate-a",
      workload: "canary",
      sourceSha: SHA,
      createdBy: "user:user-1",
      // never waits on node CI: the tag node CI will publish, flagged pending; the sequencer pins the digest
      spec: { name: "canary", image: PENDING, imagePending: true },
    });
  });

  it("reads the node's secrets catalog at the sha and records the keys its workloads names (bug.5254)", async () => {
    const catalog = `secrets:
  - name: TOKS5_VENDOR_TOKEN
    tier: A2
    source: human
    workloads: [app]
    required: true
    category: Vendor
    description: Vendor token.
    steps: []
`;
    fetchFileText.mockImplementation(async ({ path: p }: { path: string }) =>
      p === ".cogni/repo-spec.yaml"
        ? REPO_SPEC
        : p === ".cogni/workloads/canary.yaml"
          ? CANARY_BUILT
          : p === ".cogni/secrets-catalog.yaml"
            ? catalog
            : null
    );
    expect((await post()).status).toBe(200);
    expect(fetchFileText).toHaveBeenCalledWith({
      owner: "cogni-dao",
      repo: "toks5",
      path: ".cogni/secrets-catalog.yaml",
      ref: SHA,
    });
    expect(recorded().spec.secretKeys).toContain("TOKS5_VENDOR_TOKEN");
  });

  it("refuses 422 secrets_catalog_refused on an invalid catalog, before any store write", async () => {
    fetchFileText.mockImplementation(async ({ path: p }: { path: string }) =>
      p === ".cogni/repo-spec.yaml"
        ? REPO_SPEC
        : p === ".cogni/workloads/canary.yaml"
          ? CANARY_BUILT
          : p === ".cogni/secrets-catalog.yaml"
            ? "secrets:\n  - name: K\n    tier: A2\n    source: agent\n    required: false\n    category: c\n    description: d\n    steps: []\n"
            : null
    );
    const response = await post();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "secrets_catalog_refused",
    });
    expect(recordRelease).not.toHaveBeenCalled();
  });

  describe("generating a catalog-declared source: agent key (bug.5254)", () => {
    const AGENT_CATALOG = `secrets:
  - name: TOKS5_EXECD_TOKEN
    tier: A2
    source: agent
    generate: { kind: hex, bytes: 32 }
    workloads: [app]
    required: true
    category: Sandbox
    description: Shared token.
    steps: []
  - name: TOKS5_OTHER_TOKEN
    tier: A2
    source: agent
    generate: { kind: hex, bytes: 16 }
    required: true
    category: Sandbox
    description: Not projected, so never generated.
    steps: []
`;
    const servesCatalog = () =>
      fetchFileText.mockImplementation(async ({ path: p }: { path: string }) =>
        p === ".cogni/repo-spec.yaml"
          ? REPO_SPEC
          : p === ".cogni/workloads/canary.yaml"
            ? CANARY_BUILT
            : p === ".cogni/secrets-catalog.yaml"
              ? AGENT_CATALOG
              : null
      );
    const gateWith = (mayGenerate: boolean) =>
      gate.mockResolvedValue({
        ok: true,
        node: { id: TOKS5_ID, slug: "toks5" },
        catalogRow: TOKS5_ROW,
        mayGenerateSecrets: async () => mayGenerate,
      });

    it("creates only the release's missing agent keys, in the lane bucket, before the release row", async () => {
      servesCatalog();
      gateWith(true);
      const order: string[] = [];
      ensureGeneratedKeys.mockImplementation(async () => {
        order.push("generate");
        return { generated: ["TOKS5_EXECD_TOKEN"], version: 4 };
      });
      recordRelease.mockImplementationOnce(async (input: { spec: unknown }) => {
        order.push("record");
        return {
          release: {
            id: "11111111-1111-4111-8111-111111111111",
            spec: input.spec,
          },
          desired: { state: "running" },
        };
      });
      expect((await post()).status).toBe(200);
      expect(ensureGeneratedKeys).toHaveBeenCalledWith({
        env: "candidate-a",
        nodeSlug: "toks5",
        recipes: { TOKS5_EXECD_TOKEN: { kind: "hex", bytes: 32 } },
      });
      expect(order).toEqual(["generate", "record"]);
      expect(recorded().spec.secretKeys).toContain("TOKS5_EXECD_TOKEN");
    });

    it("writes nothing when the caller may not manage the node's secrets; the release still records", async () => {
      servesCatalog();
      gateWith(false);
      expect((await post()).status).toBe(200);
      expect(ensureGeneratedKeys).not.toHaveBeenCalled();
      expect(recordRelease).toHaveBeenCalledTimes(1);
    });

    it("writes nothing when the declaration is refused", async () => {
      servesCatalog();
      gateWith(true);
      fetchFileText.mockImplementation(async ({ path: p }: { path: string }) =>
        p === ".cogni/repo-spec.yaml"
          ? REPO_SPEC
          : p === ".cogni/workloads/canary.yaml"
            ? CANARY_BUILT.replace('"false"', '"true"')
            : p === ".cogni/secrets-catalog.yaml"
              ? AGENT_CATALOG
              : null
      );
      expect((await post()).status).toBe(422);
      expect(ensureGeneratedKeys).not.toHaveBeenCalled();
      expect(recordRelease).not.toHaveBeenCalled();
    });

    it("refuses 503 secret_generation_failed with no release row when the writer fails", async () => {
      servesCatalog();
      gateWith(true);
      ensureGeneratedKeys.mockRejectedValue(
        Object.assign(new Error("x"), { code: "openbao_login_failed" })
      );
      const response = await post();
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "secret_generation_failed",
      });
      expect(recordRelease).not.toHaveBeenCalled();
    });
  });

  it("decides both lane refusals from the catalog row the gate returned, for the requested env and node", async () => {
    expect((await post("preview")).status).toBe(200);
    expect(envNotServed).toHaveBeenCalledWith("preview", TOKS5_ID, TOKS5_ROW);
    expect(nodeNotOnDeployVerb).toHaveBeenCalledWith(
      "preview",
      TOKS5_ID,
      TOKS5_ROW
    );
  });

  it("returns the env_not_served refusal before any GitHub read or write", async () => {
    envNotServed.mockReturnValue(
      NextResponse.json(
        { error: "env_not_served", served: ["candidate-a"] },
        { status: 409 }
      )
    );
    const response = await post();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "env_not_served",
    });
    expect(fetchFileText).not.toHaveBeenCalled();
    expect(recordRelease).not.toHaveBeenCalled();
  });

  it("refuses 409 node_not_on_deploy_verb (CD4) before any GitHub read or write, so the verb never races another writer", async () => {
    nodeNotOnDeployVerb.mockReturnValue(
      NextResponse.json({ error: "node_not_on_deploy_verb" }, { status: 409 })
    );
    const response = await post();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "node_not_on_deploy_verb",
    });
    expect(fetchFileText).not.toHaveBeenCalled();
    expect(recordRelease).not.toHaveBeenCalled();
  });

  it("keeps a manifest image that is already digest-pinned as is: not pending", async () => {
    repoServes(CANARY);
    const response = await post();
    expect(response.status).toBe(200);
    expect(recorded().spec.image).toBe(CANARY_IMAGE());
    expect(recorded().spec.imagePending).toBeUndefined();
  });

  it("keeps an in-repo node (the operator) on the parent repo and refuses an image of '.' (no image repository to defer to)", async () => {
    gate.mockResolvedValue({
      ok: true,
      node: { id: NODE_ID, slug: "operator" },
      catalogRow: { name: "operator" },
    });
    repoServes(CANARY_BUILT, OPERATOR_REPO_SPEC);
    const response = await post();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "workload_manifest_refused",
      issues: [{ code: "built_image_unresolved" }],
    });
    expect(fetchFileText.mock.calls[0]?.[0]).toMatchObject({
      owner: "cogni-dao",
      repo: "cogni",
    });
    expect(recordRelease).not.toHaveBeenCalled();

    repoServes(OPERATOR_CANARY, OPERATOR_REPO_SPEC);
    expect((await post()).status).toBe(200);
  });

  it("refuses a repo-spec that names another node (node_mismatch) before any write", async () => {
    // toks5 is in the catalog, but the repo at this sha declares the operator's node id.
    repoServes(CANARY_BUILT, OPERATOR_REPO_SPEC);
    const response = await post();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "node_mismatch",
    });
    expect(recordRelease).not.toHaveBeenCalled();
  });

  it("returns 404 catalog_missing when the image catalog does not know the node", async () => {
    gate.mockResolvedValue({
      ok: true,
      node: { id: "00000000-0000-4000-8000-000000000000", slug: "ghost" },
      catalogRow: undefined,
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

/** The digest-pinned image the checked-in canary manifest declares. */
function CANARY_IMAGE(): string {
  return /^ {4}image: (.*)$/m.exec(CANARY)?.[1]?.trim() ?? "";
}

describe("image catalog source resolution (the route's resolver)", () => {
  const parent = {
    parentOwner: "cogni-test-org",
    parentRepo: "cogni-monorepo",
  };

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
