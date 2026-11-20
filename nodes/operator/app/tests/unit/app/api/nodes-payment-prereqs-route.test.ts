// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-payment-prereqs-route`
 * Purpose: State-table coverage for POST /api/v1/nodes/[id]/payment-prereqs (bug.5656).
 * Scope: Mocks auth, env, DB, the GitHub writer and the Base RPC; runs the real route, the real
 *   repo-spec parser and the real planner. No GitHub, Postgres or chain IO.
 * Invariants: GIT_IS_THE_SOURCE, NEVER_OVERWRITE, CONDITIONAL_ADVANCE, ONE_TERMINAL_EVENT.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/payment-prereqs/route.ts, src/features/nodes/payment-prereqs.ts
 * @internal
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WALLET = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
const DAO = "0x1111111111111111111111111111111111111111";
const PLUGIN = "0x2222222222222222222222222222222222222222";
const SIGNAL = "0x3333333333333333333333333333333333333333";
const NODE_ID = "11111111-1111-4111-8111-111111111111";

type Row = {
  id: string;
  slug: string;
  ownerUserId: string;
  status: string;
  repoOwner: string;
  repoName: string;
  repoSpecPath: string | null;
  operatorWalletAddress: string | null;
  daoAddress: string | null;
  pluginAddress: string | null;
  signalAddress: string | null;
};

const dbState = vi.hoisted(() => ({
  current: undefined as Row | undefined,
  patch: undefined as Record<string, unknown> | undefined,
  updateWhere: undefined as { sql: string; params: unknown[] } | undefined,
  updateReturnsRow: true,
}));

const envState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

const mockFetchFileText = vi.hoisted(() => vi.fn());
const mockGetBytecode = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/app/_lib/auth/route-identity", () => ({
  resolveRouteIdentity: async () => ({ ok: true, user: { id: "user-1" } }),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: vi.fn(async () => ({
    ok: false,
    status: 403,
    errorCode: "authz_denied",
  })),
}));
vi.mock("@/shared/env", () => ({ serverEnv: () => envState.current }));
vi.mock("@/bootstrap/capabilities/node-repo-write", () => ({
  createNodeRepoWriter: () => ({ fetchFileText: mockFetchFileText }),
}));
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attrs: Record<string, string>,
    handler: (ctx: { traceId: string }) => Promise<unknown>
  ) => handler({ traceId: "trace-1" }),
}));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {
    NODE_PAYMENT_PREREQS_COMPLETE: "node.payment_prereqs.complete",
  },
  createRequestContext: () => ({
    log: mockLog,
    reqId: "req-1",
    routeId: "v1.nodes.payment-prereqs",
  }),
  makeLogger: () => mockLog,
}));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({ getBytecode: mockGetBytecode }),
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
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        dbState.patch = patch;
        return {
          where: (condition: SQL) => {
            dbState.updateWhere = new PgDialect().sqlToQuery(condition);
            return {
              returning: async () =>
                dbState.updateReturnsRow
                  ? [{ ...dbState.current, ...patch }]
                  : [],
            };
          },
        };
      },
    }),
  }),
}));

import { POST } from "@/app/api/v1/nodes/[id]/payment-prereqs/route";

function specYaml(opts: { wallet?: string; dao?: string; chain?: string }) {
  return `schema_version: "0.1.4"
node_id: "${NODE_ID}"
scope_id: "00000000-0000-4000-8000-000000000002"
scope_key: "default"
intent:
  name: spawny-boi
${opts.wallet ? `operator_wallet:\n  address: "${opts.wallet}"\n` : ""}governance:
${opts.dao ? `  dao_contract: "${opts.dao}"\n` : ""}  plugin_contract: "${PLUGIN}"
  signal_contract: "${SIGNAL}"
  chain_id: "${opts.chain ?? "8453"}"
`;
}

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: NODE_ID,
    slug: "spawny-boi",
    ownerUserId: "user-1",
    status: "published",
    repoOwner: "Cogni-DAO",
    repoName: "cogni",
    repoSpecPath: null,
    operatorWalletAddress: null,
    daoAddress: null,
    pluginAddress: null,
    signalAddress: null,
    ...over,
  };
}

async function call() {
  const response = await POST(
    new Request(`https://test.local/api/v1/nodes/${NODE_ID}/payment-prereqs`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: NODE_ID }) }
  );
  return { status: response.status, body: await response.json() };
}

