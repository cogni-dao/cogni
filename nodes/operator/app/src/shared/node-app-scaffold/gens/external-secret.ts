// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/external-secret`
 * Purpose: Render the declarative ESO substrate a node-birth PR must add for each runtime env.
 * Scope: Pure YAML renderers for `infra/k8s/secrets/external-secrets/<env>/<slug>/`.
 * Side-effects: none
 * Links: docs/spec/node-ci-cd-contract.md
 * @public
 */

export function renderExternalSecret(slug: string, env: string): string {
  return `# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: node-app-secrets
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
    name: ${slug}-node-app-secrets
    creationPolicy: Owner
    deletionPolicy: Retain
  dataFrom:
    - extract:
        key: ${env}/${slug}
`;
}

export function renderExternalSecretKustomization(): string {
  return `# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - external-secret.yaml
`;
}
