// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/agent-credentials.routes`
 * Purpose: The v2 agent key routes end to end (story.5156): a v1 key upgrades to a v2 key on the same user id, the v2 key authenticates through
 *   the real resolver, rotate + confirm swap keys and the old one dies, revoking one key 401s only it, and a store outage is 503, never 401.
 * Scope: The REAL routes, route wrapper, resolver (request-identity.ts) and credential service. Fakes: the credential store (the package's
 *   memory store, copied as a test fixture), the header source, the container and the session getter. Not a network or database test.
 *   Port of node-template tests/unit/app/api/agent-credentials.routes.test.ts; operator SessionUser carries no `via`, so those assertions are dropped.
 * Invariants: V1_PATH_UNCHANGED (an existing v1 key authenticates before and after), V2_ACTIVE_ONLY, STORE_OUTAGE_IS_NOT_401.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/story.5156
 */

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { memoryCredentialStore } from "../../../_fakes/agent-credentials-memory-store";

const fake = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  memory: undefined as unknown as {
    store: unknown;
    outage: { failing: boolean; failOn: string | null };
    advance(sec: number): void;
  },
}));
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};
log.child.mockReturnValue(log);

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (n: string) => fake.headers.get(n.toLowerCase()) ?? null,
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => null,
}));
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({
    AUTH_SECRET: "test-secret-for-unit-tests-only-0123456789",
  }),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log,
    config: { unhandledErrorPolicy: "respond_500" },
    clock: { now: () => new Date("2026-11-10T00:00:00Z") },
  }),
}));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => fake.memory.store,
}));

import {
  issueAgentApiKey,
  resolveRequestIdentity,
} from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { POST as confirm } from "@/app/api/v1/agent/credentials/confirm/route";
import { POST as revoke } from "@/app/api/v1/agent/credentials/revoke/route";
import { POST as rotate } from "@/app/api/v1/agent/credentials/rotate/route";
import { POST as upgrade } from "@/app/api/v1/agent/credentials/upgrade/route";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

const USER = "agent-user-1";
const OTHER = "agent-user-2";
const post = (
  handler: (r: NextRequest, c: never) => Promise<Response>,
  key: string | null,
  body?: unknown
) => {
  fake.headers.clear();
  if (key) fake.headers.set("authorization", `Bearer ${key}`);
  return handler(
    new NextRequest("http://localhost/api/v1/agent/credentials/x", {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    undefined as never
  );
};
/** An ordinary bearer route: the real resolver decides. */
const ordinary = wrapRouteHandlerWithLogging(
  { routeId: "test.ordinary", auth: { mode: "required", getSessionUser } },
  async (_ctx, _req, user) =>
    NextResponse.json({ id: user.id, name: user.displayName })
);
const ping = (key: string | null) => post(ordinary as never, key);
const v1 = () => issueAgentApiKey({ userId: USER, displayName: "Flock" });

/** v1 -> upgrade -> confirm: an active v2 key. */
async function activeV2() {
  const up = await (await post(upgrade as never, v1())).json();
  await post(confirm as never, up.apiKey);
  return up as { apiKey: string; credentialId: string; userId: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  fake.memory = memoryCredentialStore({
    users: { [USER]: {}, [OTHER]: {} },
  }) as never;
});

describe("upgrade", () => {
  it("a v1 key gets a pending v2 key for the SAME user id; pending does not authenticate ordinary routes; confirm activates it", async () => {
    const res = await post(upgrade as never, v1());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ userId: USER, status: "pending" });
    expect(body.apiKey).toMatch(/^cogni_ag_sk_v2_/);

    expect((await ping(body.apiKey)).status).toBe(401);
    const confirmed = await post(confirm as never, body.apiKey);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({
      userId: USER,
      status: "active",
      replay: false,
    });

    const ok = await ping(body.apiKey);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: USER, name: `name-${USER}` });
  });

  it("v1 coexistence while pending; v1_superseded once the v2 key is confirmed, and still after it is revoked", async () => {
    const key = v1();
    expect((await ping(key)).status).toBe(200);
    const pending = await (await post(upgrade as never, key)).json();
    expect((await ping(key)).status).toBe(200); // the v2 key is only pending: the v1 key keeps working
    await post(confirm as never, pending.apiKey);
    const superseded = await ping(key);
    expect(superseded.status).toBe(401);
    expect(await superseded.json()).toEqual({ error: "v1_superseded" });
    expect((await ping(pending.apiKey)).status).toBe(200);
    // Revoking the v2 key must not revive the leaked-or-old v1 key, and the v1 key cannot re-upgrade.
    await post(revoke as never, pending.apiKey);
    expect((await ping(pending.apiKey)).status).toBe(401);
    expect((await ping(key)).status).toBe(401);
    expect((await post(upgrade as never, key)).status).toBe(401);
  });

  it("refuses no key, a forged v1 key, and a v2 key (V1_ONLY); a second upgrade with the superseded v1 key is 401", async () => {
    expect((await post(upgrade as never, null)).status).toBe(401);
    expect(
      (await post(upgrade as never, "cogni_ag_sk_v1_forged.sig")).status
    ).toBe(401);
    const v2 = await activeV2();
    const viaV2 = await post(upgrade as never, v2.apiKey);
    expect(viaV2.status).toBe(403);
    expect(await viaV2.json()).toEqual({ error: "v1_bearer_required" });
    const again = await post(upgrade as never, v1());
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "v1_superseded" });
  });

  it("a user the store refuses (wallet) is 403 not_agent_key", async () => {
    fake.memory = memoryCredentialStore({
      users: { [USER]: { wallet: true } },
    }) as never;
    const res = await post(upgrade as never, v1());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_agent_key" });
  });
});

