// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/node-service-links/service`
 * Purpose: The operator's link service: start, one poll step, key rejection, caps (story.0038).
 * Scope: In-memory fakes for every port; no IO.
 * Side-effects: none
 * @internal
 */

import {
  SERVICE_ENROLLMENT_JWT_TYP,
  SERVICE_ENROLLMENT_V1,
} from "@cogni/node-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createNodeServiceLinkService,
  SERVICE_LINK_STARTS_PER_HOUR,
} from "@/features/node-service-links/service";
import {
  type EnrollmentPollResult,
  EnrollmentTransportError,
  type NewNodeServiceLink,
  type NodeServiceLinkRecord,
  OpenServiceLinkExistsError,
} from "@/ports";

const NODE = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const AUDIENCE = "https://x-test.example.org";

function setup(over: { poll?: unknown[]; confirmOk?: boolean } = {}) {
  let now = new Date("2026-11-11T12:00:00Z");
  const rows = new Map<string, NodeServiceLinkRecord>();
  const secrets = new Map<
    string,
    { deviceCode: string; cnfPrivateJwk: Record<string, unknown> }
  >();
  const polledAt = new Map<string, number>();
  let starts = 0;
  const store = {
    insert: vi.fn(async (i: NewNodeServiceLink) => {
      for (const r of rows.values())
        if (r.nodeId === i.nodeId && ["pending", "connected"].includes(r.state))
          throw new OpenServiceLinkExistsError();
      const r: NodeServiceLinkRecord = {
        id: `00000000-0000-4000-8000-00000000000${rows.size + 1}`,
        nodeId: i.nodeId,
        service: i.service,
        audience: i.audience,
        state: "pending",
        requestedByUserId: i.requestedByUserId,
        jti: i.jti,
        pollIntervalS: i.pollIntervalS,
        lastPolledAt: null,
        deviceCodeExpiresAt: i.deviceCodeExpiresAt,
        connectionId: null,
        failureCode: null,
        createdAt: now,
        connectedAt: null,
      };
      rows.set(r.id, r);
      secrets.set(r.id, {
        deviceCode: i.deviceCode,
        cnfPrivateJwk: i.cnfPrivateJwk,
      });
      return r;
    }),
    findById: vi.fn(async (id: string) => rows.get(id) ?? null),
    findOpen: vi.fn(
      async (nodeId: string) =>
        [...rows.values()].find(
          (r) =>
            r.nodeId === nodeId && ["pending", "connected"].includes(r.state)
        ) ?? null
    ),
    findConnectedByAudience: vi.fn(
      async (a: string) =>
        [...rows.values()].find(
          (r) => r.audience === a && r.state === "connected"
        ) ?? null
    ),
    readSecrets: vi.fn(async (id: string) =>
      rows.get(id)?.state === "pending" ? (secrets.get(id) ?? null) : null
    ),
    claimPoll: vi.fn(async (id: string, n: Date, gap: number) => {
      const last = polledAt.get(id);
      if (last !== undefined && n.getTime() - last < gap) return false;
      polledAt.set(id, n.getTime());
      return true;
    }),
    setPollInterval: vi.fn(async (id: string, s: number) => {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, pollIntervalS: s });
    }),
    markConnected: vi.fn(async (id: string, connectionId: string) => {
      const r = rows.get(id);
      if (!r || r.state !== "pending") return false;
      rows.set(id, {
        ...r,
        state: "connected",
        connectionId,
        connectedAt: now,
      });
      secrets.delete(id);
      return true;
    }),
    markState: vi.fn(
      async (
        id: string,
        state: NodeServiceLinkRecord["state"],
        failureCode?: string
      ) => {
        const r = rows.get(id);
        if (r) rows.set(id, { ...r, state, failureCode: failureCode ?? null });
        secrets.delete(id);
      }
    ),
    countStartsSince: vi.fn(async () => starts),
  };
  const polls = [...(over.poll ?? [{ kind: "authorization_pending" }])];
  const transport = {
    postEnrollment: vi.fn(async () => ({
      deviceCode: "DEVICE-CODE",
      expiresInS: 86400,
      intervalS: 5,
    })),
    pollToken: vi.fn(async () => polls.shift() as EnrollmentPollResult),
    confirmKey: vi.fn(async () => ({
      ok: over.confirmOk ?? true,
      status: over.confirmOk === false ? 401 : 200,
    })),
  };
  const signer = {
    sign: vi.fn(async (c: unknown) => `signed:${JSON.stringify(c)}`),
  };
  const crypto = {
    generateLinkKeypair: vi.fn(async () => ({
      publicJwk: { kty: "OKP" as const, crv: "X25519" as const, x: "PUBX" },
      privateJwk: { d: "PRIV" },
    })),
    openSealedKey: vi.fn(async () => "cogni_ag_sk_v2_THEKEY"),
  };
  const connections = {
    store: vi.fn(async () => "99999999-9999-4999-8999-999999999999"),
    revoke: vi.fn(async () => undefined),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = createNodeServiceLinkService({
    store,
    signer,
    transport,
    crypto,
    connections,
    issuer: "https://op.example.org",
    now: () => now,
    newId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    log,
  });
  return {
    service,
    store,
    transport,
    signer,
    crypto,
    connections,
    log,
    rows,
    advance: (s: number) => {
      now = new Date(now.getTime() + s * 1000);
    },
    setStarts: (n: number) => {
      starts = n;
    },
  };
}

