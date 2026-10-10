// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySecret = vi.fn();
const resolveNodeRef = vi.fn();

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = `cogni_naz_sk_v1_${NODE_ID}_${"a".repeat(64)}`;

vi.mock("@/bootstrap/capabilities/operator-secrets-plane", () => ({
  createOperatorSecretsPlane: () => ({ verifySecret }),
}));
vi.mock("@/bootstrap/container", () => ({
  resolveServiceDb: () => ({ kind: "service-db" }),
}));
vi.mock("@/features/nodes/node-lookup", () => ({ resolveNodeRef }));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    DEPLOY_ENVIRONMENT: "production",
    OPENBAO_NODE_SECRETS_WRITER_ROLE: "production-node-secrets-writer",
  }),
}));

describe("authenticateAuthorizationFacadeRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveNodeRef.mockResolvedValue({
      nodeId: NODE_ID,
      slug: "poly",
      deployEnvs: ["production"],
      activityEnv: "production",
    });
    verifySecret.mockResolvedValue(true);
  });

  it("derives the node from the credential and verifies only that node/env path", async () => {
    const { authenticateAuthorizationFacadeRequest } = await import(
      "./authorization-facade-auth"
    );
    await expect(
      authenticateAuthorizationFacadeRequest(
        new Request("https://operator.example/api/v1/authorization/check", {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      )
    ).resolves.toMatchObject({ ok: true, node: { nodeId: NODE_ID } });
    expect(resolveNodeRef).toHaveBeenCalledWith(
      { kind: "service-db" },
      NODE_ID
    );
    expect(verifySecret).toHaveBeenCalledWith({
      nodeSlug: "poly",
      env: "production",
      key: "AUTHORIZATION_FACADE_TOKEN",
      presentedValue: TOKEN,
    });
  });

  it("fails closed for malformed, unknown, or mismatched node credentials", async () => {
    const { authenticateAuthorizationFacadeRequest } = await import(
      "./authorization-facade-auth"
    );
    await expect(
      authenticateAuthorizationFacadeRequest(
        new Request("https://operator.example", {
          headers: { authorization: "Bearer malformed" },
        })
      )
    ).resolves.toMatchObject({ status: 401 });

    resolveNodeRef.mockResolvedValueOnce(null);
    await expect(
      authenticateAuthorizationFacadeRequest(
        new Request("https://operator.example", {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      )
    ).resolves.toMatchObject({ status: 401 });

    verifySecret.mockResolvedValueOnce(false);
    await expect(
      authenticateAuthorizationFacadeRequest(
        new Request("https://operator.example", {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      )
    ).resolves.toMatchObject({ status: 401 });
  });
});
