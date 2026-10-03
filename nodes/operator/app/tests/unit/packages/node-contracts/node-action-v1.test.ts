// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Frozen cross-repository conformance vectors for node.action.v1. */

import { createHash } from "node:crypto";

import {
  NODE_ACTION_V1_PROTOCOL,
  NODE_ACTION_V1_PROTOCOL_SHA256,
  NodeActionClaimsSchema,
  nodeActionAudience,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const claims = {
  type: "node.action.v1",
  protocol: NODE_ACTION_V1_PROTOCOL_SHA256,
  iss: "https://cognidao.org",
  aud: nodeActionAudience(NODE_ID),
  nodeId: NODE_ID,
  environment: "candidate-a",
  actorId: "user:11111111-1111-4111-8111-111111111111",
  action: "poly.egress.read",
  target: "/api/internal/node-actions/poly/egress-read",
  bodyHash: "a".repeat(64),
  iat: 1_700_000_000,
  exp: 1_700_000_060,
  jti: "33333333-3333-4333-8333-333333333333",
};

describe("node.action.v1 frozen contract", () => {
  it("matches the fleet-wide protocol fingerprint", () => {
    expect(
      createHash("sha256")
        .update(JSON.stringify(NODE_ACTION_V1_PROTOCOL))
        .digest("hex")
    ).toBe(NODE_ACTION_V1_PROTOCOL_SHA256);
  });

  it("accepts a canonical, 60-second action assertion", () => {
    expect(NodeActionClaimsSchema.safeParse(claims).success).toBe(true);
  });

  it.each([
    { aud: nodeActionAudience("44444444-4444-4444-8444-444444444444") },
    { exp: claims.iat + 61 },
    { actorId: "anonymous" },
    { target: "https://attacker.invalid/action" },
    { bodyHash: "A".repeat(64) },
    { futureClaim: true },
  ])("rejects an unbound or widened assertion %#", (change) => {
    expect(
      NodeActionClaimsSchema.safeParse({ ...claims, ...change }).success
    ).toBe(false);
  });
});
