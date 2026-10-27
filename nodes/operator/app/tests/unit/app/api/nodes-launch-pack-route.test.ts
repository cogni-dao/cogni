// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-launch-pack-route`
 * Purpose: Unit coverage for both versioned owner-gated launch transports.
 * Scope: Versioned wire compatibility, public-origin config and JSON auth/owner parity; mocks DB IO.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/launch-pack/route.ts
 * @internal
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  available: true,
  reads: [] as { sql: string; params: unknown[] }[],
  row: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "atlas",
    ownerUserId: "user-1",
    status: "published",
    publishPrUrl: "https://github.com/Cogni-DAO/cogni/pull/42",
  },
}));

const envState = vi.hoisted(() => ({
  APP_BASE_URL: "https://test.cognidao.org/" as string | undefined,
  NODE_MINT_OWNER: "Cogni-DAO" as string | undefined,
  DOLTHUB_OWNER: "cogni-dao" as string | undefined,
}));

const mockNodeLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockGetServerSessionUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    mockGetServerSessionUser(...args),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => envState,
}));

vi.mock("@/bootstrap/container", () => ({
  resolveAppDb: () => ({}),
  getContainer: () => ({
    log: mockNodeLog,
    clock: { now: () => new Date().toISOString() },
  }),
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: unknown) => unknown
  ) => run(mockTx),
}));

const mockTx = {
  select: () => ({
    from: () => ({
      where: (condition: SQL) => {
        const query = new PgDialect().sqlToQuery(condition);
        dbState.reads.push(query);
        return {
          limit: () =>
            dbState.available && query.params.includes(dbState.row.ownerUserId)
              ? [dbState.row]
              : [],
        };
      },
    }),
  }),
};

import { GET as getLegacy } from "@/app/api/v1/nodes/[id]/launch-pack/route";
import { GET as getSuccessor } from "@/app/api/v1/nodes/[id]/launch-pack/v2/route";
import { nodeLaunchPackOperation } from "@/contracts/nodes.launch-pack.v1.contract";
import { nodeLaunchPackV2Operation } from "@/contracts/nodes.launch-pack.v2.contract";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const legacyMetadata = {
  id: "node-launch-handoff",
  title: "AI assistant launch pack for node formation",
  url: "https://cognidao.org/knowledge/node-launch-handoff",
};
const successorMetadata = {
  id: "cicd-e2e-required-sequence",
  title: "Ship a node change through the operator",
  url: "https://cognidao.org/knowledge/cicd-e2e-required-sequence",
};

const transports = [
  {
    version: "v1",
    get: getLegacy,
    suffix: "",
    metadata: legacyMetadata,
    kind: "cogni.node.launch_pack.v0",
  },
  {
    version: "v2",
    get: getSuccessor,
    suffix: "/v2",
    metadata: successorMetadata,
    kind: "cogni.node.launch_pack.v1",
  },
] as const;

