// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/auth/request-identity`
 * Purpose: Regression tests for resolveRequestIdentity — guards against the circular re-export
 *   that caused unbounded async recursion and candidate-a OOM in an earlier revision of the
 *   agent-first auth lane.
 * Scope: Exercises the real resolver chain (request-identity.ts → session.ts → server.ts). Does
 *   not mock @/app/_lib/auth/request-identity or @/app/_lib/auth/session — only the leaf
 *   getServerSessionUser and next/headers. This placement is intentional: any re-introduction of
 *   the cycle would blow this test's call budget immediately.
 * Invariants:
 *   - NO_RECURSION: a non-bearer request calls the leaf session getter exactly once.
 *   - BEARER_PARSED: a bearer request never reaches the session getter.
 *   - BOUNDED_WORK: 1000 sequential resolver calls complete under 1 second with ≤ 1000 leaf calls.
 * Side-effects: none (mocked next/headers and @/lib/auth/server).
 * Links: src/app/_lib/auth/request-identity.ts, src/app/_lib/auth/session.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetServerSessionUser = vi.fn();
const mockHeaders = vi.fn();

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    mockGetServerSessionUser(...args),
}));

vi.mock("next/headers", () => ({
  headers: (...args: unknown[]) => mockHeaders(...args),
}));

vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ AUTH_SECRET: "test-secret-for-unit-tests-only" }),
}));

// task.5474 S0: the resolver's v1 path asks the credential store whether the user was upgraded
// (assertV1NotSuperseded), and the v2 path verifies by hash lookup.
const mockEverConfirmed = vi.fn();
const mockLookup = vi.fn();
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => ({
    everConfirmed: (...args: unknown[]) => mockEverConfirmed(...args),
    lookup: (...args: unknown[]) => mockLookup(...args),
  }),
  admitCredentialLookup: () => true,
  recordCredentialMiss: () => {},
}));

import { formatRevocableKey } from "@cogni-dao/agent-grants/credentials";
import {
  issueAgentApiKey,
  peekAgentKeyExpiry,
  resolveRequestIdentity,
} from "@/app/_lib/auth/request-identity";

function headersFromRecord(record: Record<string, string>) {
  const normalized = new Map(
    Object.entries(record).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
  };
}

const FAKE_SESSION_USER = {
  id: "user-42",
  walletAddress: null,
  displayName: "Tester",
  avatarColor: null,
};

