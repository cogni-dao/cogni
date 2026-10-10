// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EnvAuthorizationFacadeCredentialVerifierAdapter } from "./env-authorization-facade-credential-verifier.adapter";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVE = `cogni_naz_sk_v2_candidate-a_${NODE_ID}_${"a".repeat(64)}`;
const PREVIOUS = `cogni_naz_sk_v2_candidate-a_${NODE_ID}_${"b".repeat(64)}`;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("EnvAuthorizationFacadeCredentialVerifierAdapter", () => {
  it("accepts only active/previous digests at the exact lane and node key", async () => {
    const adapter = new EnvAuthorizationFacadeCredentialVerifierAdapter(
      JSON.stringify({
        [`candidate-a/${NODE_ID}`]: {
          activeSha256: digest(ACTIVE),
          previousSha256: digest(PREVIOUS),
        },
      })
    );

    await expect(
      adapter.verify({
        lane: "candidate-a",
        nodeId: NODE_ID,
        presentedCredential: ACTIVE,
      })
    ).resolves.toEqual({ decision: "valid" });
    await expect(
      adapter.verify({
        lane: "candidate-a",
        nodeId: NODE_ID,
        presentedCredential: PREVIOUS,
      })
    ).resolves.toEqual({ decision: "valid" });
    await expect(
      adapter.verify({
        lane: "preview",
        nodeId: NODE_ID,
        presentedCredential: ACTIVE,
      })
    ).resolves.toEqual({ decision: "invalid" });
  });

  it("rejects malformed or authority-bearing projections", () => {
    expect(
      () => new EnvAuthorizationFacadeCredentialVerifierAdapter("not-json")
    ).toThrow("verifier map is invalid");
    expect(
      () =>
        new EnvAuthorizationFacadeCredentialVerifierAdapter(
          JSON.stringify({
            [`candidate-a/${NODE_ID}`]: {
              activeSha256: digest(ACTIVE),
              previousSha256: null,
              active: ACTIVE,
            },
          })
        )
    ).toThrow("verifier map is invalid");
  });
});
