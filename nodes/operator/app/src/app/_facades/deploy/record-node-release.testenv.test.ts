// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/record-node-release` (test envs)
 * Purpose: Pin how the one release writer records a TEST ENV (story.5159): under the new key and own host, never
 *   superseding `app`; the 409 cap counts running rows and stopped rows with an open lease; the post-insert recount
 *   closes the race; refused copies write nothing; and the v1 path (no `testEnv`) is unchanged.
 * Scope: The REAL facade, `test-env.ts` and the in-memory store fake; mocked IO (source resolver, declaration reader,
 *   declaration resolution, catalog, secrets plane, env).
 * Side-effects: none
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canaryApp,
  FakeClock,
  MemoryStore,
  NODE_ID,
} from "@/features/node-deploy/testing";

const SHA = "a".repeat(40);
const NODE = { id: NODE_ID, slug: "red" };
const ENV = "candidate-a";
const MIN = 60_000;

const clock = new FakeClock();
const state = vi.hoisted(() => ({
  store: undefined as unknown,
  spec: undefined as unknown,
}));
const resolveDecl = vi.fn();

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    NODE_SUBMODULE_PARENT_OWNER: "cogni-dao",
    NODE_SUBMODULE_PARENT_REPO: "cogni",
    NODE_DEPLOY_WORKLOAD_ZONE: "cognidao.org",
    DEPLOY_ENVIRONMENT: "candidate-a",
  }),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => "other-operator-id" }));
vi.mock("@/bootstrap/capabilities/node-deploy-store", () => ({
  createNodeDeployStore: () => state.store,
}));
vi.mock("@/bootstrap/capabilities/node-catalog", () => ({
  createNodeCatalog: () => ({
    entryFor: async () => ({ slug: "red", row: {} }),
  }),
}));
vi.mock("@/bootstrap/capabilities/node-source-resolver", () => ({
  createNodeSourceResolver: () => ({
    resolveNodeSource: async () => ({
      owner: "cogni-dao",
      repo: "red",
      imageRepository: "ghcr.io/cogni-dao/red",
    }),
  }),
  createDeclarationReader: () => ({}),
}));
vi.mock("@/bootstrap/capabilities/operator-secrets-plane", () => ({
  createOperatorSecretsPlane: () => ({ ensureGeneratedKeys: vi.fn() }),
}));
vi.mock("@/features/node-deploy/read-declarations", () => ({
  readWorkloadDeclarations: async () => ({
    kind: "ok",
    repoSpecText: "",
    manifests: [],
    secretsCatalogText: null,
  }),
}));
vi.mock("@/features/node-deploy/declarations", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/node-deploy/declarations")
  >()),
  resolveWorkloadDeclaration: (...args: unknown[]) => resolveDecl(...args),
  generatedSecretRecipes: () => ({}),
}));

import { recordNodeRelease } from "./record-node-release.server";

const log = { warn: vi.fn(), info: vi.fn() };
const app = (over: Record<string, unknown> = {}) =>
  canaryApp({
    name: "app",
    bindings: [],
    expose: { http: { host: "red-test.cognidao.org" } },
    ...over,
  });

let store: MemoryStore;

/** A test env row as the writer leaves it, `ageMin` minutes old, with optional attempt phases. */
async function seedTestEnv(
  workload: string,
  ageMin: number,
  opts: { stopped?: boolean; phases?: string[] } = {}
) {
  const { release } = await store.recordRelease({
    nodeId: NODE_ID,
    env: ENV,
    workload,
    sourceSha: SHA,
    spec: app({ name: workload }),
    createdBy: "t",
  });
  const k = `${NODE_ID}/${ENV}/${workload}`;
  const row = store.desired.get(k);
  if (!row) throw new Error("fixture row missing");
  store.desired.set(k, {
    ...row,
    state: opts.stopped ? "stopped" : "running",
    updatedAt: new Date(clock.now() - ageMin * MIN),
  });
  for (const phase of opts.phases ?? [])
    store.attempts.push({ phase, releaseId: release.id } as never);
}

const post = (over: Record<string, unknown> = {}) =>
  recordNodeRelease({
    node: NODE,
    env: ENV,
    workload: "teqwkzmx",
    sourceSha: SHA,
    createdBy: "user:u1",
    log,
    testEnv: { key: "teqwkzmx", cap: 2 },
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  clock.t = 1_800_000_000_000;
  store = new MemoryStore(clock);
  state.store = store;
  resolveDecl.mockReturnValue(app());
});