describe("rotate + confirm", () => {
  it("rotate returns a pending successor for the same user; confirm swaps: the old key is dead, the new one works", async () => {
    const old = await activeV2();
    const rotated = await post(rotate as never, old.apiKey);
    expect(rotated.status).toBe(200);
    const next = await rotated.json();
    expect(next).toMatchObject({ userId: USER, status: "pending" });
    expect(next.credentialId).not.toBe(old.credentialId);
    expect((await ping(old.apiKey)).status).toBe(200); // overlap = the pending window only
    expect((await post(confirm as never, next.apiKey)).status).toBe(200);
    expect((await ping(old.apiKey)).status).toBe(401);
    expect((await ping(next.apiKey)).status).toBe(200);
  });

  it("confirm is idempotent (replay true), and rotate called twice returns a new key and kills the first pending one", async () => {
    const old = await activeV2();
    const first = await (await post(rotate as never, old.apiKey)).json();
    const second = await (await post(rotate as never, old.apiKey)).json();
    expect(second.apiKey).not.toBe(first.apiKey);
    expect((await post(confirm as never, first.apiKey)).status).toBe(401); // revoked: not accepted by the auth shell
    expect((await post(confirm as never, second.apiKey)).status).toBe(200);
    const replay = await post(confirm as never, second.apiKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replay: true });
  });

  it("a renew_only key may rotate but is refused on ordinary routes", async () => {
    const old = await activeV2();
    fake.memory.advance(31 * 24 * 3600);
    expect((await ping(old.apiKey)).status).toBe(401);
    expect((await post(rotate as never, old.apiKey)).status).toBe(200);
  });

  it("a pending key cannot rotate; no key and junk are 401 with a Bearer challenge", async () => {
    const pending = await (await post(upgrade as never, v1())).json();
    expect((await post(rotate as never, pending.apiKey)).status).toBe(401);
    const res = await post(rotate as never, null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    expect((await post(rotate as never, "cogni_ag_sk_v2_junk")).status).toBe(
      401
    );
  });
});

describe("revoke (A7)", () => {
  it("revoking one key 401s only it; another user's key stays 200; a foreign credential id is 404", async () => {
    const mine = await activeV2();
    const otherUp = await (
      await post(
        upgrade as never,
        issueAgentApiKey({ userId: OTHER, displayName: "Other" })
      )
    ).json();
    await post(confirm as never, otherUp.apiKey);

    expect(
      (
        await post(revoke as never, mine.apiKey, {
          credentialId: otherUp.credentialId,
        })
      ).status
    ).toBe(404);
    expect((await ping(otherUp.apiKey)).status).toBe(200);

    const res = await post(revoke as never, mine.apiKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      credentialId: mine.credentialId,
      revoked: true,
    });
    expect((await ping(mine.apiKey)).status).toBe(401);
    expect((await ping(otherUp.apiKey)).status).toBe(200);
    expect(await resolveRequestIdentityFor(otherUp.apiKey)).toMatchObject({
      id: OTHER,
    });
  });

  it("revoking an old key also kills its pending successor", async () => {
    const old = await activeV2();
    const next = await (await post(rotate as never, old.apiKey)).json();
    await post(revoke as never, old.apiKey);
    expect((await post(confirm as never, next.apiKey)).status).toBe(401);
  });
});

describe("store outage", () => {
  it("is 503 authz_unavailable on an ordinary route and on a credential route, never 401", async () => {
    const v2 = await activeV2();
    fake.memory.outage.failing = true;
    const ordinaryRes = await ping(v2.apiKey);
    expect(ordinaryRes.status).toBe(503);
    expect(await ordinaryRes.json()).toEqual({ error: "authz_unavailable" });
    expect((await post(rotate as never, v2.apiKey)).status).toBe(503);
    // The v1 gate reads the store too: an outage there is 503, not a false 401.
    expect((await ping(v1())).status).toBe(503);
  });

  it("an outage AFTER a successful verify (mid-handler) is 503 on rotate, confirm, revoke and upgrade, never a 500", async () => {
    const v2 = await activeV2();
    const v1Key = issueAgentApiKey({ userId: OTHER, displayName: "Other" });
    for (const [method, call] of [
      ["issueSuccessor", () => post(rotate as never, v2.apiKey)],
      ["confirm", () => post(confirm as never, v2.apiKey)],
      ["revoke", () => post(revoke as never, v2.apiKey)],
      ["issueUpgrade", () => post(upgrade as never, v1Key)],
    ] as const) {
      fake.memory.outage.failOn = method;
      const res = await call();
      expect(res.status, method).toBe(503);
      expect(await res.json(), method).toEqual({ error: "authz_unavailable" });
    }
    fake.memory.outage.failOn = null;
    expect((await ping(v2.apiKey)).status).toBe(200); // nothing was half-applied
  });

  it("a perimeter-shaped bad token (wrong charset or length) is 401 and never reads the store", async () => {
    fake.memory.outage.failing = true;
    expect(
      (await post(rotate as never, `cogni_ag_sk_v2_${"a".repeat(42)}!`)).status
    ).toBe(401);
    expect(
      (await post(rotate as never, `cogni_ag_sk_v2_${"a".repeat(44)}`)).status
    ).toBe(401);
  });
});

async function resolveRequestIdentityFor(key: string) {
  fake.headers.clear();
  fake.headers.set("authorization", `Bearer ${key}`);
  return resolveRequestIdentity();
}
