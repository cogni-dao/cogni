// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Frozen cross-repository conformance vectors for github.comment.attestation.v1 (task.0095).
 * The node-template copy of the contract file is byte-identical (git blob f141caaaa746615da8f5293242bc58c41c4ebf5d at node-template PR #333
 * head cd1b795b772b8859600b7e596581c6b427a9a2f7) and runs the same vectors.
 */

import { createHash } from "node:crypto";

import {
  GITHUB_COMMENT_ATTESTATION_V1,
  GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL,
  GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256,
  GithubCommentAttestationClaimsSchema,
  GithubCommentAttestationRequestSchema,
  IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
  IdentityAttestationClaimsSchema,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = "request_nonce_0123456789abcdef_ABCDEF";

const comment = {
  repo: "cogni-dao/node-template",
  issueNumber: 341,
  issueUrl: "https://api.github.com/repos/cogni-dao/node-template/issues/341",
  commentId: 4_000_000_001,
  userId: 12345,
  userType: "User",
  login: "an-agent",
  createdAt: "2026-11-11T20:00:00Z",
  updatedAt: "2026-11-11T20:00:00Z",
  lastEditedAt: null,
  proofLines: [
    `cogni-proof:v1:${NODE_ID}:33333333-3333-4333-8333-333333333333:AAAAAAAAAAAAAAAAAAAAAA`,
  ],
};

const found = {
  type: GITHUB_COMMENT_ATTESTATION_V1,
  protocol: GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256,
  iss: "https://cognidao.org",
  aud: `urn:cogni:node:${NODE_ID}`,
  nodeId: NODE_ID,
  requestNonce: NONCE,
  result: "found",
  readAt: 1_700_000_000,
  comment,
  iat: 1_700_000_010,
  exp: 1_700_000_130,
  jti: "44444444-4444-4444-8444-444444444444",
};

describe("github.comment.attestation.v1 frozen contract", () => {
  it("matches the pinned fleet-wide protocol fingerprint", () => {
    expect(GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256).toBe(
      "b23898a6722db468cb3b445aca2d7d2b4941bb98fd42a50e6322839fa3aed50e"
    );
    expect(
      createHash("sha256")
        .update(JSON.stringify(GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL))
        .digest("hex")
    ).toBe(GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256);
  });

  it("accepts a found answer and a not_found answer whose comment is null", () => {
    expect(GithubCommentAttestationClaimsSchema.safeParse(found).success).toBe(
      true
    );
    expect(
      GithubCommentAttestationClaimsSchema.safeParse({
        ...found,
        result: "not_found",
        comment: null,
      }).success
    ).toBe(true);
  });

  it("refuses a result that disagrees with its comment, extra claims, and a foreign audience", () => {
    const parse = (value: object) =>
      GithubCommentAttestationClaimsSchema.safeParse(value).success;
    expect(parse({ ...found, comment: null })).toBe(false);
    expect(parse({ ...found, result: "not_found" })).toBe(false);
    expect(parse({ ...found, verified: true })).toBe(false);
    expect(parse({ ...found, targetOrigin: "https://cognidao.org" })).toBe(
      false
    );
    expect(
      parse({
        ...found,
        aud: "urn:cogni:node:44444444-4444-4444-8444-444444444444",
      })
    ).toBe(false);
    expect(parse({ ...found, exp: found.iat })).toBe(false);
    expect(
      parse({ ...found, comment: { ...comment, lastEditedAt: undefined } })
    ).toBe(false);
    expect(
      parse({
        ...found,
        comment: { ...comment, proofLines: Array(6).fill("x") },
      })
    ).toBe(false);
  });

  it("type separation: each claim schema refuses the other protocol's token body", () => {
    expect(IdentityAttestationClaimsSchema.safeParse(found).success).toBe(
      false
    );
    expect(
      GithubCommentAttestationClaimsSchema.safeParse({
        type: "identity.attestation.v1",
        protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
        iss: "https://cognidao.org",
        aud: `urn:cogni:node:${NODE_ID}`,
        nodeId: NODE_ID,
        nonce: NONCE,
        targetOrigin: "https://node-template.cognidao.org",
        github: { id: "12345", login: null },
        iat: 1_700_000_000,
        exp: 1_700_000_600,
        jti: "33333333-3333-4333-8333-333333333333",
      }).success
    ).toBe(false);
  });

  it("request: exactly nodeId, requestNonce, issue, commentId (a challengeSecret or targetOrigin is refused)", () => {
    const request = {
      nodeId: NODE_ID,
      requestNonce: NONCE,
      issue: "cogni-dao/node-template#341",
      commentId: 4_000_000_001,
    };
    const parse = (value: object) =>
      GithubCommentAttestationRequestSchema.safeParse(value).success;
    expect(parse(request)).toBe(true);
    expect(parse({ ...request, challengeSecret: "x".repeat(43) })).toBe(false);
    expect(parse({ ...request, targetOrigin: "https://cognidao.org" })).toBe(
      false
    );
    expect(parse({ ...request, requestNonce: "short" })).toBe(false);
    expect(parse({ ...request, issue: "cogni-dao/node-template#0" })).toBe(
      false
    );
    expect(parse({ ...request, commentId: 0 })).toBe(false);
    expect(parse({ ...request, commentId: 2 ** 53 })).toBe(false);
    expect(parse({ ...request, commentId: "4000000001" })).toBe(false);
  });
});
