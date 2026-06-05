// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  renderExternalSecret,
  renderExternalSecretKustomization,
} from "./external-secret";

describe("renderExternalSecret", () => {
  it("renders the operator-owned ESO leaf for one node/env path", () => {
    expect(
      renderExternalSecret("acme", "preview")
    ).toBe(`# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# ExternalSecret for acme. One service/env path is extracted from OpenBao into the
# single k8s Secret consumed by the workload.
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: acme-env-secrets
  namespace: cogni-preview
  labels:
    app.kubernetes.io/part-of: cogni-secrets-substrate
    app.kubernetes.io/component: acme
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-backend
    kind: ClusterSecretStore
  target:
    name: acme-env-secrets
    creationPolicy: Owner
    deletionPolicy: Retain
  dataFrom:
    - extract:
        key: preview/acme
`);
  });
});

describe("renderExternalSecretKustomization", () => {
  it("renders the leaf kustomization", () => {
    expect(
      renderExternalSecretKustomization()
    ).toBe(`# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - external-secret.yaml
`);
  });
});
