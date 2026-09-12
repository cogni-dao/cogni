// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/envs` (test)
 * Purpose: Pin the env verb's request schema — `present` (deploy reach) and `placement` (serving
 *   lane, story.5016 T5) are MUTUALLY EXCLUSIVE, both dispatch under the SAME `node.manage_envs`
 *   gate, and each routes to its own writer (`openNodeEnvPr` / `openNodePlacementPr`).
 * Scope: Unit tests over mocked session/env/db/authz/writer — no IO.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/envs/route.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.fn();
const openNodeEnvPr = vi.fn();
const openNodePlacementPr = vi.fn();

const NODE = {
  id: "123e4567-e89b-12d3-a456-426614174001",
  slug: "blue",
  deployEnvs: ["candidate-a", "preview"],
  activityEnv: "candidate-a",
};

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: authorize,
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64: "a2V5",
    NODE_SUBMODULE_PARENT_OWNER: "cogni-dao",
    NODE_SUBMODULE_PARENT_REPO: "cogni-template",
  }),
}));
vi.mock("@/bootstrap/container", () => ({
  resolveServiceDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [NODE] }),
      }),
    }),
  }),
}));
vi.mock("@/bootstrap/capabilities/node-repo-write", () => ({
  createNodeRepoWriter: () => ({ openNodeEnvPr, openNodePlacementPr }),
}));
vi.mock("@/features/nodes/node-lookup", () => ({ nodeIdOrSlug: () => ({}) }));
vi.mock("@/shared/db/nodes", () => ({ nodes: {} }));

const post = async (body: unknown): Promise<Response> => {
  const { POST } = await import("./route");
  return POST(
    new Request(`https://operator.example/api/v1/nodes/${NODE.id}/envs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: NODE.id }) }
  );
};

describe("POST /api/v1/nodes/[id]/envs — schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue({ ok: true });
    openNodeEnvPr.mockResolvedValue({ status: "no_changes" });
    openNodePlacementPr.mockResolvedValue({ status: "no_changes" });
  });

  it("rejects a body carrying BOTH present and placement (mutually exclusive verbs)", async () => {
    const res = await post({
      env: "preview",
      present: true,
      placement: "akash",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid body" });
    expect(openNodeEnvPr).not.toHaveBeenCalled();
    expect(openNodePlacementPr).not.toHaveBeenCalled();
  });

  it("rejects a body carrying NEITHER present nor placement", async () => {
    const res = await post({ env: "preview" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid body" });
  });

  it("rejects an unknown placement value", async () => {
    const res = await post({ env: "preview", placement: "fly" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "invalid placement",
    });
  });

  it("rejects an unknown env", async () => {
    const res = await post({ env: "staging", placement: "akash" });
    expect(res.status).toBe(400);
  });

  it("dispatches {env, placement} to openNodePlacementPr under node.manage_envs", async () => {
    // Deliberately targets the ACTIVITY env: placement is a lane switch, not a removal, so the
    // activity_authority_cutover_required guard must NOT fire.
    const res = await post({ env: "candidate-a", placement: "akash" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      env: "candidate-a",
      placement: "akash",
      result: { status: "no_changes" },
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ action: "node.manage_envs" })
    );
    expect(openNodePlacementPr).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: NODE.slug,
        env: "candidate-a",
        placement: "akash",
      })
    );
    expect(openNodeEnvPr).not.toHaveBeenCalled();
  });

  it("still dispatches {env, present} to openNodeEnvPr (reach verb unchanged)", async () => {
    const res = await post({ env: "production", present: true });
    expect(res.status).toBe(200);
    expect(openNodeEnvPr).toHaveBeenCalledWith(
      expect.objectContaining({ env: "production", present: true })
    );
    expect(openNodePlacementPr).not.toHaveBeenCalled();
  });

  it("maps a typed writer failure (akash_requires_source_repo) onto its status + code", async () => {
    openNodePlacementPr.mockRejectedValue(
      Object.assign(new Error("no source_repo"), {
        code: "akash_requires_source_repo",
        status: 422,
      })
    );
    const res = await post({ env: "preview", placement: "akash" });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "akash_requires_source_repo",
    });
  });

  it("maps a typed writer failure (akash_requires_deployment_block) onto its status + code", async () => {
    openNodePlacementPr.mockRejectedValue(
      Object.assign(new Error("no declared deployment block"), {
        code: "akash_requires_deployment_block",
        status: 422,
      })
    );
    const res = await post({ env: "preview", placement: "akash" });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "akash_requires_deployment_block",
    });
  });

  it("fails closed when authorization is denied — placement included", async () => {
    authorize.mockResolvedValue({
      ok: false,
      errorCode: "authz_denied",
      status: 403,
    });
    const res = await post({ env: "preview", placement: "akash" });
    expect(res.status).toBe(403);
    expect(openNodePlacementPr).not.toHaveBeenCalled();
  });
});