describe("recordNodeRelease with testEnv", () => {
  it("records under the key and its own host, resolving the node's `app` manifest, and leaves `app` alone", async () => {
    await store.recordRelease({
      nodeId: NODE_ID,
      env: ENV,
      workload: "app",
      sourceSha: "b".repeat(40),
      spec: app(),
      createdBy: "t",
    });
    const result = await post({
      testEnv: { key: "teqwkzmx", label: "pr-7", cap: 2 },
    });
    expect(result).toMatchObject({
      ok: true,
      host: "red-teqwkzmx-test.cognidao.org",
    });
    expect(resolveDecl).toHaveBeenCalledWith(
      expect.objectContaining({ workload: "app", env: ENV })
    );
    const desired = await store.getDesired({
      nodeId: NODE_ID,
      env: ENV,
      workload: "teqwkzmx",
    });
    expect(desired?.state).toBe("running");
    const release = await store.getRelease(desired?.releaseId ?? "");
    expect(release?.spec.name).toBe("teqwkzmx");
    expect(release?.sourceSha).toBe(SHA);
    expect(release?.spec.env.COGNI_TEST_ENV_LABEL).toBe("pr-7");
    // the app lane is untouched: still its own release at its own SHA, not superseded
    const appRow = await store.getDesired({
      nodeId: NODE_ID,
      env: ENV,
      workload: "app",
    });
    expect((await store.getRelease(appRow?.releaseId ?? ""))?.sourceSha).toBe(
      "b".repeat(40)
    );
  });

  it("two requests for two SHAs make two rows; neither replaces the other", async () => {
    const a = await post({
      testEnv: { key: "teaaaaaa", cap: 2 },
      sourceSha: "1".repeat(40),
    });
    const b = await post({
      testEnv: { key: "tebbbbbb", cap: 2 },
      sourceSha: "2".repeat(40),
    });
    expect(a.ok && b.ok).toBe(true);
    const rows = (await store.listDesired(ENV)).map((d) => d.workload).sort();
    expect(rows).toEqual(["teaaaaaa", "tebbbbbb"]);
  });

  it("409 test_env_cap at the cap, and writes nothing", async () => {
    await seedTestEnv("teaaaaaa", 20);
    await seedTestEnv("tebbbbbb", 10);
    const result = await post({ testEnv: { key: "tecccccc", cap: 2 } });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      body: { error: "test_env_cap", cap: 2, running: 2 },
    });
    expect(
      await store.getDesired({
        nodeId: NODE_ID,
        env: ENV,
        workload: "tecccccc",
      })
    ).toBeUndefined();
  });

  it("a stopped env whose lease is still open still holds its slot; a closed one does not", async () => {
    await seedTestEnv("teaaaaaa", 20, { stopped: true, phases: ["active"] }); // closing
    await seedTestEnv("tebbbbbb", 10);
    expect(await post({ testEnv: { key: "tecccccc", cap: 2 } })).toMatchObject({
      ok: false,
      status: 409,
    });
    // once the lease is retired the slot is free
    store.attempts.length = 0;
    store.attempts.push({
      phase: "retired",
      releaseId: (
        await store.getDesired({
          nodeId: NODE_ID,
          env: ENV,
          workload: "teaaaaaa",
        })
      )?.releaseId,
    } as never);
    expect(await post({ testEnv: { key: "tecccccc", cap: 2 } })).toMatchObject({
      ok: true,
    });
  });

  it("a cap of 0 (a catalog row with no copies) refuses every request", async () => {
    expect(await post({ testEnv: { key: "teaaaaaa", cap: 0 } })).toMatchObject({
      ok: false,
      status: 409,
      body: { error: "test_env_cap", cap: 0 },
    });
  });

  it("closes the race: when both requests passed the count, the one ranked past the cap stops itself", async () => {
    await seedTestEnv("teaaaaaa", 30);
    await seedTestEnv("tebbbbbb", 20);
    // this request read the slots BEFORE the other two existed: its first count sees none
    const real = store.listDesired.bind(store);
    let calls = 0;
    store.listDesired = async (env: string) => (calls++ === 0 ? [] : real(env));
    const result = await post({ testEnv: { key: "tecccccc", cap: 2 } });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      body: { error: "test_env_cap", running: 2 },
    });
    const mine = await store.getDesired({
      nodeId: NODE_ID,
      env: ENV,
      workload: "tecccccc",
    });
    expect(mine?.state).toBe("stopped");
    expect(mine?.stop?.requestedBy).toBe("system:test-env-cap");
    // the two earlier envs are untouched
    for (const w of ["teaaaaaa", "tebbbbbb"])
      expect(
        (await store.getDesired({ nodeId: NODE_ID, env: ENV, workload: w }))
          ?.state
      ).toBe("running");
  });

  it.each([
    [
      "state bindings",
      { bindings: [{ env: "DATABASE_URL", workload: "x-db" }] },
    ],
    ["a worker", { runtimeProfile: "worker" }],
  ])("refuses to copy an app with %s: 422 and no row", async (_why, over) => {
    resolveDecl.mockReturnValue(app(over));
    expect(await post()).toMatchObject({
      ok: false,
      status: 422,
      body: { error: "test_env_unsupported" },
    });
    expect(await store.listDesired(ENV)).toEqual([]);
  });

  it("refuses the operator node", async () => {
    expect(
      await post({ node: { id: NODE_ID, slug: "operator" } })
    ).toMatchObject({
      ok: false,
      status: 422,
      body: { error: "test_env_node_refused" },
    });
  });
});

describe("recordNodeRelease without testEnv (v1)", () => {
  it("resolves the REQUESTED workload and records it under that name, with no host in the result", async () => {
    resolveDecl.mockReturnValue(app({ name: "canary" }));
    const result = await recordNodeRelease({
      node: NODE,
      env: ENV,
      workload: "canary",
      sourceSha: SHA,
      createdBy: "user:u1",
      log,
    });
    expect(result).toEqual({
      ok: true,
      releaseId: expect.any(String),
      desiredState: "running",
    });
    expect(result).not.toHaveProperty("host");
    expect(resolveDecl).toHaveBeenCalledWith(
      expect.objectContaining({ workload: "canary" })
    );
    expect((await store.listDesired(ENV)).map((d) => d.workload)).toEqual([
      "canary",
    ]);
  });
});