describe("resolveRequestIdentity — circular-recursion regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls getServerSessionUser exactly once for a cookie-only request", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({}));
    mockGetServerSessionUser.mockResolvedValue(FAKE_SESSION_USER);

    const user = await resolveRequestIdentity();

    expect(user).toEqual(FAKE_SESSION_USER);
    expect(mockGetServerSessionUser).toHaveBeenCalledTimes(1);
  });

  it("returns null without touching the session getter on an invalid bearer", async () => {
    mockHeaders.mockResolvedValue(
      headersFromRecord({
        authorization: "Bearer cogni_ag_sk_v1_not-a-real-token",
      })
    );

    const user = await resolveRequestIdentity();

    expect(user).toBeNull();
    expect(mockGetServerSessionUser).not.toHaveBeenCalled();
  });

  it("bounds work at O(1) per call across 1000 non-bearer requests", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({}));
    mockGetServerSessionUser.mockResolvedValue(null);

    const ITERATIONS = 1000;
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await resolveRequestIdentity();
    }
    const elapsedMs = performance.now() - start;

    // If request-identity.ts ever recurses into itself via session.ts, this count
    // explodes (each outer call triggers N inner calls) or the loop never terminates.
    expect(mockGetServerSessionUser).toHaveBeenCalledTimes(ITERATIONS);
    // Loose upper bound — a healthy resolver finishes 1000 mocked calls in well under 1s.
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("resolveRequestIdentity — v2 hashed keys and v1 supersession (task.5474 S0)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEverConfirmed.mockResolvedValue(false);
    mockLookup.mockResolvedValue(null);
  });

  it("resolves an active v2 key from the store and never touches the session", async () => {
    const token = formatRevocableKey("a".repeat(43));
    mockHeaders.mockResolvedValue(
      headersFromRecord({ authorization: `Bearer ${token}` })
    );
    mockLookup.mockResolvedValue({
      credentialId: "cred-1",
      userId: "agent-9",
      name: "Agent 9",
      state: "active",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      renewUntil: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });

    const user = await resolveRequestIdentity();

    expect(user).toMatchObject({ id: "agent-9", displayName: "Agent 9" });
    expect(mockGetServerSessionUser).not.toHaveBeenCalled();
  });

  it("returns null for a revoked/unknown v2 key (BEARER_CLAIMS_EXCLUSIVE: no cookie fallback)", async () => {
    mockHeaders.mockResolvedValue(
      headersFromRecord({
        authorization: `Bearer ${formatRevocableKey("b".repeat(43))}`,
      })
    );

    expect(await resolveRequestIdentity()).toBeNull();
    expect(mockGetServerSessionUser).not.toHaveBeenCalled();
  });

  it("throws CredentialStoreUnavailableError on a v2 store outage (503, never a false 401)", async () => {
    mockHeaders.mockResolvedValue(
      headersFromRecord({
        authorization: `Bearer ${formatRevocableKey("c".repeat(43))}`,
      })
    );
    mockLookup.mockRejectedValue(new Error("db down"));

    await expect(resolveRequestIdentity()).rejects.toMatchObject({
      name: "CredentialStoreUnavailableError",
    });
  });

  it("refuses a valid v1 key whose user holds a confirmed v2 key (V1_SUPERSEDED)", async () => {
    const token = issueAgentApiKey({ userId: "user-up", displayName: "Up" });
    mockHeaders.mockResolvedValue(
      headersFromRecord({ authorization: `Bearer ${token}` })
    );
    mockEverConfirmed.mockResolvedValue(true);

    await expect(resolveRequestIdentity()).rejects.toMatchObject({
      name: "V1SupersededError",
    });
  });

  it("still resolves a valid v1 key for a never-upgraded user (V1_PATH_UNCHANGED)", async () => {
    const token = issueAgentApiKey({ userId: "user-v1", displayName: "V1" });
    mockHeaders.mockResolvedValue(
      headersFromRecord({ authorization: `Bearer ${token}` })
    );

    expect(await resolveRequestIdentity()).toMatchObject({ id: "user-v1" });
    expect(mockGetServerSessionUser).not.toHaveBeenCalled();
  });
});

describe("peekAgentKeyExpiry — agent-key liveness for /agent/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEverConfirmed.mockResolvedValue(false);
    mockLookup.mockResolvedValue(null);
  });

  it("returns the store expiry for an active v2 bearer", async () => {
    mockHeaders.mockResolvedValue(
      headersFromRecord({
        authorization: `Bearer ${formatRevocableKey("d".repeat(43))}`,
      })
    );
    const exp = new Date(Date.now() + 86_400_000);
    mockLookup.mockResolvedValue({
      credentialId: "cred-2",
      userId: "agent-2",
      name: null,
      state: "active",
      expiresAt: exp.toISOString(),
      renewUntil: new Date(exp.getTime() + 86_400_000).toISOString(),
    });

    expect(await peekAgentKeyExpiry()).toBe(Math.floor(exp.getTime() / 1000));
  });

  it("returns the key's future expiry for a valid agent bearer", async () => {
    const token = issueAgentApiKey({
      userId: "user-7",
      displayName: "Agent 7",
    });
    mockHeaders.mockResolvedValue(
      headersFromRecord({ authorization: `Bearer ${token}` })
    );

    const exp = await peekAgentKeyExpiry();

    expect(exp).not.toBeNull();
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // Never consults the cookie session on the bearer path.
    expect(mockGetServerSessionUser).not.toHaveBeenCalled();
  });

  it("returns null for a cookie-only request (no bearer)", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({}));

    expect(await peekAgentKeyExpiry()).toBeNull();
  });

  it("returns null for an invalid/forged bearer", async () => {
    mockHeaders.mockResolvedValue(
      headersFromRecord({
        authorization: "Bearer cogni_ag_sk_v1_not-a-real-token",
      })
    );

    expect(await peekAgentKeyExpiry()).toBeNull();
  });
});
