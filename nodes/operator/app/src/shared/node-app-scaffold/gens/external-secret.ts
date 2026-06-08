// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/external-secret`
 * Purpose: Render the per-node ExternalSecret leaf that a minted node repo exposes when mounted
 *   as `nodes/<slug>` in the operator parent repo.
 * Scope: Pure string emitters for the ESO-first node birth footprint. No secret values.
 * Side-effects: none
 * Links: docs/design/node-wizard-secret-setting.md, docs/spec/secrets-management.md
 * @public
 */

import type { NodeBirthEnv } from "./envs";

export function renderNodeExternalSecret(
  slug: string,
  env: NodeBirthEnv
): string {
  return `# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: ${slug}-env-secrets
  namespace: cogni-${env}
  labels:
    app.kubernetes.io/part-of: cogni-secrets-substrate
    app.kubernetes.io/component: ${slug}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-backend
    kind: ClusterSecretStore
  target:
    name: ${slug}-env-secrets
    creationPolicy: Owner
    deletionPolicy: Retain
  dataFrom:
    - extract:
        key: ${env}/${slug}
`;
}

export function renderNodeExternalSecretKustomization(): string {
  return `# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - external-secret.yaml
`;
}
