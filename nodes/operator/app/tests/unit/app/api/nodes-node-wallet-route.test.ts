// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-node-wallet-route`
 * Purpose: State-table coverage for POST /api/v1/nodes/[id]/node-wallet (story.0083), plus the SPKI
 *   validator the route trusts.
 * Scope: Mocks the session, env, DB, Privy provisioner and GitHub writer; runs the real route, the real
 *   validator and the real repo-spec check. No Privy, GitHub or Postgres IO.
 * Invariants: SESSION_OWNER_ONLY, SAME_ORIGIN, PUBLIC_KEY_ONLY, ONE_WALLET_PER_NODE_AND_LANE,
 *   SINGLE_WRITER_OF_OPERATOR_WALLET_ADDRESS, FAIL_CLOSED, ONE_TERMINAL_EVENT.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/node-wallet/route.ts, src/features/nodes/node-wallet.ts
 * @internal
 */

import { generateKeyPairSync } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://operator.example.org";
const WALLET = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
const PRIVY_ID = "privy-wallet-id-1";

type Row = {
  id: string;
  slug: string;
  ownerUserId: string;
  status: string;
  repoOwner: string;
  repoName: string;
  repoSpecPath: string | null;
  operatorWalletAddress: string | null;
  pendingNodeWalletKeySha256: string | null;
  pendingNodeWalletId: string | null;
  pendingNodeWalletAddress: string | null;
};

const dbState = vi.hoisted(() => ({
  current: undefined as unknown,
  patches: [] as Record<string, unknown>[],
  wheres: [] as { sql: string; params: unknown[] }[],
  updateReturnsRow: true,
  /** Scripted select results, consumed before falling back to `current`. */
  selectQueue: [] as unknown[][],
  selectCalls: 0,
}));
const envState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const sessionState = vi.hoisted(() => ({
  current: { id: "owner-1" } as { id: string } | null,
}));

const mockFetchFileText = vi.hoisted(() => vi.fn());
const mockOpenNodeWalletPr = vi.hoisted(() => vi.fn());
const mockFindByOwnerKey = vi.hoisted(() => vi.fn());
const mockCreateOwned = vi.hoisted(() => vi.fn());
const provisionerState = vi.hoisted(() => ({ configured: true }));
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: vi.fn(async () => sessionState.current),
}));
vi.mock("@/shared/env", () => ({ serverEnv: () => envState.current }));
vi.mock("@/bootstrap/capabilities/node-repo-write", () => ({
  createNodeRepoWriter: () => ({
    fetchFileText: mockFetchFileText,
    openNodeWalletPr: mockOpenNodeWalletPr,
  }),
}));
vi.mock("@/bootstrap/capabilities/node-wallet-provisioner", () => ({
  createNodeWalletProvisioner: () =>
    provisionerState.configured
      ? { findByOwnerKey: mockFindByOwnerKey, createOwned: mockCreateOwned }
      : undefined,
}));
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attrs: Record<string, string>,
    handler: (ctx: { traceId: string }) => Promise<unknown>
  ) => handler({ traceId: "trace-1" }),
}));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: { NODE_WALLET_CREATE_COMPLETE: "node.wallet_create.complete" },
  createRequestContext: () => ({
    log: mockLog,
    reqId: "req-1",
    routeId: "v1.nodes.node-wallet",
  }),
  makeLogger: () => mockLog,
}));
vi.mock("@/bootstrap/container", () => ({
  resolveServiceDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            dbState.selectCalls += 1;
            const scripted = dbState.selectQueue.shift();
            if (scripted) return scripted;
            // The 2nd select of an unpinned row is the ONE_KEY_ONE_NODE conflict lookup: no other row.
            const row = dbState.current as Row | undefined;
            if (
              dbState.selectCalls === 2 &&
              row?.pendingNodeWalletKeySha256 === null
            ) {
              return [];
            }
            return row ? [row] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        dbState.patches.push(patch);
        return {
          where: (condition: SQL) => {
            dbState.wheres.push(new PgDialect().sqlToQuery(condition));
            return {
              returning: async () => {
                if (!dbState.updateReturnsRow) return [];
                dbState.current = { ...(dbState.current as Row), ...patch };
                return [dbState.current];
              },
            };
          },
        };
      },
    }),
  }),
}));

