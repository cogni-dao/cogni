// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Security tests for the authenticated identity attestation broker. */

import { IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256 } from "@cogni/node-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = "33333333-3333-4333-8333-333333333333";
const mockIssue = vi.fn();
const envState = vi.hoisted(() => ({ appBaseUrl: "https://cognidao.org" }));
const MockAttestationPreconditionError = vi.hoisted(
  () =>
    class extends Error {
      constructor(readonly code: string) {
        super(code);
      }
    }
);

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    APP_BASE_URL: envState.appBaseUrl,
    DOMAIN: "cognidao.org",
    IDENTITY_ATTESTATION_PRIVATE_KEY: "seed",
    NODE_SUBMODULE_PARENT_OWNER: "Cogni-DAO",
    NODE_SUBMODULE_PARENT_REPO: "cogni",
    GH_REVIEW_APP_ID: "test-app-id",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64: "test-private-key",
  }),
}));
vi.mock("@/shared/identity/attestation-keys", () => ({
  importAttestationSigningKey: () => ({}),
}));
vi.mock("@/bootstrap/identity-attestation", () => ({
  resolveIdentityAttestationDependencies: () => ({}),
}));
vi.mock("@/features/identity/services/issue-identity-attestation", () => ({
  AttestationPreconditionError: MockAttestationPreconditionError,
  createIdentityAttestationService: () => ({
    issue: (...args: unknown[]) => mockIssue(...args),
  }),
}));

import {
  type AttestationBrokerError,
  issueBrowserIdentityAttestation,
  validateAttestationReturnTo,
} from "@/app/_facades/identity/attestation-broker.server";

const SESSION = {
  id: "11111111-1111-4111-8111-111111111111",
  walletAddress: "0x1111111111111111111111111111111111111111",
  displayName: null,
  avatarColor: null,
};
const REQUEST = {
  protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
  nodeId: NODE_ID,
  nonce: NONCE,
  targetOrigin: "https://node-template.cognidao.org",
};

beforeEach(() => {
  vi.clearAllMocks();
  envState.appBaseUrl = "https://cognidao.org";
  mockIssue.mockResolvedValue({ attestation: "signed.jwt", expiresIn: 600 });
});

describe("validateAttestationReturnTo", () => {
  it("accepts only the exact canonical node profile URL", () => {
    expect(
      validateAttestationReturnTo(
        "https://node-template.cognidao.org/profile",
        "https://node-template.cognidao.org"
      )
    ).toBe("https://node-template.cognidao.org/profile");
  });

  it.each([
    "https://evil.example/profile",
    "https://node-template.cognidao.org.evil.example/profile",
    "https://node-template.cognidao.org/profile?next=https://evil.example",
    "https://node-template.cognidao.org/profile#evil",
    "https://node-template.cognidao.org/other",
    "not-a-url",
  ])("rejects non-canonical return target %s", (returnTo) => {
    expect(
      validateAttestationReturnTo(
        returnTo,
        "https://node-template.cognidao.org"
      )
    ).toBeNull();
  });
});

describe("issueBrowserIdentityAttestation", () => {
  it("passes the same nodeId+nonce to issuance and returns token in fragment", async () => {
    const result = await issueBrowserIdentityAttestation({
      sessionUser: SESSION,
      request: REQUEST,
      returnTo: "https://node-template.cognidao.org/profile",
    });
    expect(mockIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        request: REQUEST,
        userId: SESSION.id,
        fallbackWalletAddress: SESSION.walletAddress,
        issuer: "https://cognidao.org",
        domain: "cognidao.org",
      })
    );
    expect(result.redirectUrl).toBe(
      "https://node-template.cognidao.org/profile#attestation=signed.jwt"
    );
  });

  it("never issues before rejecting an open redirect", async () => {
    await expect(
      issueBrowserIdentityAttestation({
        sessionUser: SESSION,
        request: REQUEST,
        returnTo: "https://evil.example/profile",
      })
    ).rejects.toMatchObject<AttestationBrokerError>({
      code: "invalid_return_to",
    });
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("preserves the exact candidate origin through issuance and redirect", async () => {
    const result = await issueBrowserIdentityAttestation({
      sessionUser: SESSION,
      request: {
        ...REQUEST,
        targetOrigin: "https://toks4-test.cognidao.org",
      },
      returnTo: "https://toks4-test.cognidao.org/profile",
    });

    expect(result.redirectUrl).toBe(
      "https://toks4-test.cognidao.org/profile#attestation=signed.jwt"
    );
    expect(mockIssue).toHaveBeenCalledOnce();
  });

  it("rejects a canonical env origin not registered for that node", async () => {
    mockIssue.mockRejectedValueOnce(
      new MockAttestationPreconditionError("invalid_target_origin")
    );

    await expect(
      issueBrowserIdentityAttestation({
        sessionUser: SESSION,
        request: {
          ...REQUEST,
          targetOrigin: "https://toks4-test.cognidao.org",
        },
        returnTo: "https://toks4-test.cognidao.org/profile",
      })
    ).rejects.toMatchObject<AttestationBrokerError>({
      code: "invalid_return_to",
    });
    expect(mockIssue).toHaveBeenCalledOnce();
  });

  it("rejects when return_to and the signed target origin disagree", async () => {
    await expect(
      issueBrowserIdentityAttestation({
        sessionUser: SESSION,
        request: REQUEST,
        returnTo: "https://node-template-test.cognidao.org/profile",
      })
    ).rejects.toMatchObject<AttestationBrokerError>({
      code: "invalid_return_to",
    });
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("maps an unknown-node issuance rejection", async () => {
    mockIssue.mockRejectedValueOnce(
      new MockAttestationPreconditionError("unknown_node")
    );
    await expect(
      issueBrowserIdentityAttestation({
        sessionUser: SESSION,
        request: REQUEST,
        returnTo: "https://node-template.cognidao.org/profile",
      })
    ).rejects.toMatchObject({ code: "unknown_node" });
    expect(mockIssue).toHaveBeenCalledOnce();
  });

  it("maps missing subject evidence into a broker-safe error", async () => {
    mockIssue.mockRejectedValueOnce(
      new MockAttestationPreconditionError("no_github_binding")
    );
    await expect(
      issueBrowserIdentityAttestation({
        sessionUser: SESSION,
        request: REQUEST,
        returnTo: "https://node-template.cognidao.org/profile",
      })
    ).rejects.toMatchObject({ code: "no_github_binding" });
    expect(mockIssue).toHaveBeenCalledOnce();
  });

  it.each([
    "http://cognidao.org",
    "https://user:pass@cognidao.org",
  ])("fails closed for unsafe configured issuer %s", async (issuer) => {
    envState.appBaseUrl = issuer;
    await expect(
      issueBrowserIdentityAttestation({
        sessionUser: SESSION,
        request: REQUEST,
        returnTo: "https://node-template.cognidao.org/profile",
      })
    ).rejects.toMatchObject({ code: "attestation_unavailable" });
    expect(mockIssue).not.toHaveBeenCalled();
  });
});
