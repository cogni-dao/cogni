// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import { renderOverlay } from "@/shared/node-app-scaffold/gens/overlay";

const TEMPLATE = `namePrefix: node-template-
patches:
  - target:
      kind: Deployment
      name: node-app
    patch: |
      - op: replace
        path: /spec/template/spec/containers/0/envFrom/1/secretRef/name
        value: "node-template-node-app-secrets"
      - op: replace
        path: /spec/template/spec/initContainers/0/envFrom/1/secretRef/name
        value: "node-template-node-app-secrets"
      - op: replace
        path: /spec/template/spec/containers/0/ports/0/containerPort
        value: 3200
      - op: add
        path: /spec/template/spec/initContainers/-
        value:
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: node-template-node-app-secrets
                  key: DOLTGRES_URL
  - target:
      kind: Service
      name: node-app
    patch: |
      - op: add
        path: /spec/ports/0/nodePort
        value: 30200
      - op: replace
        path: /spec/ports/0/targetPort
        value: 3200
`;

describe("renderOverlay", () => {
  it("keeps legacy secret refs unless a target secret is supplied", () => {
    const out = renderOverlay(TEMPLATE, "coulditbe", 30500, 3500);

    expect(out).toContain('value: "coulditbe-node-app-secrets"');
    expect(out).toContain("value: 30500");
    expect(out).toContain("value: 3500");
  });

  it("rewrites all node-app secret refs to the ESO target when supplied", () => {
    const out = renderOverlay(TEMPLATE, "coulditbe", 30500, 3500, {
      secretTargetName: "coulditbe-env-secrets",
    });

    expect(out).toContain('value: "coulditbe-env-secrets"');
    expect(out).toContain("name: coulditbe-env-secrets");
    expect(out).not.toContain("coulditbe-node-app-secrets");
  });
});
