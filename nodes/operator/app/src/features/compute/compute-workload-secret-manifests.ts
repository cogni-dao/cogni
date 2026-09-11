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
}): readonly ComputeSecretResource[] {
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
  if (secretKeys.length === 0) return [];

  const namespace = `cogni-${input.environment}`;
  const secretName = `${input.slug}-compute-env-secrets`;
  const accessName = `${input.slug}-compute-env-secrets-reader`;
  return [
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
}