describe.each(transports)("launch pack $version", ({
  get,
  suffix,
  metadata,
  kind,
  version,
}) => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.available = true;
    dbState.reads = [];
    mockGetServerSessionUser.mockReset();
    mockGetServerSessionUser.mockResolvedValue({ id: "user-1" });
    envState.APP_BASE_URL = "https://test.cognidao.org/";
    envState.NODE_MINT_OWNER = "Cogni-DAO";
    envState.DOLTHUB_OWNER = "cogni-dao";
  });

  async function read(id = NODE_ID) {
    return get(
      new Request(
        `https://0.0.0.0:3000/api/v1/nodes/${id}/launch-pack${suffix}`,
        {
          headers: {
            host: "untrusted.example",
            "x-forwarded-host": "untrusted.example",
            "x-forwarded-proto": "http",
          },
        }
      ),
      { params: Promise.resolve({ id }) }
    );
  }

  it.each([
    NODE_ID,
    "atlas",
  ])("serves its own version through %s with the owner predicate", async (id) => {
    const response = await read(id);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.kind).toBe(kind);
    expect(body.nodeId).toBe(NODE_ID);
    expect(body.nodeRepoUrl).toBe("https://github.com/Cogni-DAO/atlas");
    expect(body.knowledgeRepoUrl).toBe(
      "https://www.dolthub.com/repositories/cogni-dao/atlas"
    );
    expect(body.parentDeploymentPrUrl).toBe(
      "https://github.com/Cogni-DAO/cogni/pull/42"
    );
    expect(body.candidateUrl).toBe("https://atlas-test.cognidao.org");
    expect(body.operatorBaseUrl).toBe("https://test.cognidao.org");
    expect(body.launchPackUrl).toBe(
      `https://test.cognidao.org/api/v1/nodes/${NODE_ID}/launch-pack${suffix}`
    );
    expect(body.knowledgeBlock).toEqual(metadata);
    expect(body.prompt).toContain(
      "https://cognidao.org/knowledge/node-ai-traces-read"
    );
    expect(body.prompt).toContain(
      "https://cognidao.org/knowledge/cicd-e2e-required-sequence"
    );
    expect(body.prompt).toContain("COGNI_NODE_API_KEY");
    expect(body.prompt).toContain("COGNI_OPERATOR_NODE_API_KEY");
    expect(body.prompt).toContain("canonical variable wins");
    expect(body.prompt).not.toContain("node-launch-handoff");
    expect(body.prompt).not.toContain("developer-rbac-request");
    expect(body.prompt).not.toContain("node-app-secrets");
    expect(body.prompt).toContain("blocked scorecard row");
    expect(nodeLaunchPackOperation.output.safeParse(body).success).toBe(
      version === "v1"
    );
    expect(nodeLaunchPackV2Operation.output.safeParse(body).success).toBe(
      version === "v2"
    );
    expect(dbState.reads[0]?.params).toContain(id);
    expect(dbState.reads[0]?.params).toContain("user-1");
    expect(dbState.reads[0]?.sql).toContain('"nodes"."owner_user_id"');
    expect(mockNodeLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: "nodes.launch_pack",
        targetNodeId: NODE_ID,
        status: 200,
      }),
      expect.any(String)
    );
  });

  it("returns JSON401 before input or database access when unauthenticated", async () => {
    mockGetServerSessionUser.mockResolvedValue(null);
    envState.APP_BASE_URL = undefined;
    const response = await read("");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(dbState.reads).toHaveLength(0);
  });

  it("returns JSON400 for invalid input without reading the node", async () => {
    const response = await read("");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "invalid input",
      issues: expect.any(Array),
    });
    expect(dbState.reads).toHaveLength(0);
  });

  it("returns JSON404 for a different owner", async () => {
    mockGetServerSessionUser.mockResolvedValue({ id: "user-2" });
    envState.APP_BASE_URL = undefined;
    const response = await read();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not found" });
    expect(dbState.reads[0]?.params).toContain("user-2");
    expect(dbState.reads[0]?.sql).toContain('"nodes"."owner_user_id"');
  });

  it("returns the same JSON404 for a missing node", async () => {
    dbState.available = false;
    const response = await read();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("returns a generic JSON503 after the owner read when public origin is unconfigured", async () => {
    envState.APP_BASE_URL = undefined;
    const response = await read();
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "launch pack unavailable" });
    expect(dbState.reads).toHaveLength(1);
    expect(dbState.reads[0]?.params).toContain("user-1");
  });

  it("retains repository-owner fallback", async () => {
    envState.NODE_MINT_OWNER = undefined;
    const response = await read();
    expect(response.status).toBe(200);
    expect((await response.json()).nodeRepoUrl).toBe(
      "https://github.com/Cogni-DAO/atlas"
    );
  });

  it("accepts the existing legacy packet and rejects cross-version kinds", async () => {
    const response = await read();
    const body = await response.json();
    const legacy = {
      ...body,
      kind: "cogni.node.launch_pack.v0",
      knowledgeBlock: legacyMetadata,
      prompt: "legacy freeform prompt",
    };
    expect(nodeLaunchPackOperation.output.safeParse(legacy).success).toBe(true);
    expect(nodeLaunchPackV2Operation.output.safeParse(legacy).success).toBe(
      false
    );
    const mismatch = {
      ...body,
      kind:
        version === "v1"
          ? "cogni.node.launch_pack.v1"
          : "cogni.node.launch_pack.v0",
    };
    const schema =
      version === "v1"
        ? nodeLaunchPackOperation.output
        : nodeLaunchPackV2Operation.output;
    expect(schema.safeParse(mismatch).success).toBe(false);
  });
});
