// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-launch-pack-route`
 * Purpose: Unit coverage for GET /api/v1/nodes/[id]/launch-pack.
 * Scope: Owner-gated route and maintained launch references; mocks auth, env, DB.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/launch-pack/route.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  row: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "atlas",
    ownerUserId: "user-1",
    status: "published",
    publishPrUrl: "https://github.com/Cogni-DAO/cogni/pull/42",
  },
}));

const envState = vi.hoisted(() => ({
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
      where: () => ({
        limit: () => [dbState.row],
      }),
    }),
  }),
};

import { GET } from "@/app/api/v1/nodes/[id]/launch-pack/route";

describe("GET /api/v1/nodes/[id]/launch-pack", () => {
  beforeEach(() => {
    mockGetServerSessionUser.mockReset();
    mockGetServerSessionUser.mockResolvedValue({ id: "user-1" });
    envState.NODE_MINT_OWNER = "Cogni-DAO";
    envState.DOLTHUB_OWNER = "cogni-dao";
  });

  it.each([
    "11111111-1111-4111-8111-111111111111",
    "atlas",
  ])("returns the canonical launch pack via %s", async (id) => {
    const response = await GET(
      new Request(
        "https://test.cognidao.org/api/v1/nodes/11111111-1111-4111-8111-111111111111/launch-pack"
      ),
      {
        params: Promise.resolve({
          id,
        }),
      }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nodeId).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.nodeRepoUrl).toBe("https://github.com/Cogni-DAO/atlas");
    expect(body.knowledgeRepoUrl).toBe(
      "https://www.dolthub.com/repositories/cogni-dao/atlas"
    );
    expect(body.parentDeploymentPrUrl).toBe(
      "https://github.com/Cogni-DAO/cogni/pull/42"
    );
    expect(body.candidateUrl).toBe("https://atlas-test.cognidao.org");
    expect(body.knowledgeBlock).toEqual({
      id: "cicd-e2e-required-sequence",
      title: "Ship a node change through the operator",
      url: "https://cognidao.org/knowledge/cicd-e2e-required-sequence",
    });
    expect(body.prompt).toContain(
      "Cogni operator endpoint root: https://cognidao.org"
    );
    expect(body.prompt).toContain(
      "DoltHub knowledge repo: https://www.dolthub.com/repositories/cogni-dao/atlas"
    );
    expect(body.prompt).not.toContain(
      ".claude/skills/node-wizard-scorecard/SKILL.md"
    );
    expect(body.prompt).toContain(
      "https://cognidao.org/knowledge/node-ai-traces-read"
    );
    expect(body.prompt).not.toContain("node-app-secrets");
    expect(body.prompt).toContain("blocked scorecard row");
  });

  it("falls back to the parent PR owner when the mint owner env is unset", async () => {
    envState.NODE_MINT_OWNER = undefined;

    const response = await GET(
      new Request(
        "https://test.cognidao.org/api/v1/nodes/11111111-1111-4111-8111-111111111111/launch-pack"
      ),
      {
        params: Promise.resolve({
          id: "11111111-1111-4111-8111-111111111111",
        }),
      }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nodeRepoUrl).toBe("https://github.com/Cogni-DAO/atlas");
  });
});