import { POST } from "@/app/api/v1/nodes/[id]/node-wallet/route";
import {
  nodeWalletIdempotencyKey,
  parseOwnerPublicKey,
} from "@/features/nodes/node-wallet";
import {
  readSpecOperatorWalletAddress,
  renderNodeWalletSpec,
} from "@/shared/node-app-scaffold/gens";

function p256Spki(): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

const SPKI = p256Spki();
const KEY = parseOwnerPublicKey(SPKI);
if (!KEY.ok) throw new Error("fixture key must be valid");
const KEY_SHA = KEY.keySha256;

function baseRow(overrides: Partial<Row> = {}): Row {
  return {
    id: NODE_ID,
    slug: "spawny-boi",
    ownerUserId: "owner-1",
    status: "published",
    repoOwner: "cogni-dao",
    repoName: "cogni",
    repoSpecPath: null,
    operatorWalletAddress: null,
    pendingNodeWalletKeySha256: null,
    pendingNodeWalletId: null,
    pendingNodeWalletAddress: null,
    ...overrides,
  };
}

function call(
  opts: { body?: unknown; headers?: Record<string, string | null> } = {}
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: "operator.example.org",
    "x-forwarded-proto": "https",
    origin: ORIGIN,
  };
  dbState.selectCalls = 0;
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return POST(
    new Request(`${ORIGIN}/api/v1/nodes/${NODE_ID}/node-wallet`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        "body" in opts ? opts.body : { ownerPublicKey: SPKI }
      ),
    }),
    { params: Promise.resolve({ id: NODE_ID }) }
  );
}

function terminalEvents() {
  return mockLog.info.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((f) => f.event === "node.wallet_create.complete");
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.current = baseRow();
  dbState.patches = [];
  dbState.wheres = [];
  dbState.updateReturnsRow = true;
  dbState.selectQueue = [];
  dbState.selectCalls = 0;
  sessionState.current = { id: "owner-1" };
  provisionerState.configured = true;
  envState.current = {
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64: "x",
    NODE_MINT_OWNER: "cogni-test-nodes",
    DEPLOY_ENVIRONMENT: "candidate-a",
  };
  mockFetchFileText.mockResolvedValue(
    'schema_version: "0.1.4"\nnode_id: "x"\nintent:\n  name: spawny-boi\n'
  );
  mockFindByOwnerKey.mockResolvedValue([]);
  mockCreateOwned.mockResolvedValue({ id: PRIVY_ID, address: WALLET });
  mockOpenNodeWalletPr.mockResolvedValue({
    status: "pr_opened",
    prNumber: 7,
    prUrl: "https://github.com/cogni-test-nodes/spawny-boi/pull/7",
  });
});

