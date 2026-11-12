// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/agent-credentials.hasroles`
 * Purpose: The operator-only `hasRoles` composition (task.5474 C5, BINDING_BEFORE_UPGRADE): agent_roles SQL first, then OpenFGA
 *   listRelations; an authz outage or a missing adapter is a store outage (503 class), never a silent "no roles".
 * Scope: Role composition and bounded lookup admission with suspended unit stores; no database or OpenFGA.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/story.5156
 */

import {
  type CredentialLookup,
  type CredentialSql,
  formatRevocableKey,
} from "@cogni-dao/agent-grants/credentials";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryCredentialStore } from "../../_fakes/agent-credentials-memory-store";

const fake = vi.hoisted(() => ({
  sqlRows: [] as unknown[],
  sqlCalls: 0,
  authorization: undefined as
    | undefined
    | { listRelations: (user: string) => Promise<unknown> },
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ authorization: fake.authorization }),
  resolveServiceDb: () => {
    throw new Error("not used in this test");
  },
}));

import {
  operatorHasRoles,
  verifyAgentCredential,
} from "@/bootstrap/agent-credentials";
import {
  credentialLookupLimiter,
  TokenBucketRateLimiter,
} from "@/bootstrap/http/rateLimiter";

const sqlTag = (async () => {
  fake.sqlCalls += 1;
  return fake.sqlRows;
}) as unknown as CredentialSql;

describe("operatorHasRoles — C5 roles read spans both planes, fail closed", () => {
  beforeEach(() => {
    fake.sqlRows = [];
    fake.sqlCalls = 0;
    fake.authorization = undefined;
  });

  it("a live agent_roles row answers true without consulting OpenFGA", async () => {
    fake.sqlRows = [{ has_roles: true }];
    const listRelations = vi.fn();
    fake.authorization = { listRelations };

    expect(await operatorHasRoles(sqlTag)("user-1")).toBe(true);
    expect(listRelations).not.toHaveBeenCalled();
  });

  it("no SQL row + OpenFGA tuples present answers true; no tuples answers false", async () => {
    fake.authorization = {
      listRelations: async () => ({
        decision: "success",
        tuples: [{ object: "node:x", relation: "developer" }],
      }),
    };
    expect(await operatorHasRoles(sqlTag)("user-2")).toBe(true);

    fake.authorization = {
      listRelations: async () => ({ decision: "success", tuples: [] }),
    };
    expect(await operatorHasRoles(sqlTag)("user-2")).toBe(false);
  });

  it("a missing authz adapter is a store outage (fail closed), never false", async () => {
    fake.authorization = undefined;
    await expect(operatorHasRoles(sqlTag)("user-3")).rejects.toMatchObject({
      name: "CredentialStoreUnavailableError",
    });
  });

  it("an OpenFGA non-success decision is a store outage (fail closed), never false", async () => {
    fake.authorization = {
      listRelations: async () => ({
        decision: "unavailable",
        code: "authz_list_unavailable",
      }),
    };
    await expect(operatorHasRoles(sqlTag)("user-4")).rejects.toMatchObject({
      name: "CredentialStoreUnavailableError",
    });
  });
});

describe("credential lookup admission — reserve before async work, charge only misses", () => {
  const token = formatRevocableKey("a".repeat(43));
  const active: CredentialLookup = {
    credentialId: "fixture-key",
    userId: "fixture-user",
    name: null,
    state: "active",
    expiresAt: "2026-12-01T00:00:00Z",
    renewUntil: "2026-12-02T00:00:00Z",
  };
  const headers = (ip: string) => ({
    get: (name: string) => (name === "x-real-ip" ? ip : null),
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suspended concurrent lookups admit only two across new clients; success releases reservations", async () => {
    const { store } = memoryCredentialStore({ users: {} });
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let started!: () => void;
    const firstTwo = new Promise<void>((resolve) => {
      started = resolve;
    });
    const lookup = vi.spyOn(store, "lookup").mockImplementation(async () => {
      if (lookup.mock.calls.length === 2) started();
      await barrier;
      return active;
    });
    const requests = Array.from({ length: 8 }, (_, i) =>
      verifyAgentCredential(
        store,
        token,
        ["active"],
        headers(`198.51.100.${i + 1}`)
      )
    );
    try {
      await firstTwo;
      expect(await Promise.all(requests.slice(2))).toEqual(
        Array.from({ length: 6 }, () => ({ ok: false, reason: "rate_limited" }))
      );
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      resume();
      await Promise.all(requests);
    }
    lookup.mockResolvedValue(active);
    expect(
      await verifyAgentCredential(
        store,
        token,
        ["active"],
        headers("198.51.100.20")
      )
    ).toMatchObject({ ok: true });
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("reserves the final miss token while suspended; a miss spends it exactly once", async () => {
    const ip = "198.51.100.40";
    for (let i = 0; i < 399; i++)
      expect(credentialLookupLimiter.consume(ip)).toBe(true);
    const { store } = memoryCredentialStore({ users: {} });
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const lookup = vi.spyOn(store, "lookup").mockImplementation(async () => {
      await barrier;
      return null;
    });
    const first = verifyAgentCredential(store, token, ["active"], headers(ip));
    try {
      expect(
        await verifyAgentCredential(store, token, ["active"], headers(ip))
      ).toEqual({ ok: false, reason: "rate_limited" });
    } finally {
      resume();
      await first;
    }
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(credentialLookupLimiter.getTokens(ip)).toBe(0);
    expect(
      await verifyAgentCredential(store, token, ["active"], headers(ip))
    ).toEqual({ ok: false, reason: "rate_limited" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("refunds success and store outage, and bad checksums never reserve or reach the store", async () => {
    const ip = "198.51.100.60";
    credentialLookupLimiter.consume(ip);
    const balance = credentialLookupLimiter.getTokens(ip);
    const { store } = memoryCredentialStore({ users: {} });
    const lookup = vi.spyOn(store, "lookup").mockResolvedValue(active);
    for (let i = 0; i < 4; i++)
      expect(
        await verifyAgentCredential(store, token, ["active"], headers(ip))
      ).toMatchObject({ ok: true });
    lookup.mockRejectedValue(new Error("fixture outage"));
    for (let i = 0; i < 4; i++)
      expect(
        await verifyAgentCredential(store, token, ["active"], headers(ip))
      ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(credentialLookupLimiter.getTokens(ip)).toBe(balance);
    const calls = lookup.mock.calls.length;
    expect(
      await verifyAgentCredential(
        store,
        `${token.slice(0, -1)}!`,
        ["active"],
        headers(ip)
      )
    ).toEqual({ ok: false, reason: "invalid" });
    expect(lookup).toHaveBeenCalledTimes(calls);
    lookup.mockResolvedValue(active);
    expect(
      await verifyAgentCredential(store, token, ["active"], headers(ip))
    ).toMatchObject({ ok: true });
  });

  it("reservation release is idempotent and cannot mint extra concurrency", () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      burstSize: 0,
      refillRate: 0,
      maxConcurrent: 1,
    });
    try {
      const release = limiter.reserve("a");
      expect(release).not.toBeNull();
      expect(limiter.reserve("b")).toBeNull();
      release?.();
      release?.();
      const next = limiter.reserve("b");
      expect(next).not.toBeNull();
      expect(limiter.reserve("c")).toBeNull();
      next?.();
    } finally {
      limiter.destroy();
    }
  });
});