const startInput = {
  nodeId: NODE,
  service: "git-review" as const,
  audience: AUDIENCE,
  requestedByUserId: USER,
};

describe("node service link service", () => {
  it("start signs an own-typ token for the node audience with a cnf key, posts it, stores a pending link", async () => {
    const t = setup();
    const result = await t.service.start(startInput);
    expect(result).toMatchObject({
      ok: true,
      created: true,
      link: { state: "pending", audience: AUDIENCE },
    });
    const claims = t.signer.sign.mock.calls[0]?.[0] as unknown as {
      iat: number;
      exp: number;
    };
    expect(claims).toMatchObject({
      iss: "https://op.example.org",
      aud: `urn:cogni:node:${NODE}`,
      kind: SERVICE_ENROLLMENT_V1,
      service: "git-review",
      scopes: ["knowledge:read"],
      cnf: { jwk: { kty: "OKP", crv: "X25519", x: "PUBX" } },
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(SERVICE_ENROLLMENT_JWT_TYP).toBe("cogni-service-enrollment+jwt");
    expect(t.transport.postEnrollment).toHaveBeenCalledWith(
      AUDIENCE,
      expect.stringContaining("signed:")
    );
  });

  it("one open link per node: a second start returns it without a second enrollment", async () => {
    const t = setup();
    await t.service.start(startInput);
    const again = await t.service.start(startInput);
    expect(again).toMatchObject({ ok: true, created: false });
    expect(t.transport.postEnrollment).toHaveBeenCalledTimes(1);
  });

  it("caps link starts per developer per hour (429)", async () => {
    const t = setup();
    t.setStarts(SERVICE_LINK_STARTS_PER_HOUR);
    await expect(t.service.start(startInput)).resolves.toEqual({
      ok: false,
      status: 429,
      errorCode: "link_start_rate_limited",
    });
    expect(t.transport.postEnrollment).not.toHaveBeenCalled();
  });

  it("an unreachable or rejecting X is a 502 and stores no link", async () => {
    const t = setup();
    t.transport.postEnrollment.mockRejectedValueOnce(
      new EnrollmentTransportError("origin_unreachable")
    );
    await expect(t.service.start(startInput)).resolves.toMatchObject({
      ok: false,
      status: 502,
      errorCode: "enrollment_origin_unreachable",
    });
    expect(t.rows.size).toBe(0);
  });

  it("poll: pending stays pending; issued opens the key, vaults it, confirms, connects, and never logs the key", async () => {
    const t = setup({
      poll: [
        { kind: "authorization_pending" },
        { kind: "issued", sealedKey: "JWE" },
      ],
    });
    const started = await t.service.start(startInput);
    if (!started.ok) throw new Error("start failed");
    const first = await t.service.get(NODE, started.link.id);
    expect(first?.state).toBe("pending");
    // The slot is claimed before the call: an immediate second step does not poll X again.
    await t.service.get(NODE, started.link.id);
    expect(t.transport.pollToken).toHaveBeenCalledTimes(1);
    t.advance(6);
    const connected = await t.service.get(NODE, started.link.id);
    expect(connected).toMatchObject({
      state: "connected",
      connectionId: "99999999-9999-4999-8999-999999999999",
    });
    expect(t.connections.store).toHaveBeenCalledWith({
      audience: AUDIENCE,
      apiKey: "cogni_ag_sk_v2_THEKEY",
      scopes: ["knowledge:read"],
    });
    expect(t.transport.confirmKey).toHaveBeenCalledWith(
      AUDIENCE,
      "cogni_ag_sk_v2_THEKEY"
    );
    expect(
      JSON.stringify([...t.log.info.mock.calls, ...t.log.warn.mock.calls])
    ).not.toMatch(/cogni_ag_sk_|DEVICE-CODE|JWE/);
  });

  it("an unconfirmed key is revoked and the link stays pending", async () => {
    const t = setup({
      poll: [{ kind: "issued", sealedKey: "JWE" }],
      confirmOk: false,
    });
    const started = await t.service.start(startInput);
    if (!started.ok) throw new Error("start failed");
    t.advance(6);
    const link = await t.service.get(NODE, started.link.id);
    expect(link?.state).toBe("pending");
    expect(t.connections.revoke).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999"
    );
  });

  it.each([
    ["access_denied"],
    ["expired_token"],
  ] as const)("%s fails the link", async (kind) => {
    const t = setup({ poll: [{ kind }] });
    const started = await t.service.start(startInput);
    if (!started.ok) throw new Error("start failed");
    t.advance(6);
    await expect(t.service.get(NODE, started.link.id)).resolves.toMatchObject({
      state: "failed",
      failureCode: kind,
    });
  });

  it("a 401 on the stored key revokes it and marks the link needs_reenroll", async () => {
    const t = setup({ poll: [{ kind: "issued", sealedKey: "JWE" }] });
    const started = await t.service.start(startInput);
    if (!started.ok) throw new Error("start failed");
    t.advance(6);
    await t.service.get(NODE, started.link.id);
    await t.service.markKeyRejected(AUDIENCE, "git-review");
    const link = await t.store.findById(started.link.id);
    expect(link).toMatchObject({
      state: "needs_reenroll",
      failureCode: "key_rejected",
    });
    expect(t.connections.revoke).toHaveBeenCalled();
  });

  it("a link of another node is not readable by id", async () => {
    const t = setup();
    const started = await t.service.start(startInput);
    if (!started.ok) throw new Error("start failed");
    await expect(
      t.service.get("33333333-3333-4333-8333-333333333333", started.link.id)
    ).resolves.toBeNull();
  });

  it("race: a link that left pending while polling is not connected and the new key is revoked", async () => {
    const t = setup({ poll: [{ kind: "issued", sealedKey: "JWE" }] });
    const started = await t.service.start(startInput);
    if (!started.ok) throw new Error("start failed");
    t.store.markConnected.mockResolvedValueOnce(false);
    t.advance(6);
    const link = await t.service.get(NODE, started.link.id);
    expect(link?.state).toBe("pending");
    expect(t.connections.revoke).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999"
    );
  });

  it("find reads the stored link without a poll step", async () => {
    const t = setup();
    const started = await t.service.start(startInput);
    if (!started.ok) throw new Error("start failed");
    await expect(t.service.find(NODE, started.link.id)).resolves.toMatchObject({
      state: "pending",
    });
    expect(t.transport.pollToken).not.toHaveBeenCalled();
  });
});
