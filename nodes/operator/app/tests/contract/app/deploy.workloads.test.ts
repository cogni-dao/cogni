// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.workloads`
 * Purpose: Contract tests for POST/GET /api/v1/deploy/workloads (task.5400, story.5137): per-env authz,
 *   the repo-spec and the workload manifests read AT the sha through the GitHub App seam, refused
 *   manifests write nothing, intent-only writes, state create-once.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production -> `node.promote_production`; candidate-a/preview ->
 *     `node.manage_envs`; a denial reads nothing from GitHub and writes nothing.
 *   - NODE_DEPLOYS_FROM_ITS_OWN_REPO: the repo is the catalog-resolved `resolveNodeSource`; the
 *     operator is in-repo, so the parent repo (the remote-source case lives in the route's own test).
 *   - INTENT_ONLY: 200 means a release was recorded; this route never pays or touches DNS.
 * Side-effects: none
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const SHA = "a".repeat(40);
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../.."
);
const ROOT_SPEC = readFileSync(
  path.join(ROOT, ".cogni/repo-spec.yaml"),
  "utf8"
);
const CANARY_PATH = ".cogni/workloads/canary.yaml";
const CANARY = readFileSync(path.join(ROOT, CANARY_PATH), "utf8");

const plane = vi.hoisted(() => ({
  resolveNodeSource: vi.fn(),
  fetchFileText: vi.fn(),
  listDirectoryEntries: vi.fn(),
}));
const files = vi.hoisted(() => ({ byPath: new Map<string, string>() }));
const store = vi.hoisted(() => ({
  recordRelease: vi.fn(),
  getDesired: vi.fn(),
  listDesired: vi.fn(),
  attemptsFor: vi.fn(),
  getRelease: vi.fn(),
}));
const authz = vi.hoisted(() => ({ check: vi.fn(), present: true }));
const dbState = vi.hoisted(() => ({
  node: null as { id: string; slug: string } | null,
  billing: null as { id: string } | null,
  call: 0,
}));
const envState = vi.hoisted(() => ({
  NODE_SUBMODULE_PARENT_OWNER: "test-owner" as string | undefined,
  NODE_SUBMODULE_PARENT_REPO: "test-repo" as string | undefined,
  DEPLOY_ENVIRONMENT: "production" as string | undefined,
}));
const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const mockDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          const first = dbState.call === 0;
          dbState.call += 1;
          if (first) return dbState.node ? [dbState.node] : [];
          return dbState.billing ? [dbState.billing] : [];
        },
      }),
    }),
  }),
};

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => plane,
}));
vi.mock("@/bootstrap/capabilities/node-deploy-store", () => ({
  createNodeDeployStore: () => store,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2026-11-02T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    authorization: authz.present ? { check: authz.check } : undefined,
  }),
  resolveServiceDb: () => mockDb,
}));
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attrs: Record<string, string>,
    handler: (ctx: {
      traceId: string;
      span: { setAttribute: () => void };
    }) => Promise<unknown>
  ) => handler({ traceId: "trace-1", span: { setAttribute: vi.fn() } }),
}));
vi.mock("@/shared/env", () => ({ serverEnv: () => envState }));
const operatorNode = vi.hoisted(() => ({
  id: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
}));
vi.mock("@/shared/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/config")>();
  return { ...actual, getNodeId: () => operatorNode.id };
});
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));
vi.mock("@/shared/observability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  return {
    ...actual,
    createRequestContext: () => ({
      log: mockLog,
      reqId: "req-1",
      routeId: "deploy.workloads",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as appHandler from "@/app/api/v1/deploy/workloads/route";

async function call(
  method: "POST" | "GET",
  body?: unknown,
  query = ""
): Promise<Response> {
  let res!: Response;
  await testApiHandler({
    appHandler,
    url: `/api/v1/deploy/workloads${query}`,
    async test({ fetch }) {
      res = await fetch({
        method,
        ...(method === "POST"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
    },
  });
  return res;
}

const post = (body: unknown) => call("POST", body);
const valid = {
  nodeId: NODE_ID,
  env: "production",
  workload: "canary",
  sourceSha: SHA,
};

describe("/api/v1/deploy/workloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.node = { id: NODE_ID, slug: "operator" };
    dbState.billing = { id: "billing-1" };
    dbState.call = 0;
    authz.present = true;
    authz.check.mockResolvedValue({ decision: "allow", code: "authz_allowed" });
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    envState.NODE_SUBMODULE_PARENT_OWNER = "test-owner";
    envState.NODE_SUBMODULE_PARENT_REPO = "test-repo";
    envState.DEPLOY_ENVIRONMENT = "production";
    files.byPath = new Map([
      [".cogni/repo-spec.yaml", ROOT_SPEC],
      [CANARY_PATH, CANARY],
    ]);
    // The operator is an in-repo node: its source is the parent repo and it has no image repository.
    plane.resolveNodeSource.mockResolvedValue({
      owner: "test-owner",
      repo: "test-repo",
      imageRepository: null,
    });
    plane.fetchFileText.mockImplementation(
      async ({ path: p }: { path: string }) => files.byPath.get(p) ?? null
    );
    plane.listDirectoryEntries.mockResolvedValue([
      { name: "canary.yaml", type: "file" },
    ]);
    store.getDesired.mockResolvedValue(undefined);
    store.recordRelease.mockImplementation(async (input) => ({
      release: { id: "6b564b98-7a28-4a7f-8b17-c65a1b3e2c96", ...input },
      desired: {
        state: "running",
        releaseId: "6b564b98-7a28-4a7f-8b17-c65a1b3e2c96",
      },
    }));
  });

  describe("POST", () => {
    it("401 when unauthenticated", async () => {
      mockGetSessionUser.mockResolvedValue(null);
      expect((await post(valid)).status).toBe(401);
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it.each([
      ["a short sha", { ...valid, sourceSha: "abc123" }],
      ["a branch name", { ...valid, sourceSha: "main" }],
      ["an unknown env", { ...valid, env: "dev" }],
      ["an unknown key", { ...valid, extra: 1 }],
      ["a bad workload name", { ...valid, workload: "Canary_DB" }],
    ])("400 for %s", async (_name, body) => {
      expect((await post(body)).status).toBe(400);
      expect(plane.fetchFileText).not.toHaveBeenCalled();
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("404 for an unknown node", async () => {
      dbState.node = null;
      const res = await post(valid);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "node_not_found" });
    });

    it("403 and no GitHub read, no write when authz denies", async () => {
      authz.check.mockResolvedValue({ decision: "deny", code: "authz_denied" });
      const res = await post(valid);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "authz_denied" });
      expect(plane.fetchFileText).not.toHaveBeenCalled();
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("503 when authorization is unavailable (fail closed)", async () => {
      authz.present = false;
      expect((await post(valid)).status).toBe(503);
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("production is gated on node.promote_production; candidate-a and preview on node.manage_envs", async () => {
      await post(valid);
      expect(authz.check).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: "node.promote_production",
          resource: `node:${NODE_ID}`,
        })
      );
      for (const env of ["candidate-a", "preview"]) {
        dbState.call = 0;
        envState.DEPLOY_ENVIRONMENT = env;
        await post({ ...valid, env });
        expect(authz.check).toHaveBeenLastCalledWith(
          expect.objectContaining({ action: "node.manage_envs" })
        );
      }
    });

    it("records a release from the declaration READ AT THE SHA and returns only the release id", async () => {
      const res = await post(valid);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        releaseId: "6b564b98-7a28-4a7f-8b17-c65a1b3e2c96",
        nodeId: NODE_ID,
        env: "production",
        workload: "canary",
        sourceSha: SHA,
        desiredState: "running",
      });
      expect(plane.resolveNodeSource).toHaveBeenCalledWith({
        parentOwner: "test-owner",
        parentRepo: "test-repo",
        slug: "operator",
      });
      expect(plane.fetchFileText).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        path: ".cogni/repo-spec.yaml",
        ref: SHA,
      });
      expect(plane.listDirectoryEntries).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        path: ".cogni/workloads",
        ref: SHA,
      });
      expect(plane.fetchFileText).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        path: CANARY_PATH,
        ref: SHA,
      });
      const input = store.recordRelease.mock.calls[0]?.[0];
      expect(input).toMatchObject({
        nodeId: NODE_ID,
        env: "production",
        workload: "canary",
        sourceSha: SHA,
        createdBy: `user:${TEST_SESSION_USER_1.id}`,
      });
      expect(input.spec.expose.http.host).toBe(
        "node-deploy-canary.cognidao.org"
      );
    });

    it("candidate-a releases carry the -test host", async () => {
      envState.DEPLOY_ENVIRONMENT = "candidate-a";
      await post({ ...valid, env: "candidate-a" });
      expect(store.recordRelease.mock.calls[0]?.[0].spec.expose.http.host).toBe(
        "node-deploy-canary-test.cognidao.org"
      );
    });

    it("404 for an undeclared workload; 422 when the repo-spec belongs to another node; 422 when absent at the sha", async () => {
      expect((await post({ ...valid, workload: "nope" })).status).toBe(404);
      dbState.call = 0;
      dbState.node = {
        id: "00000000-0000-4000-8000-000000000001",
        slug: "other",
      };
      const mismatch = await post(valid);
      expect(mismatch.status).toBe(422);
      expect((await mismatch.json()).error).toBe("node_mismatch");
      dbState.call = 0;
      dbState.node = { id: NODE_ID, slug: "operator" };
      files.byPath.delete(".cogni/repo-spec.yaml");
      expect((await post(valid)).status).toBe(422);
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("422 workload_manifest_refused with every issue, and no write, for a refused manifest", async () => {
      files.byPath.set(
        CANARY_PATH,
        CANARY.replace(
          'cogni.dev/exclusive: "false"',
          'cogni.dev/exclusive: "true"'
        ).replace("python:3.12-alpine@sha256:", "python:3.12-alpine@x")
      );
      const res = await post(valid);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("workload_manifest_refused");
      expect(body.issues.map((i: { code: string }) => i.code)).toEqual(
        expect.arrayContaining([
          "exclusive_unsupported",
          "image_not_digest_pinned",
        ])
      );
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("404 when the node has no .cogni/workloads directory at the sha", async () => {
      plane.listDirectoryEntries.mockResolvedValue(null);
      expect((await post(valid)).status).toBe(404);
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("422 for a .yml file or a subdirectory in .cogni/workloads: refused, never skipped", async () => {
      plane.listDirectoryEntries.mockResolvedValue([
        { name: "canary.yaml", type: "file" },
        { name: "worker.yml", type: "file" },
        { name: "nested", type: "dir" },
      ]);
      const res = await post(valid);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("workload_manifest_refused");
      expect(body.issues.map((i: { path: string }) => i.path)).toEqual([
        ".cogni/workloads/worker.yml",
        ".cogni/workloads/nested",
      ]);
      expect(plane.fetchFileText).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: CANARY_PATH })
      );
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("422 with an issues array when .cogni/workloads holds more than 16 entries", async () => {
      plane.listDirectoryEntries.mockResolvedValue(
        Array.from({ length: 17 }, (_, i) => ({
          name: `w${i}.yaml`,
          type: "file",
        }))
      );
      const res = await post(valid);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("workload_manifest_refused");
      expect(body.issues).toEqual([
        expect.objectContaining({ code: "too_many_manifests" }),
      ]);
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("502 when a listed manifest reads as absent at the sha (a failed read, never a skip)", async () => {
      files.byPath.delete(CANARY_PATH);
      const res = await post(valid);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("declaration_read_failed");
      expect(body.message).not.toContain("listed but unreadable");
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("502 when the GitHub read fails", async () => {
      plane.fetchFileText.mockRejectedValue(
        new Error("github down: Bad credentials for sekrit")
      );
      const res = await post(valid);
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).not.toContain("sekrit");
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("409 env_not_served for an env other than this deployment's DEPLOY_ENVIRONMENT; nothing is read or written (CD4)", async () => {
      for (const env of ["candidate-a", "preview"]) {
        dbState.call = 0;
        const res = await post({ ...valid, env });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({
          error: "env_not_served",
          served: "production",
        });
      }
      expect(plane.fetchFileText).not.toHaveBeenCalled();
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("503 when the deployment does not say which env it serves (fail closed)", async () => {
      envState.DEPLOY_ENVIRONMENT = undefined;
      const res = await post(valid);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "deploy_environment_not_configured",
      });
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("409 for a state workload that already exists; a state lease is never replaced by a deploy", async () => {
      store.getDesired.mockResolvedValue({ state: "running" });
      const res = await post({ ...valid, workload: "canary-db" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "state_workload_exists" });
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("an app workload may be re-released freely", async () => {
      store.getDesired.mockResolvedValue({ state: "running" });
      expect((await post(valid)).status).toBe(200);
    });

    it("G4: 422 state_admission_refused for a new production state other than canary-db", async () => {
      files.byPath.set(
        CANARY_PATH,
        CANARY.replace("id: canary-db", "id: other-db")
      );
      const res = await post({ ...valid, workload: "other-db" });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe("state_admission_refused");
      expect(store.getDesired).not.toHaveBeenCalled();
      expect(store.recordRelease).not.toHaveBeenCalled();
    });

    it("G4: canary-db is admitted only for the operator's own node", async () => {
      operatorNode.id = "00000000-0000-4000-8000-0000000000aa";
      try {
        const res = await post({ ...valid, workload: "canary-db" });
        expect(res.status).toBe(422);
        expect((await res.json()).error).toBe("state_admission_refused");
        expect(store.recordRelease).not.toHaveBeenCalled();
      } finally {
        operatorNode.id = NODE_ID;
      }
    });

    it("G4 is production-only: candidate-a admits a new state", async () => {
      envState.DEPLOY_ENVIRONMENT = "candidate-a";
      files.byPath.set(
        CANARY_PATH,
        CANARY.replace("id: canary-db", "id: other-db")
      );
      const res = await post({
        ...valid,
        env: "candidate-a",
        workload: "other-db",
      });
      expect(res.status).toBe(200);
      expect(store.recordRelease.mock.calls[0]?.[0].spec.kind).toBe("state");
    });
  });

  describe("GET", () => {
    it("returns desired, the active attempt and recent attempts", async () => {
      const desired = {
        nodeId: NODE_ID,
        env: "production",
        workload: "canary",
        state: "running",
        releaseId: "r1",
      };
      store.listDesired.mockResolvedValue([
        desired,
        { ...desired, workload: "other-node-row", nodeId: "someone-else" },
      ]);
      store.attemptsFor.mockResolvedValue([
        { attempt: 2, phase: "active", externalName: "222" },
        { attempt: 1, phase: "retiring", externalName: "111" },
      ]);
      store.getRelease.mockResolvedValue({ sourceSha: SHA });
      const res = await call(
        "GET",
        undefined,
        `?nodeId=${NODE_ID}&env=production`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workloads).toHaveLength(1);
      expect(body.workloads[0]).toMatchObject({
        workload: "canary",
        desired: { state: "running", releaseId: "r1", sourceSha: SHA },
        active: { attempt: 2, phase: "active" },
      });
      expect(body.workloads[0].recentAttempts).toHaveLength(2);
    });

    it("GET refuses an env this deployment does not serve and lists only the served env", async () => {
      const res = await call(
        "GET",
        undefined,
        `?nodeId=${NODE_ID}&env=preview`
      );
      expect(res.status).toBe(409);
      expect(store.listDesired).not.toHaveBeenCalled();
      store.listDesired.mockResolvedValue([]);
      dbState.call = 0;
      await call("GET", undefined, `?nodeId=${NODE_ID}&env=production`);
      expect(store.listDesired).toHaveBeenCalledWith("production");
    });

    it("applies the same authz gate and 400s a missing env", async () => {
      authz.check.mockResolvedValue({ decision: "deny", code: "authz_denied" });
      expect(
        (await call("GET", undefined, `?nodeId=${NODE_ID}&env=production`))
          .status
      ).toBe(403);
      expect((await call("GET", undefined, `?nodeId=${NODE_ID}`)).status).toBe(
        400
      );
      expect(store.listDesired).not.toHaveBeenCalled();
    });
  });
});
