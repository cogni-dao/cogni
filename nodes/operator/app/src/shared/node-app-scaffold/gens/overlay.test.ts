// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/overlay.test`
 * Purpose: Pin node-birth overlay rendering, including the formation PR's ESO leaf reference.
 * Scope: Pure renderer tests; does not read files or invoke kustomize.
 * Side-effects: none
 * Links: overlay.ts, docs/spec/node-ci-cd-contract.md
 * @internal
 */

import { describe, expect, it } from "vitest";
import { renderOverlay } from "./overlay";

const TEMPLATE = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: cogni-candidate-a

resources:
  - ../../../base/node-app

namePrefix: node-template-

patches:
  - target:
      kind: Deployment
      name: node-app
    patch: |
      - op: replace
        path: /spec/template/spec/containers/0/envFrom/1/secretRef/name
        value: "node-template-node-app-secrets"
      - op: add
        path: /spec/ports/0/nodePort
        value: 30200
      - op: replace
        path: /spec/template/spec/containers/0/ports/0/containerPort
        value: 3200
`;

describe("renderOverlay", () => {
  it("clones the template overlay and includes the node ExternalSecret leaf", () => {
    const rendered = renderOverlay(
      TEMPLATE,
      "creative",
      30310,
      3310,
      "candidate-a"
    );

    expect(rendered).toContain("namePrefix: creative-");
    expect(rendered).toContain("value: 30310");
    expect(rendered).toContain("value: 3310");
    expect(rendered).toContain('value: "creative-node-app-secrets"');
    expect(rendered).toContain(
      "  - ../../../secrets/external-secrets/candidate-a/creative"
    );
  });
});
