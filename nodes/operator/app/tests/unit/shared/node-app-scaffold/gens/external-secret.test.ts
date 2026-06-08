// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  renderNodeExternalSecret,
  renderNodeExternalSecretKustomization,
} from "@/shared/node-app-scaffold/gens/external-secret";

describe("renderNodeExternalSecret", () => {
  it("renders the candidate-a ESO leaf for a minted node", () => {
    const out = renderNodeExternalSecret("coulditbe", "candidate-a");

    expect(out).toContain("name: coulditbe-env-secrets\n");
    expect(out).toContain("namespace: cogni-candidate-a\n");
    expect(out).toContain("app.kubernetes.io/component: coulditbe\n");
    expect(out).toContain("target:\n    name: coulditbe-env-secrets\n");
    expect(out).toContain("key: candidate-a/coulditbe\n");
    expect(out).not.toContain("coulditbe-node-app-secrets");
  });
});

describe("renderNodeExternalSecretKustomization", () => {
  it("renders a self-contained kustomize leaf", () => {
    expect(renderNodeExternalSecretKustomization()).toBe(
      `# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - external-secret.yaml
`
    );
  });
});
