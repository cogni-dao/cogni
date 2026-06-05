// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/external-secret`
 * Purpose: Emit the operator-owned ESO leaf files a submodule node needs in the parent repo.
 * Scope: Pure string renderers for `infra/k8s/secrets/external-secrets/<env>/<slug>/`.
 * Invariants: ONE_EXTERNAL_SECRET_PER_SERVICE_ENV, no secret values in git.
 * Side-effects: none
 * Links: docs/spec/secrets-management.md, docs/guides/eso-adoption-migration.md
 * @public
 */

export function renderExternalSecret(slug: string, env: string): string {
  return `# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# ExternalSecret for ${slug}. One service/env path is extracted from OpenBao into the
# single k8s Secret consumed by the workload.
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

export function renderExternalSecretKustomization(): string {
  return `# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - external-secret.yaml
`;
}