function terminalEvent() {
  const calls = mockLog.info.mock.calls.filter(
    (call) =>
      (call[0] as { event?: string }).event === "node.payment_prereqs.complete"
  );
  expect(calls).toHaveLength(1);
  return calls[0]?.[0] as Record<string, unknown>;
}

describe("POST /api/v1/nodes/[id]/payment-prereqs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.current = baseRow();
    dbState.patch = undefined;
    dbState.updateWhere = undefined;
    dbState.updateReturnsRow = true;
    envState.current = {
      GH_REVIEW_APP_ID: "1",
      GH_REVIEW_APP_PRIVATE_KEY_BASE64: "a2V5",
      NODE_MINT_OWNER: "cogni-test-org",
      EVM_RPC_URL: "https://rpc.test.local",
    };
    mockFetchFileText.mockResolvedValue(specYaml({ wallet: WALLET, dao: DAO }));
    mockGetBytecode.mockResolvedValue("0x6080");
  });

  it("published + wallet in git: records the four addresses and moves to wallet_ready", async () => {
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.node.status).toBe("wallet_ready");
    expect(dbState.patch).toMatchObject({
      operatorWalletAddress: WALLET,
      daoAddress: DAO,
      pluginAddress: PLUGIN,
      signalAddress: SIGNAL,
      status: "wallet_ready",
    });
    // CONDITIONAL_ADVANCE: the write is guarded on status = 'published'.
    expect(dbState.updateWhere?.sql).toContain('"status" = $');
    expect(dbState.updateWhere?.params).toContain("published");
    // Wizard-born row (no repoSpecPath): reads the node's own repo, never the parent monorepo.
    expect(mockFetchFileText).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "spawny-boi",
      path: ".cogni/repo-spec.yaml",
      ref: "main",
    });
    expect(terminalEvent()).toMatchObject({
      nodeId: NODE_ID,
      outcome: "recorded",
      previousStatus: "published",
      nextStatus: "wallet_ready",
      status: 200,
    });
  });

  it("uses the row's projected repo location when repoSpecPath is set", async () => {
    dbState.current = baseRow({
      repoOwner: "cogni-test-org",
      repoName: "other-repo",
      repoSpecPath: "nodes/x/.cogni/repo-spec.yaml",
    });
    await call();
    expect(mockFetchFileText).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "other-repo",
      path: "nodes/x/.cogni/repo-spec.yaml",
      ref: "main",
    });
  });

  it("published + no operator_wallet in git: 409 prereq_missing, no write", async () => {
    mockFetchFileText.mockResolvedValue(specYaml({ dao: DAO }));
    const { status, body } = await call();

    expect(status).toBe(409);
    expect(body).toEqual({
      error: "prereq_missing",
      missingKey: "operator_wallet.address",
    });
    expect(dbState.patch).toBeUndefined();
    expect(terminalEvent()).toMatchObject({
      outcome: "error",
      missingKey: "operator_wallet.address",
      previousStatus: "published",
      nextStatus: "published",
      status: 409,
    });
  });

  it("published + governance.dao_contract missing: 409 naming that key", async () => {
    mockFetchFileText.mockResolvedValue(specYaml({ wallet: WALLET }));
    const { status, body } = await call();
    expect(status).toBe(409);
    expect(body.missingKey).toBe("governance.dao_contract");
    expect(dbState.patch).toBeUndefined();
  });

  it("rejects a zero-address wallet, a non-Base chain and a DAO without code", async () => {
    mockFetchFileText.mockResolvedValue(
      specYaml({
        wallet: "0x0000000000000000000000000000000000000000",
        dao: DAO,
      })
    );
    expect((await call()).body).toMatchObject({
      error: "prereq_invalid",
      invalidKey: "operator_wallet.address",
      reason: "zero_address",
    });

    mockFetchFileText.mockResolvedValue(
      specYaml({ wallet: WALLET, dao: DAO, chain: "1" })
    );
    expect((await call()).body).toMatchObject({
      invalidKey: "governance.chain_id",
      reason: "unsupported_chain",
    });

    mockFetchFileText.mockResolvedValue(specYaml({ wallet: WALLET, dao: DAO }));
    mockGetBytecode.mockResolvedValue(undefined);
    const noCode = await call();
    expect(noCode.status).toBe(409);
    expect(noCode.body).toMatchObject({
      invalidKey: "governance.dao_contract",
      reason: "no_code_on_base",
    });
    expect(dbState.patch).toBeUndefined();
  });

  it("fails closed with 503 when no EVM RPC is configured", async () => {
    envState.current = { ...envState.current, EVM_RPC_URL: undefined };
    const { status } = await call();
    expect(status).toBe(503);
    expect(mockFetchFileText).not.toHaveBeenCalled();
    expect(dbState.patch).toBeUndefined();
  });

  it("published + row wallet differs from git: 409 prereq_mismatch, never overwrites", async () => {
    dbState.current = baseRow({
      operatorWalletAddress: "0x4444444444444444444444444444444444444444",
    });
    const { status, body } = await call();

    expect(status).toBe(409);
    expect(body.error).toBe("prereq_mismatch");
    expect(body.mismatchedKeys).toEqual(["operatorWalletAddress"]);
    expect(body.git.operatorWalletAddress).toBe(WALLET);
    expect(dbState.patch).toBeUndefined();
  });

  it("wallet_ready + addresses equal git (any case): 200 with no change", async () => {
    dbState.current = baseRow({
      status: "wallet_ready",
      operatorWalletAddress: WALLET.toLowerCase(),
      daoAddress: DAO,
      pluginAddress: PLUGIN,
      signalAddress: SIGNAL,
    });
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.outcome).toBe("unchanged");
    expect(dbState.patch).toBeUndefined();
    expect(terminalEvent()).toMatchObject({
      outcome: "unchanged",
      previousStatus: "wallet_ready",
      nextStatus: "wallet_ready",
    });
  });

  it("wallet_ready + a NULL row address: records it without a status change", async () => {
    dbState.current = baseRow({
      status: "wallet_ready",
      operatorWalletAddress: WALLET,
      daoAddress: DAO,
      pluginAddress: null,
      signalAddress: null,
    });
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.outcome).toBe("recorded");
    expect(dbState.patch).toMatchObject({
      pluginAddress: PLUGIN,
      signalAddress: SIGNAL,
    });
    expect(dbState.patch).not.toHaveProperty("status");
    expect(dbState.patch).not.toHaveProperty("operatorWalletAddress");
    expect(dbState.updateWhere?.params).toContain("wallet_ready");
  });

  it("wallet_ready + a differing non-null address: 409 prereq_mismatch", async () => {
    dbState.current = baseRow({
      status: "wallet_ready",
      operatorWalletAddress: WALLET,
      daoAddress: "0x5555555555555555555555555555555555555555",
      pluginAddress: PLUGIN,
      signalAddress: SIGNAL,
    });
    const { status, body } = await call();
    expect(status).toBe(409);
    expect(body.error).toBe("prereq_mismatch");
    expect(body.mismatchedKeys).toEqual(["daoAddress"]);
    expect(dbState.patch).toBeUndefined();
  });

  it.each([
    "payments_ready",
    "active",
  ])("%s: 200 no change without reading git", async (statusValue) => {
    dbState.current = baseRow({ status: statusValue });
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.outcome).toBe("no_change");
    expect(mockFetchFileText).not.toHaveBeenCalled();
    expect(dbState.patch).toBeUndefined();
    expect(terminalEvent()).toMatchObject({ outcome: "no_change" });
  });

  it.each([
    "dao_pending",
    "dao_formed",
    "failed",
  ])("%s: 409 invalid_state", async (statusValue) => {
    dbState.current = baseRow({ status: statusValue });
    const { status, body } = await call();
    expect(status).toBe(409);
    expect(body.error).toBe("invalid_state");
    expect(mockFetchFileText).not.toHaveBeenCalled();
    expect(dbState.patch).toBeUndefined();
  });

  it("published + the conditional update matches zero rows: 409 concurrent_update", async () => {
    dbState.updateReturnsRow = false;
    const { status, body } = await call();
    expect(status).toBe(409);
    expect(body).toEqual({ error: "concurrent_update", retry: true });
  });

  it("a non-owner without node.flight is refused before any read", async () => {
    dbState.current = baseRow({ ownerUserId: "someone-else" });
    const { status } = await call();
    expect(status).toBe(403);
    expect(mockFetchFileText).not.toHaveBeenCalled();
    expect(dbState.patch).toBeUndefined();
  });
});
