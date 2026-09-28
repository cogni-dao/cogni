// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/envs` (test)
 * Purpose: Pin the env verb's request schema — `present` (deploy reach) and `placement` (serving
 *   lane, story.5016 T5) are MUTUALLY EXCLUSIVE, both dispatch under the SAME `node.manage_envs`
 *   gate, and each routes to its own writer (`openNodeEnvPr` / `openNodePlacementPr`), plus
 *   EVIDENCE_OR_REFUSE (task.5132): an ADD 503s without ledger evidence; a REMOVE degrades.
 * Scope: Unit tests over mocked session/env/db/authz/writer — no IO.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/envs/route.ts
 * @public
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.fn();
const openNodeEnvPr = vi.fn();
const openNodePlacementPr = vi.fn();
const listAllocated = vi.fn();
const listReceipts = vi.fn();

const NODE = {
  id: "123e4567-e89b-12d3-a456-426614174001",
  slug: "blue",
  deployEnvs: ["candidate-a", "preview"],
  activityEnv: "candidate-a",
};

/** Container stub holder — tests flip `leaseReadCapability` per case. */
const container: { leaseReadCapability: unknown } = {
  leaseReadCapability: undefined,
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
  getContainer: () => container,
}));
// Passthrough logging wrapper (same pattern as compute/deployments route.test.ts): the
// exclusion/schema tests below exercise the HANDLER; the wrapper's own envelope is pinned by
// wrapRouteHandlerWithLogging's tests.
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      handler(
        { log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
        request,
        { id: "user-1" },
        context
      ),
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
    }) as NextRequest,
    { params: Promise.resolve({ id: NODE.id }) }
  );
};

