// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

import {
  createNodeActionGateway,
  type NodeActionGatewayError,
} from "@/features/nodes/node-action-gateway";

const NODE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JTI = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function deps(decision: "allow" | "deny" = "allow") {
  const check = vi
    .fn()
    .mockResolvedValue(
      decision === "allow"
        ? { decision: "allow", code: "authz_allowed", checks: [] }
        : { decision: "deny", code: "authz_denied", checks: [] }
    );
  const sign = vi.fn().mockResolvedValue("signed-assertion");
  const post = vi.fn().mockResolvedValue({
    status: 200,
    contentType: "application/json",
    body: new TextEncoder().encode('{"ok":true}'),
  });
  return {
    values: {
      authorization: {
        check,
        writeRelation: vi.fn(),
        deleteRelation: vi.fn(),
      },
      signer: { sign },
      nodeAddress: {
        resolveNodeAppBaseUrl: vi
          .fn()
          .mockResolvedValue("https://poly.test.cognidao.org"),
      },
      http: { post },
      clock: { now: () => "2026-10-01T12:00:00.000Z" },
      createJti: () => JTI,
    },
    check,
    sign,
    post,
  };
}

const baseInput = {
  node: { nodeId: NODE_ID, slug: "poly" },
  issuer: "https://test.cognidao.org",
  environment: "candidate-a",
  actorId: "user:user-123" as const,
};

describe("node action gateway", () => {
  it("authorizes, binds, signs, and forwards the exact body", async () => {
    const d = deps();
    await createNodeActionGateway(d.values)({
      ...baseInput,
      action: "poly.wallet.reset_connection",
      input: { billing_account_id: "acct-1" },
    });

    expect(d.check).toHaveBeenCalledWith({
      actorId: "user:user-123",
      action: "node.repair",
      resource: `node:${NODE_ID}`,
      context: { tenantId: NODE_ID, nodeId: NODE_ID },
    });
    expect(d.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "node.action.v1",
        aud: `urn:cogni:node-action:${NODE_ID}`,
        nodeId: NODE_ID,
        environment: "candidate-a",
        actorId: "user:user-123",
        action: "poly.wallet.reset_connection",
        target: "/api/internal/node-actions/poly/wallet/reset-connection",
        jti: JTI,
      })
    );
    expect(d.post).toHaveBeenCalledWith({
      url: "https://poly.test.cognidao.org/api/internal/node-actions/poly/wallet/reset-connection",
      assertion: "signed-assertion",
      body: '{"billing_account_id":"acct-1"}',
    });
  });

  it("uses a distinct funds-recovery capability", async () => {
    const d = deps();
    await createNodeActionGateway(d.values)({
      ...baseInput,
      action: "poly.wallet.recover_funds",
      input: {},
    });
    expect(d.check).toHaveBeenCalledWith(
      expect.objectContaining({ action: "node.recover_funds" })
    );
  });

  it("rejects an action absent from the server registry before authorization", async () => {
    const d = deps();
    await expect(
      createNodeActionGateway(d.values)({
        ...baseInput,
        action: "poly.arbitrary.call",
        input: {},
      })
    ).rejects.toMatchObject<NodeActionGatewayError>({
      code: "unsupported_action",
    });
    expect(d.check).not.toHaveBeenCalled();
    expect(d.sign).not.toHaveBeenCalled();
  });

  it("fails closed on an OpenFGA deny", async () => {
    const d = deps("deny");
    await expect(
      createNodeActionGateway(d.values)({
        ...baseInput,
        action: "poly.egress.read",
        input: {},
      })
    ).rejects.toMatchObject<NodeActionGatewayError>({ code: "authz_denied" });
    expect(d.sign).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  it("fails closed when OpenFGA is not configured", async () => {
    const d = deps();
    await expect(
      createNodeActionGateway({ ...d.values, authorization: undefined })({
        ...baseInput,
        action: "poly.egress.read",
        input: {},
      })
    ).rejects.toMatchObject<NodeActionGatewayError>({
      code: "authz_unavailable",
    });
  });

  it("rejects a payload larger than the signed gateway limit", async () => {
    const d = deps();
    await expect(
      createNodeActionGateway(d.values)({
        ...baseInput,
        action: "poly.egress.read",
        input: { value: "x".repeat(65_536) },
      })
    ).rejects.toMatchObject<NodeActionGatewayError>({
      code: "request_too_large",
    });
    expect(d.sign).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });
});
