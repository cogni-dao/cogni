// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { buildComputeSecretResources } from "./compute-workload-secret-manifests";

describe("buildComputeSecretResources", () => {
  it("renders only the declared union with exact get-only RBAC", () => {
    const resources = buildComputeSecretResources({
      slug: "toks4",
      environment: "candidate-a",
      secretRefs: [
        { key: "DATABASE_URL" },
        { key: "LITELLM_VIRTUAL_KEY" },
        { key: "DATABASE_URL" },
      ],
    }).map(({ file, manifest }) => ({
      file,
      manifest: parse(stringify(manifest)) as Record<string, unknown>,
    }));

    expect(resources.map(({ file }) => file)).toEqual([
      "compute-env-external-secret.yaml",
      "compute-env-secret-role.yaml",
      "compute-env-secret-role-binding.yaml",
    ]);
    const [externalSecretResource, roleResource, bindingResource] = resources;
    if (!externalSecretResource || !roleResource || !bindingResource) {
      throw new Error("expected all compute secret resources");
    }
    const externalSecret = externalSecretResource.manifest as {
      spec: { data: unknown; [key: string]: unknown };
    };
    expect(externalSecret.spec.data).toEqual([
      {
        secretKey: "DATABASE_URL",
        remoteRef: {
          key: "candidate-a/toks4",
          property: "DATABASE_URL",
        },
      },
      {
        secretKey: "LITELLM_VIRTUAL_KEY",
        remoteRef: {
          key: "candidate-a/toks4",
          property: "LITELLM_VIRTUAL_KEY",
        },
      },
    ]);
    expect(externalSecret.spec).not.toHaveProperty("dataFrom");
    expect(stringify(externalSecret)).not.toContain("LITELLM_MASTER_KEY");

    const role = roleResource.manifest as { rules: unknown };
    expect(role.rules).toEqual([
      {
        apiGroups: [""],
        resources: ["secrets"],
        resourceNames: ["toks4-compute-env-secrets"],
        verbs: ["get"],
      },
    ]);
    const binding = bindingResource.manifest as { subjects: unknown };
    expect(binding.subjects).toEqual([
      {
        kind: "ServiceAccount",
        name: "operator-compute-workload-controller",
        namespace: "cogni-candidate-a",
      },
    ]);
  });

  it("emits no projection for a zero-ref workload", () => {
    expect(
      buildComputeSecretResources({
        slug: "echo",
        environment: "candidate-a",
        secretRefs: [],
      })
    ).toEqual([]);
  });

  it.each([
    "LITELLM_MASTER_KEY",
    "AKASH_CONSOLE_API_KEY",
    "AKASH_ACTUATOR_CONSOLE_API_KEY",
    "IDENTITY_ATTESTATION_PRIVATE_KEY",
    "APP_DB_PASSWORD",
    "GHCR_DEPLOY_TOKEN",
    // Fleet-shared, not node-owned: one DoltHub credential for the whole fleet.
    "DOLTHUB_API_TOKEN",
    "DOLT_CREDS_JWK",
  ])("rejects operator/fleet-owned ref %s before render", (key) => {
    expect(() =>
      buildComputeSecretResources({
        slug: "toks4",
        environment: "candidate-a",
        secretRefs: [{ key }],
      })
    ).toThrow("secret refs rejected");
  });

  it("projects node-owned custody refs (bug.5093 — poly can reach Akash)", () => {
    // These were name-listed as denied, so this call used to THROW and poly
    // could never render an external workload at all. They are node-scoped
    // values at cogni/<env>/<node>/<KEY>; the node's namespace is the authority.
    const nodeOwned = [
      "POLY_WALLET_AEAD_KEY_HEX",
      "POLY_WALLET_AEAD_KEY_ID",
      "PRIVY_APP_SECRET",
      "PRIVY_SIGNING_KEY",
      "DISCORD_BOT_TOKEN",
    ];
    const resources = buildComputeSecretResources({
      slug: "poly",
      environment: "production",
      secretRefs: nodeOwned.map((key) => ({ key })),
    });
    const externalSecret = resources[0]?.manifest as {
      spec: { data: { secretKey: string; remoteRef: { key: string } }[] };
    };
    expect(externalSecret.spec.data.map((entry) => entry.secretKey)).toEqual(
      [...nodeOwned].sort()
    );
    // Least-privilege still holds: every ref is read from the NODE's own path.
    for (const entry of externalSecret.spec.data) {
      expect(entry.remoteRef.key).toBe("production/poly");
    }
  });

  it("projects a novel node-owned key — the node's OpenBao namespace is the authority, not a code allowlist", () => {
    const resources = buildComputeSecretResources({
      slug: "toks4",
      environment: "candidate-a",
      secretRefs: [{ key: "SOME_BRAND_NEW_VENDOR_KEY" }],
    });
    expect(resources.map((r) => r.file)).toContain(
      "compute-env-external-secret.yaml"
    );
  });
});
