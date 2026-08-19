// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Unit tests for identity-attestation issuance policy with fake ports. */

import { IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256 } from "@cogni/node-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  AttestationPreconditionError,
  createIdentityAttestationService,
} from "@/features/identity/services/issue-identity-attestation";
import type {
  IdentityAttestationRepositoryPort,
  IdentityAttestationSignerPort,
} from "@/ports";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST = {
  protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
  nodeId: NODE_ID,
  nonce: "node_generated_nonce_0123456789abcdef",
  targetOrigin: "https://toks4-test.cognidao.org",
};

function service(overrides?: {
  repository?: IdentityAttestationRepositoryPort;
  signer?: IdentityAttestationSignerPort;
}) {
  const repository: IdentityAttestationRepositoryPort =
    overrides?.repository ?? {
      findNode: async () => ({
        nodeId: NODE_ID,
        slug: "toks4",
        deployEnvs: ["candidate-a", "production"],
      }),
      findSubject: async () => ({
        walletAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
        github: { id: "12345", login: null },
      }),
    };
  const signer = overrides?.signer ?? { sign: vi.fn(async () => "signed.jwt") };
  return createIdentityAttestationService({
    repository,
    signer,
    clock: { now: () => "2026-08-17T00:00:00.000Z" },
    createJti: () => "33333333-3333-4333-8333-333333333333",
  });
}

describe("identity attestation issuance service", () => {
  it("signs exact registered candidate origin, audience, and subject", async () => {
    const sign = vi.fn(async () => "signed.jwt");
    const issued = await service({ signer: { sign } }).issue({
      userId: "11111111-1111-4111-8111-111111111111",
      fallbackWalletAddress: null,
      issuer: "https://cognidao.org",
      domain: "cognidao.org",
      request: REQUEST,
    });

    expect(issued).toEqual({ attestation: "signed.jwt", expiresIn: 600 });
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
        aud: `urn:cogni:node:${NODE_ID}`,
        targetOrigin: REQUEST.targetOrigin,
        github: { id: "12345", login: null },
      })
    );
  });

  it("rejects an origin outside the registered deployment set before signing", async () => {
    const sign = vi.fn(async () => "signed.jwt");
    await expect(
      service({ signer: { sign } }).issue({
        userId: "11111111-1111-4111-8111-111111111111",
        fallbackWalletAddress: null,
        issuer: "https://cognidao.org",
        domain: "cognidao.org",
        request: { ...REQUEST, targetOrigin: "https://attacker.example" },
      })
    ).rejects.toEqual(
      new AttestationPreconditionError("invalid_target_origin")
    );
    expect(sign).not.toHaveBeenCalled();
  });
});