describe("POST /api/v1/nodes/[id]/envs — schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // EVIDENCE_OR_REFUSE (task.5132): an ADD refuses without a readable ledger, so even the
    // schema-level happy paths must wire the capability (an empty ledger = generation 0).
    listAllocated.mockResolvedValue([]);
    listReceipts.mockResolvedValue([]);
    container.leaseReadCapability = { listAllocated, listReceipts };
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

  it("surfaces the writer's derived activation shape on present:true (ADD_DERIVES_PLACEMENT)", async () => {
    const derived = {
      placement: "akash",
      computeApi: "crossplane",
      controlEnv: "production",
      leaseGeneration: 0,
    };
    openNodeEnvPr.mockResolvedValue({
      status: "pr_opened",
      action: "add",
      prNumber: 7,
      prUrl: "https://github.com/x/y/pull/7",
      derived,
    });
    const res = await post({ env: "production", present: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      present: true,
      derived,
    });
  });

  it("carries no derived field on a remove (present:false is not a derivation)", async () => {
    openNodeEnvPr.mockResolvedValue({ status: "no_changes" });
    const res = await post({ env: "preview", present: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("derived");
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

describe("POST /api/v1/nodes/[id]/envs — money loop (story.5039 PR-B)", () => {
  const RECEIPT = {
    receiptId: "r-1",
    cogniKey: "xcw:cogni-preview-blue:blue:0",
    identity: {
      nodeId: NODE.id,
      compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
      compositeGeneration: 0,
    },
    environment: "preview",
    state: "allocated",
    externalName: "7001",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue({ ok: true });
    openNodeEnvPr.mockResolvedValue({
      status: "pr_opened",
      action: "remove",
      prNumber: 9,
      prUrl: "https://github.com/x/y/pull/9",
    });
    openNodePlacementPr.mockResolvedValue({ status: "no_changes" });
    listAllocated.mockResolvedValue([RECEIPT]);
    listReceipts.mockResolvedValue([RECEIPT]);
    container.leaseReadCapability = { listAllocated, listReceipts };
  });

  it("present:false enumerates the env's live paid leases BEFORE the PR and embeds openLeases + verify", async () => {
    const res = await post({ env: "preview", present: false });
    expect(res.status).toBe(200);
    // Enumeration is (node, env)-filtered — the receipts THIS remove's prune chain must close.
    expect(listAllocated).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE.id, environment: "preview" })
    );
    expect(listReceipts).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      present: false,
      openLeases: [
        {
          environment: "preview",
          cogniKey: RECEIPT.cogniKey,
          state: "allocated",
          externalName: "7001",
        },
      ],
      verify: `/api/v1/nodes/${NODE.id}/deploy-state`,
    });
  });

  it("present:false with the ledger unwired embeds openLeases: null (distinct from []) + verify", async () => {
    container.leaseReadCapability = undefined;
    const res = await post({ env: "preview", present: false });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      openLeases: null,
      verify: `/api/v1/nodes/${NODE.id}/deploy-state`,
    });
  });

  it("present:true derives leaseGeneration from EVERY-state receipts (listReceipts, not listAllocated)", async () => {
    listReceipts.mockResolvedValue([
      { ...RECEIPT, state: "released", environment: "candidate-a" },
      {
        ...RECEIPT,
        cogniKey: "xcw:cogni-candidate-a-blue:blue:2",
        state: "allocated",
        environment: "candidate-a",
        // Kubernetes reconciliation revision is unrelated to the lease replacement ordinal.
        identity: { ...RECEIPT.identity, compositeGeneration: 99 },
      },
    ]);
    const res = await post({ env: "candidate-a", present: true });
    expect(res.status).toBe(200);
    // The ADD read is (node, env)-scoped and state-unfiltered — the terminal evidence lives
    // outside the allocated-only money-loop view (task.5132).
    expect(listReceipts).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE.id, environment: "candidate-a" })
    );
    expect(listAllocated).not.toHaveBeenCalled();
    // GENERATION_IS_NOT_CALLER_INPUT: the body carried nothing; the ledger evidence did.
    // released gen-0 is terminal (→ 1); the live allocated gen-2 lease pins the max at 2.
    expect(openNodeEnvPr).toHaveBeenCalledWith(
      expect.objectContaining({
        env: "candidate-a",
        present: true,
        leaseGeneration: 2,
      })
    );
  });

  it("present:true over a terminally FAILED gen-0 receipt derives leaseGeneration 1 (task.5132)", async () => {
    // The live incident's shape: env-verb ADD derived 0 while a failed gen-0 receipt existed,
    // so the recreated XR presented the spent key and the actuator refused it with
    // `akash_tx_identity_conflict`. The VERB must emit the bump.
    listReceipts.mockResolvedValue([
      { ...RECEIPT, state: "failed", environment: "candidate-a" },
    ]);
    await post({ env: "candidate-a", present: true });
    expect(openNodeEnvPr).toHaveBeenCalledWith(
      expect.objectContaining({ leaseGeneration: 1 })
    );
  });

  it("present:true with an empty ledger passes generation 0 (a birth-identical row)", async () => {
    listReceipts.mockResolvedValue([]);
    await post({ env: "candidate-a", present: true });
    expect(openNodeEnvPr).toHaveBeenCalledWith(
      expect.objectContaining({ leaseGeneration: 0 })
    );
  });

  it("present:true with the ledger UNWIRED refuses — 503 generation_evidence_unavailable, no PR (EVIDENCE_OR_REFUSE)", async () => {
    // The live incident's other half (task.5132): AKASH_ACTUATOR_ACCOUNT_ID unpinned →
    // leaseReadCapability undefined → the old fallback silently derived generation 0 and
    // authored a catalog PR carrying a spent key. The verb must refuse, not guess.
    container.leaseReadCapability = undefined;
    const res = await post({ env: "candidate-a", present: true });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "generation_evidence_unavailable",
    });
    expect(openNodeEnvPr).not.toHaveBeenCalled();
  });

  it("present:true with a FAILING ledger read refuses — 503 generation_evidence_unavailable, no PR", async () => {
    listReceipts.mockRejectedValue(new Error("db down"));
    const res = await post({ env: "candidate-a", present: true });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "generation_evidence_unavailable",
    });
    expect(openNodeEnvPr).not.toHaveBeenCalled();
  });

  it("a ledger read failure degrades (openLeases: null), it does not block the remove", async () => {
    listAllocated.mockRejectedValue(new Error("db down"));
    const res = await post({ env: "preview", present: false });
    expect(res.status).toBe(200);
    expect(openNodeEnvPr).toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ openLeases: null });
  });

  it("the placement verb never touches the ledger", async () => {
    await post({ env: "preview", placement: "akash" });
    expect(listAllocated).not.toHaveBeenCalled();
    expect(listReceipts).not.toHaveBeenCalled();
  });
});
