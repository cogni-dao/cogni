// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { buildComputeSecretResources } from "./compute-workload-secret-manifests";

describe("buildComputeSecretResources", () => {
  it("JSON-escapes runtime transport values while preserving raw migration inputs", () => {
    const resources = buildComputeSecretResources({
      slug: "poly",
      environment: "preview",
      secretRefs: [
        { key: "DATABASE_SSL_CA_CERT" },
        { key: "DATABASE_URL" },
        { key: "DOLTGRES_URL" },
      ],
    });
    const runtime = resources.find(
      ({ file }) => file === "compute-env-external-secret.yaml"
    )?.manifest as { spec: { target: { template: unknown } } };
    expect(runtime.spec.target.template).toEqual({
      engineVersion: "v2",
      mergePolicy: "Replace",
      data: {
        DATABASE_SSL_CA_CERT: String.raw`{{ index . "DATABASE_SSL_CA_CERT" | toJson | trimPrefix "\"" | trimSuffix "\"" }}`,
        DATABASE_URL: String.raw`{{ index . "DATABASE_URL" | toJson | trimPrefix "\"" | trimSuffix "\"" }}`,
        DOLTGRES_URL: String.raw`{{ index . "DOLTGRES_URL" | toJson | trimPrefix "\"" | trimSuffix "\"" }}`,
      },
    });
    const migration = resources.find(
      ({ file }) => file === "compute-migration-external-secret.yaml"
    )?.manifest as { spec: { target: object } };
    expect(migration.spec.target).not.toHaveProperty("template");
  });

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
      "compute-migration-external-secret.yaml",
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

  it("emits only private migration URL and CA for a zero-ref app workload", () => {
    const resources = buildComputeSecretResources({
      slug: "echo",
      environment: "candidate-a",
      secretRefs: [],
    });
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      file: "compute-migration-external-secret.yaml",
      manifest: {
        metadata: { name: "echo-compute-migration-secrets" },
        spec: {
          data: [
            {
              secretKey: "DATABASE_MIGRATION_URL",
              remoteRef: {
                key: "candidate-a/echo-database-migration",
                property: "DATABASE_MIGRATION_URL",
              },
            },
            {
              secretKey: "DATABASE_SSL_CA_CERT",
              remoteRef: {
                key: "candidate-a/echo-database-migration",
                property: "DATABASE_SSL_CA_CERT",
              },
            },
          ],
        },
      },
    });
  });

  it.each([
    "candidate-a",
    "preview",
    "production",
  ] as const)("projects only declared Doltgres beside the isolated PG migration bank in %s", (environment) => {
    const resources = buildComputeSecretResources({
      slug: "echo",
      environment,
      secretRefs: [
        { key: "DATABASE_URL" },
        { key: "DATABASE_SERVICE_URL" },
        { key: "DOLTGRES_URL" },
        { key: "DOLTGRES_URL" },
        { key: "AUTH_SECRET" },
      ],
    });
    const migration = resources.find(
      ({ file }) => file === "compute-migration-external-secret.yaml"
    )?.manifest as { metadata: unknown; spec: { data: unknown } };
    expect(migration.metadata).toEqual({
      name: "echo-compute-migration-secrets",
      namespace: `cogni-${environment}`,
    });
    expect(migration.spec.data).toEqual([
      {
        secretKey: "DATABASE_MIGRATION_URL",
        remoteRef: {
          key: `${environment}/echo-database-migration`,
          property: "DATABASE_MIGRATION_URL",
        },
      },
      {
        secretKey: "DATABASE_SSL_CA_CERT",
        remoteRef: {
          key: `${environment}/echo-database-migration`,
          property: "DATABASE_SSL_CA_CERT",
        },
      },
      {
        secretKey: "DOLTGRES_URL",
        remoteRef: {
          key: `${environment}/echo`,
          property: "DOLTGRES_URL",
        },
      },
    ]);
    expect(migration.spec).not.toHaveProperty("dataFrom");
    const runtime = resources[0]?.manifest as {
      spec: { data: { secretKey: string }[] };
    };
    expect(runtime.spec.data.map(({ secretKey }) => secretKey)).toEqual([
      "AUTH_SECRET",
      "DATABASE_SERVICE_URL",
      "DATABASE_URL",
      "DOLTGRES_URL",
    ]);
  });

  it.each([
    { secretRefs: [] },
    { secretRefs: [{ key: "DATABASE_URL" }] },
  ])("does not project an undeclared Doltgres URL for refs $secretRefs", ({
    secretRefs,
  }) => {
    const resources = buildComputeSecretResources({
      slug: "echo",
      environment: "preview",
      secretRefs,
    });
    const migration = resources.find(
      ({ file }) => file === "compute-migration-external-secret.yaml"
    )?.manifest as { spec: { data: unknown } };
    expect(migration.spec.data).toEqual([
      {
        secretKey: "DATABASE_MIGRATION_URL",
        remoteRef: {
          key: "preview/echo-database-migration",
          property: "DATABASE_MIGRATION_URL",
        },
      },
      {
        secretKey: "DATABASE_SSL_CA_CERT",
        remoteRef: {
          key: "preview/echo-database-migration",
          property: "DATABASE_SSL_CA_CERT",
        },
      },
    ]);
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

describe("reusable preview pair projections", () => {
  it("separates A/B projection names while retaining the exact original secret banks", () => {
    const resources = ([0, 1] as const).map((previewStateSlot) =>
      buildComputeSecretResources({
        slug: "spawny-boi",
        environment: "candidate-a",
        previewStateSlot,
        secretRefs: [
          { key: "DATABASE_URL" },
          { key: "DATABASE_SERVICE_URL" },
          { key: "DOLTGRES_URL" },
        ],
      })
    );
    const [a, b] = resources.map(
      (items) =>
        items.find((item) => item.file === "compute-env-external-secret.yaml")
          ?.manifest as {
          metadata: { name: string };
          spec: {
            data: { remoteRef: { key: string } }[];
            target: { template: { data: Record<string, string> } };
          };
        }
    );
    expect(a?.metadata.name).toBe("spawny-boi-preview-a-compute-env-secrets");
    expect(b?.metadata.name).toBe("spawny-boi-preview-b-compute-env-secrets");
    expect(a?.spec.data).toEqual(b?.spec.data);
    expect(
      a?.spec.data.every((d) => d.remoteRef.key === "candidate-a/spawny-boi")
    ).toBe(true);
    expect(a?.spec.target.template.data.DATABASE_URL).toContain(
      `/cogni_spawny_boi_preview_a\${1}`
    );
    expect(b?.spec.target.template.data.DOLTGRES_URL).toContain(
      `/knowledge_spawny_boi_preview_b\${1}`
    );
    expect(a?.spec.target.template.data.DATABASE_URL).toContain(
      'template "preview_database_binding_mismatch"'
    );
    expect(a?.spec.target.template.data.DATABASE_URL).toContain("toJson");
    const migration = resources[0]?.find(
      (item) => item.file === "compute-migration-external-secret.yaml"
    )?.manifest as {
      spec: {
        data: { remoteRef: { key: string } }[];
        target: { template: { data: Record<string, string> } };
      };
    };
    expect(migration.spec.data[0]?.remoteRef.key).toBe(
      "candidate-a/spawny-boi-database-migration"
    );
    expect(migration.spec.data[1]?.remoteRef.key).toBe(
      "candidate-a/spawny-boi"
    );
    expect(
      migration.spec.target.template.data.DATABASE_MIGRATION_URL
    ).not.toContain("toJson");
    expect(
      migration.spec.target.template.data.DATABASE_MIGRATION_URL
    ).toContain(`/cogni_spawny_boi_preview_a\${1}`);
  });
  it("refuses pair projection outside the existing allowlisted TEST fixture", () => {
    expect(() =>
      buildComputeSecretResources({
        slug: "operator",
        environment: "candidate-a",
        secretRefs: [],
        previewStateSlot: 0,
      })
    ).toThrow(/allowlisted/);
    expect(() =>
      buildComputeSecretResources({
        slug: "spawny-boi",
        environment: "production",
        secretRefs: [],
        previewStateSlot: 0,
      })
    ).toThrow(/allowlisted/);
  });
});
