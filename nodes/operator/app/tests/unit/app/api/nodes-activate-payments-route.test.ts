// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-activate-payments-route`
 * Purpose: Coverage for the WALLET_MATCHES_GIT gate of POST /api/v1/nodes/[id]/activate-payments (bug.5656).
 * Scope: Mocks auth, env, DB and the GitHub writer; runs the real route and the real repo-spec parser.
 * Invariants: WALLET_MATCHES_GIT - the PR opens only when repo-spec operator_wallet equals the row wallet.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/activate-payments/route.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const WALLET = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
const SPLIT = "0xec9add7DF66E0481E87C8fB04F22f9813F3B0894";
const NODE_ID = "11111111-1111-4111-8111-111111111111";

const dbState = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));
const mockFetchFileText = vi.hoisted(() => vi.fn());
const mockOpenPr = vi.hoisted(() => vi.fn());

vi.mock("@/app/_lib/auth/route-identity", () => ({
  resolveRouteIdentity: async () => ({ ok: true, user: { id: "user-1" } }),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/app/_lib/node-rbac", () => ({ resolveNodeAndAuthorize: vi.fn() }));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64: "a2V5",
    NODE_MINT_OWNER: "cogni-test-org",
  }),
}));
vi.mock("@/bootstrap/capabilities/node-repo-write", () => ({
  createNodeRepoWriter: () => ({
    fetchFileText: mockFetchFileText,
    openPaymentsActivationPr: mockOpenPr,
  }),
}));
vi.mock("@/bootstrap/container", () => ({
  resolveServiceDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => (dbState.current ? [dbState.current] : []),
        }),
      }),
    }),
  }),
}));

import { POST } from "@/app/api/v1/nodes/[id]/activate-payments/route";

function spec(wallet?: string): string {
  return `schema_version: "0.1.4"
node_id: "${NODE_ID}"
scope_id: "00000000-0000-4000-8000-000000000002"
scope_key: "default"
intent:
  name: spawny-boi
${wallet ? `operator_wallet:\n  address: "${wallet}"\n` : ""}governance:
  chain_id: "8453"
`;
}

async function call() {
  const response = await POST(
    new Request(
      `https://test.local/api/v1/nodes/${NODE_ID}/activate-payments`,
      {
        method: "POST",
      }
    ),
    { params: Promise.resolve({ id: NODE_ID }) }
  );
  return { status: response.status, body: await response.json() };
}

describe("POST /api/v1/nodes/[id]/activate-payments wallet gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.current = {
      id: NODE_ID,
      slug: "spawny-boi",
      ownerUserId: "user-1",
      status: "wallet_ready",
      repoOwner: "Cogni-DAO",
      repoName: "cogni",
      repoSpecPath: null,
      operatorWalletAddress: WALLET,
      splitAddress: SPLIT,
      repoUrl: "https://github.com/cogni-test-org/spawny-boi",
    };
    mockFetchFileText.mockResolvedValue(spec(WALLET));
    mockOpenPr.mockResolvedValue({
      status: "pr_opened",
      prNumber: 7,
      prUrl: "https://github.com/cogni-test-org/spawny-boi/pull/7",
    });
  });

  it("opens the PR when repo-spec operator_wallet matches the row (any case)", async () => {
    mockFetchFileText.mockResolvedValue(spec(WALLET.toLowerCase()));
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.activation.status).toBe("pr_opened");
    expect(mockFetchFileText).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "spawny-boi",
      path: ".cogni/repo-spec.yaml",
      ref: "main",
    });
    expect(mockOpenPr).toHaveBeenCalledTimes(1);
  });

  it("409 wallet_mismatch when repo-spec operator_wallet differs, no PR", async () => {
    mockFetchFileText.mockResolvedValue(
      spec("0x4444444444444444444444444444444444444444")
    );
    const { status, body } = await call();

    expect(status).toBe(409);
    expect(body.error).toBe("wallet_mismatch");
    expect(mockOpenPr).not.toHaveBeenCalled();
  });

  it("409 wallet_mismatch when repo-spec declares no operator_wallet, no PR", async () => {
    mockFetchFileText.mockResolvedValue(spec());
    const { status, body } = await call();

    expect(status).toBe(409);
    expect(body.error).toBe("wallet_mismatch");
    expect(body.declaredInRepoSpec).toBeNull();
    expect(mockOpenPr).not.toHaveBeenCalled();
  });

  it("502 with a fixed reason when the repo-spec is not found", async () => {
    mockFetchFileText.mockResolvedValue(null);
    const { status, body } = await call();

    expect(status).toBe(502);
    expect(body).toEqual({
      error: "node repo-spec read failed",
      reason: "repo_spec_unreadable",
    });
    expect(mockOpenPr).not.toHaveBeenCalled();
  });

  it("502 with a fixed reason, never the upstream error text, when the read throws", async () => {
    mockFetchFileText.mockRejectedValue(
      new Error("HttpRequestError: https://rpc.example/v2/SECRET-KEY failed")
    );
    const { status, body } = await call();

    expect(status).toBe(502);
    expect(body.reason).toBe("repo_spec_unreadable");
    expect(JSON.stringify(body)).not.toContain("SECRET-KEY");
    expect(mockOpenPr).not.toHaveBeenCalled();
  });
});
