// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Frozen cross-repository conformance vectors for identity.attestation.v1. */

import { createHash } from "node:crypto";

import {
  IDENTITY_ATTESTATION_V1_PROTOCOL,
  IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
  IdentityAttestationClaimsSchema,
  IdentityAttestationOriginSchema,
  IdentityAttestationRequestSchema,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = "node_generated_nonce_0123456789abcdef";

const validClaims = {
  type: "identity.attestation.v1",
  protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
  iss: "https://cognidao.org",
  sub: "11111111-1111-4111-8111-111111111111",
  aud: `urn:cogni:node:${NODE_ID}`,
  nodeId: NODE_ID,
  nonce: NONCE,
  targetOrigin: "https://node-template.cognidao.org",
  wallet: "0xabcdef0123456789abcdef0123456789abcdef01",
  github: { id: "12345", login: null },
  iat: 1_700_000_000,
  exp: 1_700_000_600,
  jti: "33333333-3333-4333-8333-333333333333",
};

describe("identity.attestation.v1 frozen contract", () => {
  it("matches the fleet-wide protocol fingerprint", () => {
    const digest = createHash("sha256")
      .update(JSON.stringify(IDENTITY_ATTESTATION_V1_PROTOCOL))
      .digest("hex");
    expect(digest).toBe(IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256);
  });

  it("accepts the canonical request and nullable GitHub login", () => {
    expect(
      IdentityAttestationRequestSchema.safeParse({
        protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
        nodeId: NODE_ID,
        nonce: NONCE,
        targetOrigin: validClaims.targetOrigin,
      }).success
    ).toBe(true);
    expect(IdentityAttestationClaimsSchema.safeParse(validClaims).success).toBe(
      true
    );
  });

  it.each([
    "http://cognidao.org",
    "https://user:pass@cognidao.org",
    "https://cognidao.org/path",
    "https://cognidao.org?query=yes",
    "https://cognidao.org/#fragment",
  ])("rejects unsafe or non-canonical origin %s", (origin) => {
    expect(IdentityAttestationOriginSchema.safeParse(origin).success).toBe(
      false
    );
  });

  it("rejects cross-node audiences and unversioned extra claims", () => {
    expect(
      IdentityAttestationClaimsSchema.safeParse({
        ...validClaims,
        aud: "urn:cogni:node:44444444-4444-4444-8444-444444444444",
      }).success
    ).toBe(false);
    expect(
      IdentityAttestationClaimsSchema.safeParse({
        ...validClaims,
        futureClaim: true,
      }).success
    ).toBe(false);
  });

  it("rejects a peer with a different protocol fingerprint", () => {
    expect(
      IdentityAttestationRequestSchema.safeParse({
        protocol: "0".repeat(64),
        nodeId: NODE_ID,
        nonce: NONCE,
        targetOrigin: validClaims.targetOrigin,
      }).success
    ).toBe(false);
    expect(
      IdentityAttestationClaimsSchema.safeParse({
        ...validClaims,
        protocol: "0".repeat(64),
      }).success
    ).toBe(false);
  });
});
