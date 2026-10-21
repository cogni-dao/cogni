// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { isOffClusterWorkloadSecretKey } from "@/shared/secrets/node-secrets-reserved.data";

export interface ComputeSecretResource {
  readonly file: string;
  readonly manifest: object;
}

/** Build value-free, least-privilege secret projection resources for one workload. */
export function buildComputeSecretResources(input: {
  readonly slug: string;
  readonly environment: "candidate-a" | "preview" | "production";
  readonly secretRefs: readonly { readonly key: string }[];
  /** Two reusable disposable contents; source bank/roles/passwords are unchanged. */
  readonly previewStateSlot?: 0 | 1;
}): readonly ComputeSecretResource[] {
  const preview = input.previewStateSlot !== undefined;
  if (
    preview &&
    (input.environment !== "candidate-a" ||
      input.slug !== "spawny-boi" ||
      (input.previewStateSlot !== 0 && input.previewStateSlot !== 1))
  ) {
    throw new Error(
      "[compute-workload-secret-manifests] preview pair is not allowlisted"
    );
  }
  const projectionSlug = preview
    ? `${input.slug}-preview-${input.previewStateSlot === 0 ? "a" : "b"}`
    : input.slug;
  function templateValue(key: string, escaped: boolean): string {
    let expression = `index . "${key}"`;
    let guard = "";
    if (
      preview &&
      [
        "DATABASE_URL",
        "DATABASE_SERVICE_URL",
        "DATABASE_MIGRATION_URL",
        "DOLTGRES_URL",
      ].includes(key)
    ) {
      const base =
        key === "DOLTGRES_URL" ? "knowledge_spawny_boi" : "cogni_spawny_boi";
      const pattern = `/${base}([?].*)?$`;
      // ESO omits Sprig's fail(). An undefined native template aborts this bad-binding
      // branch without ever projecting a URL that could still reach canonical contents.
      guard = `{{ if not (regexMatch "${pattern}" (${expression})) }}{{ template "preview_database_binding_mismatch" . }}{{ end }}`;
      expression = `regexReplaceAll "${pattern}" (${expression}) "/${base}_preview_${input.previewStateSlot === 0 ? "a" : "b"}\${1}"`;
    }
    return `${guard}{{ ${expression}${escaped ? String.raw` | toJson | trimPrefix "\"" | trimSuffix "\""` : ""} }}`;
  }
  const secretKeys = [
    ...new Set(input.secretRefs.map((ref) => ref.key)),
  ].sort();
  const rejected = secretKeys.filter(
    (key) => !isOffClusterWorkloadSecretKey(key)
  );
  if (rejected.length > 0) {
    throw new Error(
      `[compute-workload-secret-manifests] off-cluster workload secret refs rejected: ${rejected.join(",")}`
    );
  }
  const namespace = `cogni-${input.environment}`;
  const secretName = `${projectionSlug}-compute-env-secrets`;
  const accessName = `${projectionSlug}-compute-env-secrets-reader`;
  const runtimeResources: ComputeSecretResource[] =
    secretKeys.length === 0
      ? []
      : [
          {
            file: "compute-env-external-secret.yaml",
            manifest: {
              apiVersion: "external-secrets.io/v1",
              kind: "ExternalSecret",
              metadata: { name: secretName, namespace },
              spec: {
                refreshInterval: "1h",
                secretStoreRef: {
                  name: "openbao-backend",
                  kind: "ClusterSecretStore",
                },
                target: {
                  name: secretName,
                  creationPolicy: "Owner",
                  deletionPolicy: "Delete",
                  // provider-http substitutes these inside serialized JSON strings.
                  // Migration Jobs consume a separate, unescaped Secret below.
                  template: {
                    engineVersion: "v2",
                    mergePolicy: "Replace",
                    data: Object.fromEntries(
                      secretKeys.map((key) => [key, templateValue(key, true)])
                    ),
                  },
                },
                data: secretKeys.map((key) => ({
                  secretKey: key,
                  remoteRef: {
                    key: `${input.environment}/${input.slug}`,
                    property: key,
                  },
                })),
              },
            },
          },
          {
            file: "compute-env-secret-role.yaml",
            manifest: {
              apiVersion: "rbac.authorization.k8s.io/v1",
              kind: "Role",
              metadata: { name: accessName, namespace },
              rules: [
                {
                  apiGroups: [""],
                  resources: ["secrets"],
                  resourceNames: [secretName],
                  verbs: ["get"],
                },
              ],
            },
          },
          {
            file: "compute-env-secret-role-binding.yaml",
            manifest: {
              apiVersion: "rbac.authorization.k8s.io/v1",
              kind: "RoleBinding",
              metadata: { name: accessName, namespace },
              subjects: [
                {
                  kind: "ServiceAccount",
                  name: "operator-compute-workload-controller",
                  namespace,
                },
              ],
              roleRef: {
                apiGroup: "rbac.authorization.k8s.io",
                kind: "Role",
                name: accessName,
              },
            },
          },
        ];
  const migrationSecretName = `${projectionSlug}-compute-migration-secrets`;
  return [
    ...runtimeResources,
    {
      file: "compute-migration-external-secret.yaml",
      manifest: {
        apiVersion: "external-secrets.io/v1",
        kind: "ExternalSecret",
        metadata: { name: migrationSecretName, namespace },
        spec: {
          refreshInterval: "1h",
          secretStoreRef: {
            name: "openbao-backend",
            kind: "ClusterSecretStore",
          },
          target: {
            name: migrationSecretName,
            creationPolicy: "Owner",
            deletionPolicy: "Delete",
            ...(preview
              ? {
                  template: {
                    engineVersion: "v2",
                    mergePolicy: "Replace",
                    data: {
                      DATABASE_MIGRATION_URL: templateValue(
                        "DATABASE_MIGRATION_URL",
                        false
                      ),
                      DATABASE_SSL_CA_CERT: templateValue(
                        "DATABASE_SSL_CA_CERT",
                        false
                      ),
                      ...(secretKeys.includes("DOLTGRES_URL")
                        ? { DOLTGRES_URL: templateValue("DOLTGRES_URL", false) }
                        : {}),
                    },
                  },
                }
              : {}),
          },
          data: [
            {
              secretKey: "DATABASE_MIGRATION_URL",
              remoteRef: {
                key: `${input.environment}/${input.slug}-database-migration`,
                property: "DATABASE_MIGRATION_URL",
              },
            },
            {
              secretKey: "DATABASE_SSL_CA_CERT",
              remoteRef: {
                // The existing TEST migration bank projects only its isolated DSN.
                // Reuse the proven runtime bank's public CA for the opt-in pair.
                key: preview
                  ? `${input.environment}/${input.slug}`
                  : `${input.environment}/${input.slug}-database-migration`,
                property: "DATABASE_SSL_CA_CERT",
              },
            },
            ...(secretKeys.includes("DOLTGRES_URL")
              ? [
                  {
                    secretKey: "DOLTGRES_URL",
                    remoteRef: {
                      key: `${input.environment}/${input.slug}`,
                      property: "DOLTGRES_URL",
                    },
                  },
                ]
              : []),
          ],
        },
      },
    },
  ];
}