describe("POST /api/v1/nodes/[id]/node-wallet refusals", () => {
  it("refuses a bearer / API key before any lookup", async () => {
    const res = await call({
      headers: { authorization: "Bearer cogni_ag_sk_v1_whatever" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("session_required");
    expect(mockCreateOwned).not.toHaveBeenCalled();
    expect(dbState.patches).toEqual([]);
  });

  it("refuses a cross-origin request and a request with no Origin", async () => {
    const cross = await call({ headers: { origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    expect((await cross.json()).error).toBe("origin_mismatch");
    const none = await call({ headers: { origin: null } });
    expect(none.status).toBe(403);
    expect(mockCreateOwned).not.toHaveBeenCalled();
  });

  it("refuses without a session", async () => {
    sessionState.current = null;
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("refuses a signed-in user who is not the node owner", async () => {
    sessionState.current = { id: "someone-else" };
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_node_owner");
    expect(mockCreateOwned).not.toHaveBeenCalled();
  });

  it("refuses bodies that are not exactly { ownerPublicKey }", async () => {
    for (const body of [
      {},
      { ownerPublicKey: SPKI, privateKey: "AAAA" },
      [SPKI],
      "nope",
    ]) {
      const res = await call({ body });
      expect(res.status).toBe(400);
    }
    expect(mockCreateOwned).not.toHaveBeenCalled();
  });

  it("refuses an invalid or non-P-256 public key", async () => {
    const secp = generateKeyPairSync("ec", { namedCurve: "secp256k1" })
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    const pkcs8 = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64");
    for (const ownerPublicKey of ["not base64!", secp, pkcs8, "", 42]) {
      const res = await call({ body: { ownerPublicKey } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_public_key");
    }
    expect(mockCreateOwned).not.toHaveBeenCalled();
  });

  it("409s when the row already has an operator wallet", async () => {
    dbState.current = baseRow({
      status: "wallet_ready",
      operatorWalletAddress: WALLET,
    });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_has_wallet");
    expect(mockCreateOwned).not.toHaveBeenCalled();
  });

  it("409s when the node repo-spec already names a wallet", async () => {
    mockFetchFileText.mockResolvedValue(
      `intent:\n  name: spawny-boi\noperator_wallet:\n  address: "${WALLET}"\n`
    );
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_has_wallet");
    expect(body.source).toBe("repo-spec");
    expect(mockCreateOwned).not.toHaveBeenCalled();
    expect(dbState.patches).toEqual([]);
  });

  it("fails closed with 503 when Privy is not configured, writing nothing", async () => {
    provisionerState.configured = false;
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("privy_unconfigured");
    expect(dbState.patches).toEqual([]);
    expect(mockOpenNodeWalletPr).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the deploy environment is unset", async () => {
    envState.current = { ...envState.current, DEPLOY_ENVIRONMENT: undefined };
    const res = await call();
    expect(res.status).toBe(503);
    expect(mockCreateOwned).not.toHaveBeenCalled();
  });

  it("409s for a node that is not published", async () => {
    dbState.current = baseRow({ status: "dao_formed" });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("invalid_state");
  });
});

describe("POST /api/v1/nodes/[id]/node-wallet creation", () => {
  it("pins the key hash, creates once with the scoped idempotency key, opens the PR and never writes operator_wallet_address", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      walletAddress: WALLET,
      outcome: "created",
      pr: {
        status: "pr_opened",
        prNumber: 7,
        prUrl: "https://github.com/cogni-test-nodes/spawny-boi/pull/7",
      },
    });

    // pin is conditional on the hash being NULL (and no recorded wallet)
    expect(dbState.patches[0]).toMatchObject({
      pendingNodeWalletKeySha256: KEY_SHA,
    });
    expect(dbState.wheres[0]?.sql).toContain(
      '"pending_node_wallet_key_sha256" is null'
    );
    expect(dbState.wheres[0]?.sql).toContain(
      '"operator_wallet_address" is null'
    );
    // the wallet is recorded in the PENDING columns only
    expect(dbState.patches[1]).toMatchObject({
      pendingNodeWalletId: PRIVY_ID,
      pendingNodeWalletAddress: WALLET,
    });
    for (const patch of dbState.patches) {
      expect(patch).not.toHaveProperty("operatorWalletAddress");
      expect(patch).not.toHaveProperty("status");
    }

    expect(mockFindByOwnerKey).toHaveBeenCalledWith(SPKI);
    expect(mockCreateOwned).toHaveBeenCalledTimes(1);
    expect(mockCreateOwned).toHaveBeenCalledWith({
      ownerPublicKey: SPKI,
      idempotencyKey: nodeWalletIdempotencyKey({
        env: "candidate-a",
        rowId: NODE_ID,
        keySha256: KEY_SHA,
      }),
    });
    expect(mockCreateOwned.mock.calls[0]?.[0].idempotencyKey).toBe(
      `node-wallet:candidate-a:${NODE_ID}:${KEY_SHA}`
    );
    // the PR goes to the node's OWN repo, address only
    expect(mockOpenNodeWalletPr).toHaveBeenCalledWith({
      owner: "cogni-test-nodes",
      repo: "spawny-boi",
      slug: "spawny-boi",
      walletAddress: WALLET,
    });
    expect(mockFetchFileText).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "cogni-test-nodes",
        repo: "spawny-boi",
        ref: "main",
      })
    );
  });

  it("adopts a wallet Privy already lists for the owner key instead of creating", async () => {
    mockFindByOwnerKey.mockResolvedValue([
      { id: "adopted-id", address: WALLET },
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("adopted");
    expect(mockCreateOwned).not.toHaveBeenCalled();
    expect(dbState.patches[1]).toMatchObject({
      pendingNodeWalletId: "adopted-id",
    });
  });

  it("refuses an ambiguous owner key (more than one wallet)", async () => {
    mockFindByOwnerKey.mockResolvedValue([
      { id: "a", address: WALLET },
      { id: "b", address: WALLET },
    ]);
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("wallet_ambiguous");
    expect(mockCreateOwned).not.toHaveBeenCalled();
  });

  it("a retry with the same key returns the recorded wallet and creates nothing", async () => {
    dbState.current = baseRow({
      pendingNodeWalletKeySha256: KEY_SHA,
      pendingNodeWalletId: PRIVY_ID,
      pendingNodeWalletAddress: WALLET,
    });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.walletAddress).toBe(WALLET);
    expect(body.outcome).toBe("existing");
    expect(mockFindByOwnerKey).not.toHaveBeenCalled();
    expect(mockCreateOwned).not.toHaveBeenCalled();
    expect(dbState.patches).toEqual([]);
    // the PR step is idempotent and still runs, so a failed PR heals on retry
    expect(mockOpenNodeWalletPr).toHaveBeenCalledTimes(1);
  });

  it("a pinned row with no wallet yet (interrupted call) resumes with the same key", async () => {
    dbState.current = baseRow({ pendingNodeWalletKeySha256: KEY_SHA });
    const res = await call();
    expect(res.status).toBe(200);
    expect(mockCreateOwned).toHaveBeenCalledTimes(1);
    expect(dbState.patches).toHaveLength(1);
    expect(dbState.patches[0]).toHaveProperty("pendingNodeWalletId");
  });

  it("a different key for a node that already has a pending wallet is 409 key_mismatch", async () => {
    dbState.current = baseRow({
      pendingNodeWalletKeySha256: "f".repeat(64),
      pendingNodeWalletId: PRIVY_ID,
      pendingNodeWalletAddress: WALLET,
    });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("key_mismatch");
    expect(mockFindByOwnerKey).not.toHaveBeenCalled();
    expect(mockCreateOwned).not.toHaveBeenCalled();
    expect(mockOpenNodeWalletPr).not.toHaveBeenCalled();
  });

  it("a lost pin race against a different key is 409 key_mismatch", async () => {
    // the conditional pin matches no row; the re-read shows another call pinned a different key
    dbState.updateReturnsRow = false;
    dbState.selectQueue = [
      [baseRow()],
      [],
      [baseRow({ pendingNodeWalletKeySha256: "e".repeat(64) })],
    ];
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("key_mismatch");
    expect(mockCreateOwned).not.toHaveBeenCalled();
  });

  it("refuses a key already pinned on another node, never adopting its wallet", async () => {
    dbState.selectQueue = [
      [baseRow()],
      [baseRow({ id: "other-node", pendingNodeWalletKeySha256: KEY_SHA })],
    ];
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("key_in_use");
    expect(mockFindByOwnerKey).not.toHaveBeenCalled();
    expect(mockCreateOwned).not.toHaveBeenCalled();
    expect(dbState.patches).toEqual([]);
  });

  it("502s when Privy fails, logging only the error class", async () => {
    const secretMessage = `boom ${SPKI}`;
    class PrivyApiError extends Error {
      constructor() {
        super(secretMessage);
        this.name = "PrivyApiError";
      }
    }
    mockCreateOwned.mockRejectedValue(new PrivyApiError());
    const res = await call();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("privy_unavailable");
    expect(JSON.stringify(mockLog.warn.mock.calls)).toContain("PrivyApiError");
    expect(JSON.stringify(mockLog.warn.mock.calls)).not.toContain(
      secretMessage
    );
  });

  it("keeps the recorded wallet and reports pr_open_failed when the PR cannot be opened", async () => {
    mockOpenNodeWalletPr.mockRejectedValue(new Error("github down"));
    const res = await call();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("pr_open_failed");
    expect(body.walletAddress).toBe(WALLET);
    expect(dbState.patches[1]).toMatchObject({
      pendingNodeWalletAddress: WALLET,
    });
  });

  it("409s when the PR writer finds a different wallet already declared on main", async () => {
    mockOpenNodeWalletPr.mockRejectedValue(
      Object.assign(new Error("declared"), { code: "wallet_already_declared" })
    );
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_has_wallet");
  });
});

describe("node-wallet logging", () => {
  it("emits exactly one terminal event and never logs key material", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const events = terminalEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "node.wallet_create.complete",
      nodeId: NODE_ID,
      actorUserId: "owner-1",
      outcome: "created",
      walletAddress: WALLET,
      status: 200,
    });
    const everything = JSON.stringify([
      mockLog.info.mock.calls,
      mockLog.warn.mock.calls,
      mockLog.error.mock.calls,
    ]);
    expect(everything).not.toContain(SPKI);
    expect(everything).not.toContain(KEY_SHA);
    expect(everything).not.toContain(PRIVY_ID);
  });

  it("emits one terminal event with an errorCode on refusal", async () => {
    sessionState.current = { id: "someone-else" };
    await call();
    const events = terminalEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "error",
      errorCode: "not_node_owner",
      status: 403,
    });
  });
});

describe("parseOwnerPublicKey", () => {
  it("accepts a P-256 SPKI public key and hashes the canonical DER bytes", () => {
    const parsed = parseOwnerPublicKey(SPKI);
    expect(parsed).toMatchObject({ ok: true, spkiBase64: SPKI });
    expect(KEY_SHA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects private keys, other curves, PEM text, and junk", () => {
    const secp = generateKeyPairSync("ec", { namedCurve: "secp256k1" })
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    const ed = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    const pkcs8 = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .publicKey.export({ format: "pem", type: "spki" })
      .toString();
    for (const value of [secp, ed, pkcs8, pem, "AAAA", "", "x".repeat(400)]) {
      expect(parseOwnerPublicKey(value).ok).toBe(false);
    }
  });
});

describe("renderNodeWalletSpec", () => {
  const spec =
    'schema_version: "0.1.4"\n# keep me\nintent:\n  name: spawny-boi\n';

  it("appends operator_wallet.address and changes nothing else", () => {
    const out = renderNodeWalletSpec(spec, WALLET);
    expect(out.startsWith(spec)).toBe(true);
    expect(out).toContain(`operator_wallet:\n  address: "${WALLET}"`);
    expect(readSpecOperatorWalletAddress(out)).toBe(WALLET);
  });

  it("is idempotent", () => {
    const once = renderNodeWalletSpec(spec, WALLET);
    expect(renderNodeWalletSpec(once, WALLET)).toBe(once);
  });

  it("reads null when no wallet is named", () => {
    expect(readSpecOperatorWalletAddress(spec)).toBeNull();
    expect(readSpecOperatorWalletAddress("::: not yaml :::\n\t-")).toBeNull();
  });
});
